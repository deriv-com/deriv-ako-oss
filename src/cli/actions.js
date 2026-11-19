// What the terminal does for each request, shared by `ako release …` and the
// `ako` chat. The engine does the work; this asks the questions a person
// answers in the terminal (which issues, which release when several fit,
// confirm before publishing) and reports what happened.
//
// When Slack is connected, the steps that hand work to other people (telling
// QA regression can start, asking release managers to approve) are posted to
// the project's Slack channel too, so a release run from the terminal still
// reaches them.

import {
  readyWork,
  openRelease,
  announceRegression,
  requestApproval,
  decide,
  watchDeploy,
  archive,
  readiness,
  checkDecider,
  findRelease,
  releasesFor,
  unmerged,
  ReleaseError,
} from "../engine/release.js";
import { LockedError, STATUS_TEXT, IN_FLIGHT } from "../engine/store.js";
import { slackMentions, actorText } from "../engine/people.js";
import { SetupCancelled } from "../setup/pretty.js";

export const HELP = [
  "What AKO can do, in plain words or as commands:",
  "  what's ready for <project>            npx ako release ready <project>",
  "  create release for <project>          npx ako release create <project>",
  "  status of <project>                   npx ako release status <project>",
  "  tell QA for <project>                 npx ako release announce <project>",
  "  ask to approve <project>              npx ako release request <project>",
  "  approve <project> / hold <project>    npx ako release approve <project> / hold <project>",
  "  watch the deploy of <project>         npx ako release watch <project>",
  "  archive <project>                     npx ako release archive <project>",
  "Each one finds the release it acts on, and asks when several could be meant. A tag names one: npx ako release approve production_v20261102_0",
];

const has = (project, step) => project.steps.includes(step);
const short = (sha) => (sha ? sha.slice(0, 7) : "?");
const signedIn = (ws) => ws.actor.kind === "github";

/**
 * Runs `fn` while AKO talks to GitHub. The styled terminal shows a spinner and
 * swallows keys pressed meanwhile, so one can't answer the next question.
 * `fn` gets `note(text)` to print a line without breaking the spinner.
 */
const busy = (p, label, fn) => (p.working ? p.working(label, fn) : fn({ note: (text) => p.write(text) }));

// Steps GitHub must record under a person, and why.
const NEEDS_SIGN_IN = {
  request: "Asking for approval needs your own GitHub sign-in, so nobody can approve their own request.",
  approve: "Approving needs your own GitHub sign-in, so GitHub records who approved.",
  hold: "Holding a release needs your own GitHub sign-in, so GitHub records who held it.",
};

/** Runs one request. Returns `{ ok }`; reasons the engine refuses are shown, not thrown. */
export async function runRequest(ws, request, p) {
  if (request.action === "help") {
    p.write(`${HELP.join("\n")}\n`);
    return { ok: true };
  }
  if (NEEDS_SIGN_IN[request.action] && !(await ensureSignedIn(ws, p, request))) return { ok: false };
  const project = await resolveProject(ws, request, p);
  if (!project) return { ok: false };
  const env = await ws.envFor(project);
  try {
    switch (request.action) {
      case "ready":
        return await showReady(env, p);
      case "create":
        return await create(ws, env, p, request);
      case "status":
        return await showStatus(env, p, request.tag);
      case "announce":
        return await tellQa(ws, env, p, await pickRelease(env, p, request));
      case "request":
        return await askApproval(ws, env, p, await pickRelease(env, p, request));
      case "approve":
      case "hold":
        return await answer(ws, env, p, request, await pickRelease(env, p, request));
      case "watch":
        return await watch(ws, env, p, await pickRelease(env, p, request), request);
      case "archive":
        return await doArchive(ws, env, p, await pickRelease(env, p, request));
      case "unlock":
        return await unlock(env, p, await pickRelease(env, p, request));
      default:
        p.write(`  ✗ AKO can't "${request.action}".\n`);
        return { ok: false };
    }
  } catch (error) {
    if (error instanceof ReleaseError || error instanceof LockedError) {
      p.write(`  ✗ ${error.message}${error.url ? ` ${error.url}` : ""}\n`);
      return { ok: false };
    }
    throw error;
  }
}

/**
 * Signs in on the way when the person agrees, where this terminal can.
 * Returns whether they're signed in now; otherwise it has said how to.
 */
async function ensureSignedIn(ws, p, request) {
  if (signedIn(ws)) return true;
  const why = NEEDS_SIGN_IN[request.action];
  if (!ws.signIn || request.yes) {
    p.write(`  ✗ ${why} Run \`npx ako login\` first.\n`);
    return false;
  }
  p.write(`${why}\n`);
  if (!(await p.confirm("Sign in now?", true))) return false;
  try {
    return await ws.signIn(p);
  } catch (error) {
    if (error instanceof SetupCancelled) throw error;
    p.write(`  ✗ ${error.message}\n`);
    return false;
  }
}

/**
 * The release a request means: the one its tag names, or the one its action
 * can act on. When several can, the person picks; with --yes nobody is there
 * to ask, so AKO lists them instead.
 */
async function pickRelease(env, p, request) {
  if (request.tag) return findRelease(env, request.tag);
  const records = await busy(p, `Finding the ${env.project.name} release`, () => releasesFor(env, request.action));
  if (records.length === 1) return records[0];
  if (request.yes) {
    const tags = records.map((r) => r.state.tag);
    throw new ReleaseError(`${tags.length} ${env.project.name} releases could be meant: ${tags.join(", ")}. Name one, as in \`npx ako release ${request.action} ${tags[0]}\`.`);
  }
  return p.choose(
    `Which ${env.project.name} release?`,
    records.map((r) => ({ label: `${r.state.tag}: ${STATUS_TEXT[r.state.status].toLowerCase()}, ${r.state.items.length} issue(s)`, value: r })),
  );
}

async function resolveProject(ws, { project: name, tag }, p) {
  const { projects } = ws.flow;
  if (!name && tag) {
    // A tag names its project by prefix, when only one project uses that prefix.
    const byPrefix = projects.filter((x) => tag.startsWith(x.release.tag_prefix));
    if (byPrefix.length === 1) return byPrefix[0];
  }
  if (name) {
    const project = ws.findProject(name);
    if (!project) p.write(`  ✗ There's no project "${name}". Projects: ${projects.map((x) => x.key).join(", ")}.\n`);
    return project;
  }
  if (projects.length === 1) return projects[0];
  return p.choose("Which project?", projects.map((x) => ({ label: `${x.name} (${x.key})`, value: x })));
}

function itemLabel(item) {
  return `${item.ref} ${item.title}${item.caughtUp ? " (closed, already merged)" : ""}`;
}

async function showReady(env, p) {
  const { items, current, waiting } = await busy(p, `Reading ${env.project.name}`, () => readyWork(env));
  const { statuses } = env.project.tracker;
  if (!items.length) {
    p.write(`Nothing new is ready in ${env.project.name}. Work is picked up from: ${statuses.ready.join(", ")}.\n`);
  } else {
    p.write(`${items.length} ready in ${env.project.name}:\n${items.map((i) => `  ${itemLabel(i)}`).join("\n")}\n`);
  }
  for (const record of [current, waiting].filter(Boolean)) {
    p.write(`${record.state.tag} is ${STATUS_TEXT[record.state.status].toLowerCase()}, with ${record.state.items.length} issue(s).\n`);
  }
  if (current && items.length) p.write(`New work goes in ${current.state.tag}.\n`);
  return { ok: true, items };
}

async function create(ws, env, p, request) {
  const { project } = env;
  const { items, current } = await busy(p, `Reading ${project.name}`, () => readyWork(env));
  // Opening the open release again also retries its PRs that didn't merge.
  const retrying = current && !request.newRelease && has(project, "merge_prs") ? unmerged(current) : [];
  if (!items.length && !retrying.length) {
    p.write(`Nothing is ready to release in ${project.name}. Move issues to ${project.tracker.statuses.ready.join(" or ")} first.\n`);
    return { ok: false };
  }

  let picked = items;
  if (!items.length) {
    p.write(`Nothing new is ready in ${project.name}, so this retries the PRs of ${retrying.map((i) => i.ref).join(", ")} in ${current.state.tag}.\n`);
  } else if (request.items?.length) {
    const wanted = new Set(request.items.map((x) => String(x).replace(/^#/, "")));
    picked = items.filter((i) => wanted.has(i.id) || wanted.has(String(i.number)));
  } else if (!request.all) {
    // A project has one open release at a time, so the work joins it when there is one.
    const where = current && !request.newRelease ? `going into ${current.state.tag}` : "for the release";
    picked = await p.chooseMany(
      `What goes in? ${items.length} ready in ${project.name}, ${where}:`,
      items.map((i) => ({ label: itemLabel(i), value: i })),
      { defaults: items },
    );
  }

  const adding = current && !request.newRelease;
  const label = !picked.length ? "Retrying the merges" : adding ? `Adding to ${current.state.tag}` : picked.length > 1 ? "Opening the release and merging PRs" : "Opening the release";
  const result = await busy(p, label, () => openRelease(env, { items: picked, actor: ws.actor, newRelease: Boolean(request.newRelease) }));
  const { tag } = result.record.state;
  if (!result.reused) p.write(`Opened ${tag} with ${picked.length} issue(s). Tracking issue: ${result.record.url}\n`);
  else if (result.added.length) p.write(`Added ${result.added.length} issue(s) to ${tag}. Tracking issue: ${result.record.url}\n`);
  else p.write(`Retried the merges in ${tag}. Tracking issue: ${result.record.url}\n`);
  if (result.waiting) {
    const { state } = result.waiting;
    p.write(`${state.tag} is waiting for approval and still ships only its tested commit ${short(state.testedSha)}. This work goes out with ${tag}.\n`);
  }
  if (result.merges) reportMerges(p, result.merges, project);

  if (result.retested && has(project, "announce_regression")) {
    p.write(`  ! ${tag} had started regression. The new work came after the commit QA was testing, so tell QA again.\n`);
  }
  if (has(project, "announce_regression")) {
    // QA already testing what's there now needs no new word.
    if (result.record.state.status !== "open") return { ok: true, record: result.record };
    if (request.yes || (await p.confirm("Tell QA regression can start?", true))) await announce(ws, env, p, result.record);
    else p.write(`Tell QA later with: npx ako release announce ${project.key}\n`);
  } else if (!signedIn(ws)) {
    p.write(`To ask for approval, sign in with \`npx ako login\`, then run: npx ako release request ${project.key}\n`);
  } else if (request.yes || (await p.confirm("Ask the release managers to approve now?", true))) {
    await askApproval(ws, env, p, result.record);
  } else {
    p.write(`Ask later with: npx ako release request ${project.key}\n`);
  }
  return { ok: true, record: result.record };
}

function reportMerges(p, merges, project) {
  const lines = [];
  for (const r of merges.results) {
    if (r.result === "merged") lines.push(`Merged PR #${r.pr} (for ${r.item})`);
    else if (r.result === "already") lines.push(`  PR #${r.pr} (for ${r.item}) was already merged`);
    else if (r.result === "failed") lines.push(`  ✗ PR #${r.pr} (for ${r.item}) not merged: ${r.reason}`);
  }
  if (merges.staged.length) lines.push(`Moved ${merges.staged.join(", ")} to ${project.tracker.statuses.staged}`);
  for (const f of merges.stageFailed) lines.push(`  ! Couldn't move ${f.ref}: ${f.reason}`);
  if (merges.withoutPrs.length) lines.push(`  ! No linked PRs for ${merges.withoutPrs.join(", ")}. Link them in each issue's Development section.`);
  if (lines.length) p.write(`${lines.join("\n")}\n`);
  if (merges.results.some((r) => r.result === "failed")) p.write(`  ! Fix the PRs above and run \`npx ako release create ${project.key}\` again to retry the merges.\n`);
}

/** `ako release announce`: tells QA regression can start, for when it was skipped after `create`. */
async function tellQa(ws, env, p, record) {
  await announce(ws, env, p, record);
  return { ok: true, record };
}

async function announce(ws, env, p, record) {
  const { sha } = await busy(p, "Telling QA", () => announceRegression(env, record));
  p.write(`Told QA on the tracking issue: regression can start at commit ${short(sha)}.\n`);
  const qa = slackMentions(env.project.people.qa.slack);
  await postToSlack(ws, env, record, `${qa ? `${qa} ` : ""}Regression can start on staging for \`${record.state.tag}\` (${env.project.name}), at commit ${short(sha)}.\n${record.url}`, p);
}

async function askApproval(ws, env, p, record) {
  const result = await busy(p, "Checking every issue has passed QA", () => requestApproval(env, record, { actor: ws.actor }));
  if (result.blocked) {
    p.write(
      `  ✗ Not everything in ${record.state.tag} is ready for release yet:\n${result.notReady.map((i) => `    ${i.ref} ${i.title} (${i.status})`).join("\n")}\n` +
        `  QA moves each issue to ${env.project.tracker.statuses.ready_for_release} when it passes.\n`,
    );
    return { ok: false };
  }
  p.write(`Asked the release managers to approve ${record.state.tag}. They have 24 hours.\n`);
  if (result.laterCommits) {
    p.write(`  ! ${result.laterCommits} commit(s) landed after the tested one. They aren't in this release and go in the next.\n`);
  }
  const managers = slackMentions(env.project.people.release_managers.slack);
  await postToSlack(
    ws,
    env,
    record,
    `${managers ? `${managers} ` : ""}${actorText(record.state.approval.requestedBy)} asks to publish \`${record.state.tag}\` (${env.project.name}) from the terminal, so a release manager approves there: \`npx ako release approve ${env.project.key}\`. To stop it, reply \`@ako hold ${record.state.tag}\`.`,
    p,
  );
  return { ok: true, record };
}

async function answer(ws, env, p, request, record) {
  const { tag, testedSha } = record.state;
  // Who may decide, and whether there's anything to decide, is said before any question.
  const verdict = request.action === "hold" ? "hold" : "approved";
  await busy(p, "Checking you can decide", () => checkDecider(env, record, { actor: ws.actor, verdict }));
  let note = request.note ?? null;
  if (request.action === "hold") {
    note ??= (await p.ask("Why hold it?", { optional: true })) || null;
  } else if (!request.yes && !(await p.confirm(`Publish ${tag} at tested commit ${short(testedSha)} now?`, true))) {
    return { ok: false };
  }
  const result = await busy(p, verdict === "hold" ? "Putting it on hold" : `Publishing ${tag}`, () => decide(env, record, { actor: ws.actor, verdict, note }));
  if (result.held) {
    p.write(`Put ${tag} on hold.\n`);
    await postToSlack(ws, env, record, `\`${tag}\` (${env.project.name}) is on hold${note ? `: ${note}` : "."}`, p);
    return { ok: true };
  }
  p.write(`${result.alreadyPublished ? "Already published" : "Published"} ${tag}: ${result.release.html_url}\n`);
  await postToSlack(ws, env, record, `Released \`${tag}\` (${env.project.name}): ${result.release.html_url}`, p);
  if (has(env.project, "watch_deploy") && env.project.deploy.type !== "none" && (request.yes || (await p.confirm("Watch the deploy now?", true)))) {
    await watch(ws, env, p, record, request);
  }
  return { ok: true };
}

async function watch(ws, env, p, record, { yes = false } = {}) {
  if (!record.state.published) throw new ReleaseError(`\`${record.state.tag}\` isn't published yet.`);
  if (env.project.deploy.type === "none") {
    p.write(`${env.project.name} has nothing to watch: its flow file sets deploy type none.\n`);
    return { ok: true };
  }
  const result = await busy(p, `Waiting for the deploy of ${record.state.tag}`, ({ note }) =>
    watchDeploy(env, record, {
      onEvent: (e) => {
        if (e.kind === "started") note(`  Deploy started: ${e.url}\n`);
      },
    }),
  );
  if (result.kind === "finished") {
    const success = result.conclusion === "success";
    p.write(success ? `Deployed ${record.state.tag}: ${result.url}\n` : `  ✗ The deploy ended as ${result.conclusion}: ${result.url}\n`);
    await postToSlack(ws, env, record, `${success ? "Deployed" : `Deploy ${result.conclusion}:`} \`${record.state.tag}\` (${env.project.name}) ${result.url}`, p);
    // Archiving moves the work to done, so --yes never does it on its own.
    if (success && !yes && env.project.steps.includes("archive") && (await p.confirm("Archive the release now? This moves its work to done.", true))) {
      await doArchive(ws, env, p, record);
    }
  } else if (result.kind === "not_found") {
    p.write("  ! No deploy started within 5 minutes. Check that the tag starts your deploy.\n");
  } else {
    p.write(`  ! The deploy is still running after 30 minutes${result.url ? `: ${result.url}` : ""}.\n`);
  }
  return { ok: true };
}

async function doArchive(ws, env, p, record) {
  const { moved } = await busy(p, "Archiving", () => archive(env, record, { actor: ws.actor }));
  p.write(`Archived ${record.state.tag}${moved.moved ? `: moved ${moved.moved} issue(s) to ${env.project.tracker.statuses.done}` : ""}.\n`);
  for (const f of moved.failed) p.write(`  ! Couldn't move ${f.ref}: ${f.reason}\n`);
  return { ok: true };
}

async function showStatus(env, p, tag) {
  const records = tag ? [await findRelease(env, tag)] : (await env.store.list()).slice(0, 5);
  if (!records.length) {
    p.write(`${env.project.name} has no releases yet.\n`);
    return { ok: true };
  }
  for (const record of records) {
    const { state } = record;
    p.write(`${state.tag}: ${STATUS_TEXT[state.status]}, ${state.items.length} issue(s). ${record.url}\n`);
    if (IN_FLIGHT.has(state.status)) {
      const check = await readiness(env, record);
      if (check.ready) p.write(`  Every issue is ready for release.\n`);
      else p.write(`${check.notReady.map((i) => `  ${i.ref} ${i.title}: ${i.status}`).join("\n")}\n`);
    }
  }
  return { ok: true };
}

async function unlock(env, p, record) {
  const removed = await env.store.unlock(record);
  p.write(removed ? `Removed ${removed} lock(s) from ${record.state.tag}.\n` : `${record.state.tag} wasn't locked.\n`);
  return { ok: true };
}

/** Posts to the project's Slack channel, when Slack is connected; a failure is shown, never thrown. */
async function postToSlack(ws, env, record, text, p) {
  const channel = env.project.slack.announce_channel;
  if (!ws.slack || !channel) return;
  try {
    const thread = record.state.slack?.thread;
    const posted = await ws.slack.call("chat.postMessage", { channel, text, ...(thread ? { thread_ts: thread } : {}) });
    if (!thread) {
      record.state.slack = { channel, thread: posted.ts };
      await env.store.save(record);
    }
  } catch (error) {
    p.write(`  ! Couldn't post to Slack (${error.code ?? error.message}).\n`);
  }
}
