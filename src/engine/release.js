// The release engine: every step of a release, whatever asked for it.
//
// The terminal, the Slack bot and plain-language requests all call these, so
// a release behaves the same wherever it's run. Each action re-reads the
// release from GitHub first and skips what's already done: a merged PR is not
// merged again, an existing tag is not created again, and a second approval is
// refused. Nothing here branches on a project's name; the flow file's steps
// and adapters decide what happens.
//
// `env` is `{ project, gh, tracker, store, slack?, appClient?, now?, sleep? }`.
// `appClient` returns a client acting as the app itself, where this copy holds
// its key; it's only used when GitHub refuses a person's own token.

import * as g from "./github.js";
import { nextTag, latestTag } from "./tags.js";
import { atStatus } from "../trackers/index.js";
import { actorId, actorText, isReleaseManager, githubMentions } from "./people.js";
import { IN_FLIGHT } from "./store.js";

export const APPROVAL_MS = 24 * 60 * 60 * 1000;

export class ReleaseError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ReleaseError";
    Object.assign(this, details);
  }
}

const has = (env, step) => env.project.steps.includes(step);
const now = (env) => (env.now ? env.now() : Date.now());
const iso = (env) => new Date(now(env)).toISOString();
const slim = (item) => ({ id: item.id, ref: item.ref, number: item.number, title: item.title, url: item.url });

/** The branch PRs merge into: the tag branch (default: the repo's default) or the release branch's `from`. */
export async function releaseBranch(env) {
  const { release } = env.project;
  if (release.type === "release-branch") return release.from;
  return release.branch ?? (await g.getRepo(env.gh, env.project.repo)).default_branch;
}

// Work can join a release until its approval is asked for. After that, a
// release manager is looking at a fixed list and commit.
const ADDABLE = new Set(["open", "in_regression", "on_hold"]);

/** Whether `record` still takes new work, or a new release should be opened instead. */
export const canAddTo = (record) => ADDABLE.has(record.state.status);

/**
 * Issues in `record` whose PRs haven't all merged: a merge failed, or no PR
 * was linked when AKO looked. Opening the release again retries them.
 */
export function unmerged(record) {
  const { items, merges } = record.state;
  return items.filter((item) => {
    const mine = merges.filter((m) => m.item === item.ref);
    return !mine.length || mine.some((m) => m.result === "failed");
  });
}

/**
 * Work that is ready and not already in a release still being worked on.
 * `current` is the release new work joins, and `waiting` one waiting for
 * approval, which keeps its tested commit while new work goes in a new release.
 */
export async function readyWork(env) {
  const inFlight = await env.store.inFlight();
  const exclude = new Set(inFlight.flatMap((r) => r.state.items.map((i) => i.id)));
  const items = await env.tracker.readyItems({ exclude });
  return {
    items: items.filter((i) => !exclude.has(i.id)),
    current: inFlight.find(canAddTo) ?? null,
    waiting: inFlight.find((r) => !canAddTo(r)) ?? null,
  };
}

/**
 * Adds `items` to the project's open release, so a cycle has one release, or
 * opens one when there's none to add to. `newRelease` opens one anyway. Then
 * merges their PRs when the flow has a `merge_prs` step, retrying the open
 * release's PRs that didn't merge before (`retried`), so `items` may be empty
 * to retry those alone. A new release opened while another waits for
 * approval returns that one as `waiting`.
 */
export async function openRelease(env, { items, actor, newRelease = false }) {
  const { project, gh, store, tracker } = env;
  const inFlight = await store.inFlight();
  const current = newRelease ? null : inFlight.find(canAddTo);
  const retried = current && has(env, "merge_prs") ? unmerged(current) : [];
  if (!items.length && !retried.length) throw new ReleaseError("Pick at least one issue for the release.");

  if (current) {
    const added = items.filter((i) => !current.state.items.some((x) => x.id === i.id));
    if (added.length) {
      await tracker.addItems(current.state.trackerRelease, added);
      current.state.items.push(...added.map(slim));
      await store.save(current);
    }
    const merges = has(env, "merge_prs") ? await mergePulls(env, current, { items: [...added, ...retried], actor, retried }) : null;
    // A retried merge that lands changes the branch just as added work does.
    const landed = retried.filter((i) => merges.results.some((r) => r.item === i.ref && r.result === "merged"));
    const retested = Boolean(current.state.testedSha && (added.length || landed.length));
    if (retested) await retest(env, current, { added, landed });
    return { record: current, reused: true, added, retried, merges, retested };
  }

  const taken = [
    ...(await g.listTags(gh, project.repo)),
    ...(await g.listMilestones(gh, project.repo)).map((m) => m.title),
    ...(await store.list()).map((r) => r.state.tag),
  ];
  const tag = nextTag(project.release.tag_prefix, taken, now(env));
  const trackerRelease = await tracker.openRelease(tag, items);
  const record = await store.create({
    version: 1,
    project: project.key,
    tag,
    status: "open",
    openedBy: actorId(actor),
    openedAt: iso(env),
    trackerRelease,
    items: items.map(slim),
    merges: [],
    testedSha: null,
    approval: null,
    decision: null,
    published: null,
    deploy: null,
    slack: null,
  });

  const merges = has(env, "merge_prs") ? await mergePulls(env, record, { items, actor }) : null;
  // With no regression step, what's on the branch now is what ships, and
  // nobody would move the work to "ready for release" by hand.
  if (!has(env, "announce_regression")) await markTested(env, record, { moveToReady: true });
  return { record, reused: false, added: items, merges, waiting: inFlight.find((r) => !canAddTo(r)) ?? null };
}

/**
 * Merges each item's open PRs into the release branch, then moves fully
 * merged items to `staged`. Items in `retried` have been in the release a
 * while, so they're only moved from a ready status: QA may have passed one
 * since its PR was merged by hand, and it must not be sent back.
 */
export async function mergePulls(env, record, { items = record.state.items, actor, retried = [] }) {
  const { project, gh, store, tracker } = env;
  if (!items.length) return { results: [], staged: [], stageFailed: [], withoutPrs: [] };
  const branch = await releaseBranch(env);
  const method = project.release.merge_method ?? "squash";

  return store.withLock(record, actorId(actor), async () => {
    const results = [];
    const merged = [];
    const withoutPrs = [];
    for (const item of items) {
      const prs = await tracker.pullRequests(item);
      if (!prs.length) withoutPrs.push(item.ref);
      let open = 0;
      let landed = 0;
      for (const pr of prs) {
        const base = { item: item.ref, pr: pr.number, url: pr.url };
        if (pr.state === "merged") {
          results.push({ ...base, result: "already" });
          landed += 1;
        } else if (pr.state === "closed") {
          results.push({ ...base, result: "skipped", reason: "closed without merging" });
        } else if (pr.draft) {
          open += 1;
          results.push({ ...base, result: "failed", reason: "still a draft" });
        } else if (pr.base !== branch) {
          open += 1;
          results.push({ ...base, result: "failed", reason: `targets ${pr.base}, not ${branch}` });
        } else {
          const outcome = await g.mergePull(gh, pr.repo, pr.number, method);
          if (outcome.merged) {
            landed += 1;
            results.push({ ...base, result: "merged" });
          } else {
            open += 1;
            results.push({ ...base, result: "failed", reason: outcome.reason });
          }
        }
      }
      if (landed && !open) merged.push(item);
    }

    const staged = project.tracker.statuses.staged;
    const toStage = staged ? await stillReady(env, merged, retried) : [];
    const moved = toStage.length ? await tracker.moveItems(toStage, staged) : { moved: 0, failed: [] };
    record.state.merges = [...record.state.merges.filter((m) => !results.some((r) => r.pr === m.pr)), ...results];
    await store.save(record);
    return { results, staged: toStage.map((i) => i.ref), stageFailed: moved.failed, withoutPrs };
  });
}

/** `merged`, less the `retried` items that have moved on from a ready status. */
async function stillReady(env, merged, retried) {
  const again = merged.filter((item) => retried.some((r) => r.id === item.id));
  if (!again.length) return merged;
  const config = env.project.tracker;
  const current = await env.tracker.itemStatuses(again);
  return merged.filter((item) => !again.includes(item) || config.statuses.ready.some((status) => atStatus(config, current.get(item.id), status)));
}

/** Records the commit QA is testing: what the release branch points at now. */
async function markTested(env, record, { moveToReady = false } = {}) {
  record.state.testedSha = await g.branchHead(env.gh, env.project.repo, await releaseBranch(env));
  record.state.testedAt = iso(env);
  if (moveToReady && env.project.tracker.statuses.ready_for_release) {
    await env.tracker.moveItems(record.state.items, env.project.tracker.statuses.ready_for_release);
  }
  await env.store.save(record);
}

/**
 * Work was added or merged after the tested commit, so that commit no longer
 * holds the whole release, and tagging it would leave the new work out. With
 * a regression step, QA starts again on a newer commit; without one, the
 * branch as it is now is what ships.
 */
async function retest(env, record, { added, landed }) {
  const { state } = record;
  state.approval = null;
  state.decision = null;
  if (!has(env, "announce_regression")) {
    await markTested(env, record, { moveToReady: true });
    return;
  }
  state.testedSha = null;
  state.testedAt = null;
  state.status = "open";
  await env.store.save(record);
  const what = [
    added.length ? `Added ${added.map((i) => i.ref).join(", ")}` : null,
    landed.length ? `${added.length ? "merged" : "Merged"} the PRs of ${landed.map((i) => i.ref).join(", ")}` : null,
  ].filter(Boolean);
  await env.store.comment(
    record,
    `${what.join(" and ")} after regression started, so the tested commit no longer holds the whole release. Tell QA again once every PR is merged.`,
  );
}

/**
 * Tells QA regression can start. Records the tested commit, comments on the
 * release's tracking issue mentioning QA on GitHub, and on the tracker where
 * it has its own comments (ClickUp). Chat front ends post their own message.
 */
export async function announceRegression(env, record) {
  if (!has(env, "announce_regression")) {
    throw new ReleaseError(`${env.project.name} has no regression step, so there's no QA to tell. Ask for approval instead.`);
  }
  if (!["open", "in_regression", "on_hold"].includes(record.state.status)) {
    throw new ReleaseError(`\`${record.state.tag}\` is ${record.state.status.replace("_", " ")}, so regression can't start again.`);
  }
  await markTested(env, record);
  record.state.status = "in_regression";
  await env.store.save(record);

  const qa = githubMentions(env.project.people.qa.github);
  const list = record.state.items.map((i) => `- ${i.ref} ${i.title}`).join("\n");
  const text = `${qa ? `${qa}: r` : "R"}egression can start for \`${record.state.tag}\`, at commit ${record.state.testedSha.slice(0, 7)}.\n\n${list}`;
  await env.store.comment(record, text);
  await env.tracker.notify(record.state.trackerRelease, `Regression can start for ${record.state.tag}.`);
  return { sha: record.state.testedSha };
}

/** Whether every item has reached "ready for release" (or "done"). */
export async function readiness(env, record) {
  const { statuses } = env.project.tracker;
  const current = await env.tracker.itemStatuses(record.state.items);
  const notReady = record.state.items.filter((item) => {
    const status = current.get(item.id);
    return !atStatus(env.project.tracker, status, statuses.ready_for_release) && !(statuses.done && atStatus(env.project.tracker, status, statuses.done));
  });
  return {
    ready: notReady.length === 0,
    notReady: notReady.map((item) => ({ ref: item.ref, title: item.title, status: current.get(item.id)?.status ?? "unknown" })),
  };
}

/**
 * Asks the release managers to approve. Blocked until every item is ready for
 * release. Returns `{ blocked, notReady }` or `{ record, laterCommits }`, where
 * `laterCommits` counts commits on the branch after the tested one: they are
 * not in this release and go in the next.
 */
export async function requestApproval(env, record, { actor }) {
  const { state } = record;
  if (["published", "archived"].includes(state.status)) throw new ReleaseError(`\`${state.tag}\` is already ${state.status}.`);
  // Recorded as "the AKO app", a request would let its real author approve it.
  if (actor.kind === "app") {
    throw new ReleaseError("Asking for approval needs a person, so nobody can approve their own request. Sign in with `npx ako login` first, or ask in Slack.");
  }
  // The approval has to come from the same place, so someone there must be able to give it.
  const managers = env.project.people.release_managers;
  const listedHere = actor.kind === "github" ? managers.github : managers.slack;
  if (!soloProject(env.project) && !listedHere?.length) {
    throw new ReleaseError(
      `${env.project.name} lists no release managers ${actor.kind === "github" ? "on GitHub" : "in Slack"}, and a release is approved where it was asked for. Ask ${actor.kind === "github" ? "in Slack" : "from the terminal"} instead.`,
    );
  }
  const check = await readiness(env, record);
  if (!check.ready) return { blocked: true, notReady: check.notReady };

  if (!state.testedSha) await markTested(env, record);
  const branch = await releaseBranch(env);
  const head = await g.branchHead(env.gh, env.project.repo, branch);
  const laterCommits = head === state.testedSha ? 0 : (await g.compare(env.gh, env.project.repo, state.testedSha, head)).ahead_by ?? 0;

  state.approval = { requestedBy: actorId(actor), requestedAt: iso(env), expiresAt: new Date(now(env) + APPROVAL_MS).toISOString() };
  state.decision = null;
  state.status = "awaiting_approval";
  await env.store.save(record);

  // Only the people who can answer it are mentioned; Slack's own message mentions the Slack ones.
  const mentions = actor.kind === "github" ? githubMentions(managers.github) : "";
  const how = actor.kind === "github" ? `from the terminal with \`npx ako release approve ${state.tag}\`` : "in Slack";
  const later = laterCommits ? `\n\n${laterCommits} commit(s) landed on \`${branch}\` after the tested one. They are not in this release and go in the next.` : "";
  await env.store.comment(
    record,
    `${mentions ? `${mentions}: ` : ""}${actorText(state.approval.requestedBy)} asks to publish \`${state.tag}\`, at tested commit ${state.testedSha.slice(0, 7)}. A release manager approves ${how}, within 24 hours.${later}`,
  );
  return { record, laterCommits };
}

/**
 * A release manager's answer. `verdict` is "approved" or "hold". Approving
 * publishes straight away. Throws a ReleaseError that says why when the
 * person can't decide, so every front end shows the same reason.
 */
export async function decide(env, record, { actor, verdict, note = null }) {
  const { state } = record;
  if (state.status === "awaiting_approval" && expired(env, record)) {
    // Back to regression, so the request can be made again.
    state.status = "in_regression";
    state.approval = null;
    await env.store.save(record);
    throw new ReleaseError(expiredText(state.tag));
  }
  await checkDecider(env, record, { actor, verdict });

  if (verdict === "approved") {
    // QA may have moved an issue back since the request.
    const check = await readiness(env, record);
    if (!check.ready) {
      throw new ReleaseError(
        `\`${state.tag}\` isn't ready any more: ${check.notReady.map((i) => `${i.ref} is in ${i.status}`).join(", ")}. Approve once QA moves it back to ${env.project.tracker.statuses.ready_for_release}.`,
      );
    }
  }
  state.decision = { verdict, by: actorId(actor), at: iso(env), note };
  if (verdict !== "approved") {
    state.status = "on_hold";
    await env.store.save(record);
    await env.store.comment(record, `${actorText(state.decision.by)} put \`${state.tag}\` on hold${note ? `: ${note}` : "."}`);
    return { held: true, record };
  }
  await env.store.save(record);
  return publish(env, record, { actor });
}

const expired = (env, record) => Date.parse(record.state.approval.expiresAt) < now(env);
const expiredText = (tag) => `The approval request for \`${tag}\` expired after 24 hours. Ask again to restart it.`;
const ALREADY = { published: "already published", archived: "already published and archived" };

/** A solo project lists no release managers: whoever asked approves. */
const soloProject = (project) => {
  const managers = project.people.release_managers;
  return project.approval === "self" && !(managers.github?.length || managers.slack?.length);
};

/**
 * The terminal knows people by GitHub login and Slack by Slack user, and AKO
 * can't tell that a login and a Slack user are the same person. So a release
 * is approved where it was asked for, where "not your own request" holds.
 * Throws a ReleaseError when `actor` is somewhere else.
 */
export function assertSamePlace(record, actor) {
  const asked = String(record.state.approval?.requestedBy ?? "").split(":")[0];
  if (actorId(actor).split(":")[0] === asked) return;
  throw new ReleaseError(
    `\`${record.state.tag}\` was asked for ${asked === "slack" ? "in Slack" : "from the terminal"}, so a release manager approves it there. AKO can't tell whether a GitHub login and a Slack user are the same person.`,
  );
}

/**
 * Throws a ReleaseError unless `record` is waiting for a release manager's
 * answer. `askHint` says how to ask, in the front end's own words.
 */
export function assertAwaitingApproval(record, askHint = `Ask first with \`npx ako release request ${record.state.tag}\`.`) {
  const { state } = record;
  if (ALREADY[state.status]) throw new ReleaseError(`\`${state.tag}\` is ${ALREADY[state.status]}.`);
  if (state.status !== "awaiting_approval") throw new ReleaseError(`Nobody has asked to publish \`${state.tag}\` yet. ${askHint}`);
}

/**
 * Throws a ReleaseError saying why `actor` can't approve or hold `record`
 * now, and changes nothing, so a front end can say so before asking anything.
 * `decide` runs the same checks. A hold may come from anywhere: it stops a
 * release rather than shipping it.
 */
export async function checkDecider(env, record, { actor, verdict = "approved" }) {
  const { state } = record;
  assertAwaitingApproval(record);
  if (expired(env, record)) throw new ReleaseError(expiredText(state.tag));
  if (verdict === "approved") assertSamePlace(record, actor);
  const solo = soloProject(env.project) && actorId(actor) === state.approval.requestedBy;
  if (!solo) {
    const manager = await isReleaseManager(env.project, actor, env);
    if (!manager.ok) throw new ReleaseError(manager.reason);
  }
  if (env.project.approval !== "self" && actorId(actor) === state.approval.requestedBy) {
    throw new ReleaseError("You asked for this release, so another release manager approves it.");
  }
}

/** Tags the tested commit and publishes the GitHub Release. Promotes first for release-branch flows. */
export async function publish(env, record, { actor }) {
  const { project, gh, store } = env;
  const { state } = record;
  return store.withLock(record, actorId(actor), async () => {
    const existing = await g.getReleaseByTag(gh, project.repo, state.tag);
    if (existing) {
      state.published ??= { url: existing.html_url, sha: state.testedSha, at: existing.created_at };
      state.status = "published";
      await store.save(record);
      return { record, release: existing, alreadyPublished: true };
    }

    let sha = state.testedSha ?? (await g.branchHead(gh, project.repo, await releaseBranch(env)));
    if (project.release.type === "release-branch") sha = await promote(env, record, sha);

    const previousTag = latestTag(project.release.tag_prefix, await g.listTags(gh, project.repo), { before: state.tag });
    const release = await createReleaseAllowed(env, { tag: state.tag, sha, previousTag });
    state.published = { url: release.html_url, sha, at: iso(env) };
    state.status = "published";
    await store.save(record);
    await store.comment(record, `Published \`${state.tag}\` at ${sha.slice(0, 7)}: ${release.html_url}`);
    return { record, release, previousTag };
  });
}

const refusedByRules = (error) =>
  [403, 422].includes(error.status) && /\brules?\b|ruleset|protected|bypass/i.test(`${error.data?.message ?? ""} ${JSON.stringify(error.data?.errors ?? [])}`);

/**
 * Creates the tag and GitHub Release. A tag ruleset often lets only the AKO
 * app create release tags, and someone signed in with `ako login` acts as
 * themselves, which such a ruleset may refuse. Where this copy holds the
 * app's key, the tag is then created as the app; the approval stays recorded
 * under the person who gave it.
 */
async function createReleaseAllowed(env, options) {
  try {
    return await g.createRelease(env.gh, env.project.repo, options);
  } catch (error) {
    if (!refusedByRules(error)) throw error;
    const app = env.appClient ? await env.appClient() : null;
    if (app && app !== env.gh) return g.createRelease(app, env.project.repo, options);
    throw new ReleaseError(
      `GitHub refused to create the tag \`${options.tag}\` (${error.data?.message ?? error.message}). A tag ruleset probably lets only the AKO app create it. Approve in Slack, or approve again where AKO has the app's private key.`,
    );
  }
}

/**
 * Release-branch flows: merges the tested commit (not the branch as it is
 * now) into the production branch through a PR, and returns the merge commit
 * to tag. Work merged to `from` during QA stays out.
 */
async function promote(env, record, sha) {
  const { project, gh } = env;
  const { from, to } = project.release;
  const comparison = await g.compare(gh, project.repo, to, sha);
  if ((comparison.ahead_by ?? 0) === 0) return g.branchHead(gh, project.repo, to);

  const temp = `ako/promote-${record.state.tag}`;
  try {
    await g.createBranch(gh, project.repo, temp, sha);
  } catch (error) {
    if (error.status !== 422) throw error; // already there from an earlier try
  }
  try {
    const pr = await g.createPull(gh, project.repo, {
      title: `Release ${record.state.tag}: promote ${from} to ${to}`,
      head: temp,
      base: to,
      body: `Promotes the commit QA tested (${sha.slice(0, 7)}) for release \`${record.state.tag}\`. Opened by Deriv AKO.`,
    });
    const merged = await g.mergePull(gh, project.repo, pr.number, "merge");
    if (!merged.merged) throw new ReleaseError(`Couldn't merge the promotion PR into ${to}: ${merged.reason}. Fix it and approve again.`, { url: pr.html_url });
    return merged.sha;
  } finally {
    await g.deleteBranch(gh, project.repo, temp);
  }
}

/**
 * Follows the deploy the tag started, reporting through `onEvent` as it goes:
 * `{ kind: "started", url }`, then `{ kind: "finished", conclusion, url }`,
 * or `{ kind: "not_found" }` / `{ kind: "timeout" }`. Never throws for a
 * deploy that fails: that is a result to report, not an error.
 */
export async function watchDeploy(env, record, { onEvent = () => {}, appearMs = 5 * 60 * 1000, finishMs = 30 * 60 * 1000, intervalMs = 15 * 1000 } = {}) {
  const { project, gh, store } = env;
  const { deploy } = project;
  const { state } = record;
  if (deploy.type === "none" || !state.published) return { kind: "none" };
  const sleep = env.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const look = async () => {
    if (deploy.type === "actions") {
      const [run] = await g.workflowRunsForTag(gh, project.repo, deploy.workflow, state.tag);
      return run ? { url: run.html_url, done: run.status === "completed", conclusion: run.conclusion } : null;
    }
    if (deploy.type === "commit-status") {
      const statuses = await g.commitStatuses(gh, project.repo, state.published.sha);
      const latest = statuses.find((s) => s.context.startsWith(deploy.context));
      return latest ? { url: latest.target_url, done: latest.state !== "pending", conclusion: latest.state } : null;
    }
    const runs = await g.checkRuns(gh, project.repo, state.tag);
    const run = runs.find((r) => r.name.startsWith(deploy.check));
    return run ? { url: run.details_url ?? run.html_url, done: run.status === "completed", conclusion: run.conclusion } : null;
  };

  const started = now(env);
  let seen = null;
  for (;;) {
    let current = null;
    try {
      current = await look();
    } catch {
      current = seen; // a failed read is retried on the next beat
    }
    if (current && !seen) onEvent({ kind: "started", url: current.url });
    if (current) seen = current;
    if (current?.done) {
      state.deploy = { conclusion: current.conclusion, url: current.url, at: iso(env) };
      await store.save(record);
      const event = { kind: "finished", conclusion: current.conclusion, url: current.url };
      onEvent(event);
      return event;
    }
    const waited = now(env) - started;
    if (!seen && waited > appearMs) {
      const event = { kind: "not_found" };
      onEvent(event);
      return event;
    }
    if (waited > appearMs + finishMs) {
      const event = { kind: "timeout", url: seen?.url };
      onEvent(event);
      return event;
    }
    await sleep(intervalMs);
  }
}

/** After release: moves the work to "done", closes the milestone and the tracking issue. */
export async function archive(env, record, { actor }) {
  const { project, store, tracker } = env;
  if (record.state.status !== "published") {
    throw new ReleaseError(`Only a published release can be archived; \`${record.state.tag}\` is ${record.state.status.replace("_", " ")}.`);
  }
  return store.withLock(record, actorId(actor), async () => {
    const done = project.tracker.statuses.done;
    const moved = done ? await tracker.moveItems(record.state.items, done) : { moved: 0, failed: [] };
    await tracker.closeRelease(record.state.trackerRelease);
    record.state.status = "archived";
    record.state.archivedAt = iso(env);
    await store.save(record);
    return { record, moved };
  });
}

/** Finds a release by tag, or the newest one still being worked on. */
export async function findRelease(env, tag) {
  if (tag) {
    const record = await env.store.findByTag(tag);
    if (!record) throw new ReleaseError(`There's no release \`${tag}\` for ${env.project.name}.`);
    return record;
  }
  const [current] = await env.store.inFlight();
  if (current) return current;
  const [latest] = await env.store.list();
  if (latest) return latest;
  throw new ReleaseError(`${env.project.name} has no releases yet. Start one with \`npx ako release create ${env.project.key}\`.`);
}

// Without a tag, an action means a release it can act on: one with these
// statuses, trying each group in turn. "Tell QA" means the release QA hasn't
// heard about before one they're already testing.
const FOR_ACTION = {
  announce: [["open"], ["in_regression", "on_hold"]],
  request: [["open", "in_regression", "on_hold"], ["awaiting_approval"]],
  approve: [["awaiting_approval"]],
  hold: [["awaiting_approval"]],
  watch: [["published"]],
  archive: [["published"]],
  unlock: [[...IN_FLIGHT], ["published"]],
};

const NONE_FOR = {
  announce: (p) => `${p.name} has no release for QA to test. Start one with \`npx ako release create ${p.key}\`.`,
  request: (p) => `${p.name} has no release to ask approval for. Start one with \`npx ako release create ${p.key}\`.`,
  approve: (p) => `Nobody has asked to publish a ${p.name} release yet. Ask first with \`npx ako release request ${p.key}\`.`,
  hold: (p) => `Nobody has asked to publish a ${p.name} release yet, so there's nothing to hold.`,
  watch: (p) => `${p.name} has no published release to watch.`,
  archive: (p) => `${p.name} has no published release left to archive.`,
  unlock: (p) => `${p.name} has no release to unlock.`,
};

/**
 * The releases `action` could mean when no tag names one, newest first.
 * Several mean the person picks; watching means the newest published one.
 * Throws a ReleaseError saying why when none fits.
 */
export async function releasesFor(env, action) {
  const all = await env.store.list();
  for (const statuses of FOR_ACTION[action] ?? [[...IN_FLIGHT]]) {
    const found = all.filter((r) => statuses.includes(r.state.status));
    if (found.length) return action === "watch" ? found.slice(0, 1) : found;
  }
  throw new ReleaseError((NONE_FOR[action] ?? ((p) => `${p.name} has no releases yet. Start one with \`npx ako release create ${p.key}\`.`))(env.project));
}
