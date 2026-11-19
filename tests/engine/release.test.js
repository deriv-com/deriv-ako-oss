import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFlow } from "../../src/config/flow.js";
import { createStore, LockedError } from "../../src/engine/store.js";
import { createTracker } from "../../src/trackers/index.js";
import { githubActor, slackActor, APP_ACTOR } from "../../src/engine/people.js";
import {
  readyWork,
  openRelease,
  announceRegression,
  requestApproval,
  decide,
  watchDeploy,
  archive,
  findRelease,
  releasesFor,
  unmerged,
  readiness,
} from "../../src/engine/release.js";
import { fakeGitHub, newSha } from "../helpers/fakeGitHub.js";

const NOV_2 = Date.UTC(2026, 10, 2, 9, 0, 0);
const alice = githubActor("alice"); // opens and asks for approval
const bob = githubActor("bob"); // release manager
const mallory = githubActor("mallory"); // neither

function projectFrom(overrides = {}) {
  const { flow, errors } = validateFlow({
    version: 1,
    projects: [
      {
        key: "web-app",
        name: "Web App",
        repo: "acme/web-app",
        tracker: {
          type: "github-issues",
          statuses: { ready: "Ready for Staging", staged: "Staged", ready_for_release: "Ready for Release", done: "closed" },
        },
        deploy: { type: "actions", workflow: "deploy.yml" },
        people: { release_managers: { github: ["bob", "acme/leads"] }, qa: { github: ["quinn"] } },
        ...overrides,
      },
    ],
  });
  assert.deepEqual(errors, []);
  return flow.projects[0];
}

function setup(overrides) {
  const gh = fakeGitHub();
  const project = projectFrom(overrides);
  let clock = NOV_2;
  const env = {
    project,
    gh,
    tracker: createTracker(project, { gh }),
    store: createStore(gh, project, { now: () => clock }),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  return { gh, env, project, advance: (ms) => (clock += ms) };
}

const labelsOf = (gh, issue) => [...gh.world.issues.find((i) => i.number === issue.number).labels];
const stored = (gh, issue) => gh.world.issues.find((i) => i.number === issue.number);
const itemOf = (issue) => ({ id: String(issue.number), ref: `#${issue.number}`, number: issue.number, title: issue.title });

test("a release runs end to end: open, merge, regression, approval, publish, deploy, archive", async () => {
  const { gh, env } = setup();
  const one = gh.addIssue({ title: "Fix payout label", labels: ["Ready for Staging"] });
  const two = gh.addIssue({ title: "Correct landscape message", labels: ["Ready for Staging"] });
  gh.addIssue({ title: "Not ready", labels: ["In Progress"] });
  const openPr = gh.addPull({ issue: one });
  gh.addPull({ issue: two, state: "merged" });

  // What's ready
  const { items } = await readyWork(env);
  assert.deepEqual(items.map((i) => i.ref), ["#1", "#2"]);

  // Open the release: milestone named after the tag, PRs merged, issues staged
  const opened = await openRelease(env, { items, actor: alice });
  const { tag } = opened.record.state;
  assert.equal(tag, "production_v20261102_0");
  assert.equal(gh.world.milestones[0].title, tag);
  assert.deepEqual(gh.world.issues.filter((i) => i.milestone === 1).map((i) => i.number), [one.number, two.number]);
  assert.deepEqual(opened.merges.results.map((r) => r.result), ["merged", "already"]);
  assert.equal(gh.world.pulls.find((p) => p.number === openPr.number).method, "squash");
  assert.deepEqual(labelsOf(gh, one), ["Staged"]);
  assert.deepEqual(labelsOf(gh, two), ["Staged"]);

  // Nothing new is ready now: both are on the release
  assert.deepEqual((await readyWork(env)).items, []);

  // Regression starts at the branch head, and QA is told on the tracking issue
  const record = await findRelease(env);
  const { sha } = await announceRegression(env, record);
  assert.equal(sha, gh.head("main"));
  assert.match(gh.world.comments.at(-1).body, /@quinn: regression can start for `production_v20261102_0`/);

  // Approval is blocked until QA moves everything to "Ready for Release"
  const blocked = await requestApproval(env, record, { actor: alice });
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.notReady.map((i) => i.status), ["Staged", "Staged"]);

  for (const issue of [one, two]) {
    const stored = gh.world.issues.find((i) => i.number === issue.number);
    stored.labels = new Set(["Ready for Release"]);
  }
  gh.commit("main"); // someone merges more work during QA
  const asked = await requestApproval(env, record, { actor: alice });
  assert.equal(asked.laterCommits, 1);
  assert.match(gh.world.comments.at(-1).body, /@bob @acme\/leads: @alice asks to publish/);

  // Only release managers approve
  await assert.rejects(decide(env, record, { actor: alice, verdict: "approved" }), /@alice isn't a release manager/);
  await assert.rejects(decide(env, record, { actor: mallory, verdict: "approved" }), /@mallory isn't a release manager/);

  // A release manager approves: the TESTED commit is tagged, not main's head
  const published = await decide(env, record, { actor: bob, verdict: "approved" });
  assert.equal(published.release.tag_name, tag);
  assert.equal(published.release.target_commitish, sha);
  assert.notEqual(sha, gh.head("main"));
  assert.equal(record.state.status, "published");
  assert.deepEqual(gh.world.comments.filter((c) => c.body.includes("ako-lock")), [], "the lock is released");

  // Approving again changes nothing
  await assert.rejects(decide(env, record, { actor: bob, verdict: "approved" }), /already published/);

  // The deploy the tag started is followed to the end
  gh.world.runs.push({ workflow: "deploy.yml", tag, status: "in_progress", conclusion: null, html_url: "https://run/1" });
  const events = [];
  const watching = watchDeploy(env, record, {
    onEvent: (e) => {
      events.push(e.kind);
      Object.assign(gh.world.runs[0], { status: "completed", conclusion: "success" });
    },
    intervalMs: 1000,
  });
  assert.deepEqual(await watching, { kind: "finished", conclusion: "success", url: "https://run/1" });
  assert.deepEqual(events, ["started", "finished"]);

  // Archive: issues closed (done is "closed"), milestone and tracking issue closed
  await archive(env, record, { actor: bob });
  assert.deepEqual(gh.world.issues.filter((i) => [one.number, two.number].includes(i.number)).map((i) => i.state), ["closed", "closed"]);
  assert.equal(gh.world.milestones[0].state, "closed");
  assert.equal(gh.world.issues.find((i) => i.number === record.issue).state, "closed");
});

test("a second release in the same cycle reuses the open one, unless a new one is asked for", async () => {
  const { gh, env } = setup();
  const first = gh.addIssue({ title: "First", labels: ["Ready for Staging"] });
  await openRelease(env, { items: [{ id: String(first.number), ref: "#1", number: first.number, title: "First" }], actor: alice });

  const second = gh.addIssue({ title: "Second", labels: ["Ready for Staging"] });
  const { items } = await readyWork(env);
  assert.deepEqual(items.map((i) => i.title), ["Second"]);
  const reused = await openRelease(env, { items, actor: alice });
  assert.equal(reused.reused, true);
  assert.equal(reused.record.state.tag, "production_v20261102_0");
  assert.equal(gh.world.issues.find((i) => i.number === second.number).milestone, 1);

  const third = gh.addIssue({ title: "Third", labels: ["Ready for Staging"] });
  const fresh = await openRelease(env, { items: [{ id: String(third.number), ref: `#${third.number}`, number: third.number, title: "Third" }], actor: alice, newRelease: true });
  assert.equal(fresh.record.state.tag, "production_v20261102_1");
});

test("a PR that can't be merged is reported and its issue stays where it is", async () => {
  const { gh, env } = setup();
  const issue = gh.addIssue({ title: "Needs review", labels: ["Ready for Staging"] });
  const pr = gh.addPull({ issue });
  gh.world.pulls.find((p) => p.number === pr.number).blocked = "At least 1 approving review is required";
  const other = gh.addIssue({ title: "Wrong base", labels: ["Ready for Staging"] });
  gh.addPull({ issue: other, base: "develop" });
  const noPr = gh.addIssue({ title: "No PR", labels: ["Ready for Staging"] });

  const { items } = await readyWork(env);
  const { merges } = await openRelease(env, { items, actor: alice });
  assert.deepEqual(
    merges.results.map((r) => [r.result, r.reason]),
    [
      ["failed", "At least 1 approving review is required"],
      ["failed", "targets develop, not main"],
    ],
  );
  assert.deepEqual(merges.staged, []);
  assert.deepEqual(merges.withoutPrs, [`#${noPr.number}`]);
  assert.deepEqual(labelsOf(gh, issue), ["Ready for Staging"]);
});

test("an approval request expires after 24 hours", async () => {
  const { gh, env, advance } = setup();
  const issue = gh.addIssue({ title: "Done", labels: ["Ready for Release"] });
  const { record } = await openRelease(env, { items: [{ id: String(issue.number), ref: "#1", number: issue.number, title: "Done" }], actor: alice });
  await requestApproval(env, record, { actor: alice });
  advance(25 * 60 * 60 * 1000);
  await assert.rejects(decide(env, record, { actor: bob, verdict: "approved" }), /expired after 24 hours/);
  assert.equal(record.state.status, "in_regression");
});

test("hold, then ask again and approve", async () => {
  const { gh, env } = setup();
  const issue = gh.addIssue({ title: "Done", labels: ["Ready for Release"] });
  const { record } = await openRelease(env, { items: [{ id: String(issue.number), ref: "#1", number: issue.number, title: "Done" }], actor: alice });
  await requestApproval(env, record, { actor: alice });
  const held = await decide(env, record, { actor: bob, verdict: "hold", note: "waiting for the backend" });
  assert.equal(held.held, true);
  assert.equal(record.state.status, "on_hold");
  assert.match(gh.world.comments.at(-1).body, /on hold: waiting for the backend/);
  await requestApproval(env, record, { actor: alice });
  await decide(env, record, { actor: bob, verdict: "approved" });
  assert.equal(record.state.status, "published");
});

test("a release manager can't approve their own request", async () => {
  const { gh, env } = setup();
  const issue = gh.addIssue({ title: "Done", labels: ["Ready for Release"] });
  const { record } = await openRelease(env, { items: [{ id: String(issue.number), ref: "#1", number: issue.number, title: "Done" }], actor: bob });
  await requestApproval(env, record, { actor: bob });
  await assert.rejects(decide(env, record, { actor: bob, verdict: "approved" }), /You asked for this release/);
  assert.equal(record.state.status, "awaiting_approval");
});

test("a team member approves through the team, and self-approval is allowed when the flow says so", async () => {
  const { gh, env } = setup({ approval: "self" });
  gh.world.teams["acme/leads"] = ["lena"];
  const issue = gh.addIssue({ title: "Done", labels: ["Ready for Release"] });
  const { record } = await openRelease(env, { items: [{ id: String(issue.number), ref: "#1", number: issue.number, title: "Done" }], actor: bob });
  await requestApproval(env, record, { actor: bob });
  await decide(env, record, { actor: bob, verdict: "approved" });
  assert.equal(record.state.status, "published");

  const { env: env2, gh: gh2 } = setup();
  gh2.world.teams["acme/leads"] = ["lena"];
  const i2 = gh2.addIssue({ title: "Done", labels: ["Ready for Release"] });
  const r2 = (await openRelease(env2, { items: [{ id: String(i2.number), ref: "#1", number: i2.number, title: "Done" }], actor: alice })).record;
  await requestApproval(env2, r2, { actor: alice });
  await decide(env2, r2, { actor: githubActor("lena"), verdict: "approved" });
  assert.equal(r2.state.status, "published");
});

test("a Slack approval is checked against the Slack release managers, user groups included", async () => {
  const slack = { call: async (method, params) => (method === "usergroups.users.list" && params.usergroup === "S000000001" ? { users: ["U000000009"] } : { users: [] }) };
  const { gh, env } = setup({ people: { release_managers: { slack: ["S000000001"] } } });
  env.slack = slack;
  const issue = gh.addIssue({ title: "Done", labels: ["Ready for Release"] });
  const { record } = await openRelease(env, { items: [{ id: String(issue.number), ref: "#1", number: issue.number, title: "Done" }], actor: slackActor("U000000001") });
  await requestApproval(env, record, { actor: slackActor("U000000001") });
  await assert.rejects(decide(env, record, { actor: slackActor("U000000005"), verdict: "approved" }), /isn't a release manager/);
  await decide(env, record, { actor: slackActor("U000000009"), verdict: "approved" });
  assert.equal(record.state.status, "published");
});

test("a direct release is tested as it stands and can be approved straight away", async () => {
  const { gh, env } = setup({ steps: "direct-release" });
  const issue = gh.addIssue({ title: "Merged already", labels: ["Ready for Staging"] });
  const { items } = await readyWork(env);
  const { record, merges } = await openRelease(env, { items, actor: alice });
  assert.equal(merges, null, "no merge step");
  assert.equal(record.state.testedSha, gh.head("main"));
  assert.deepEqual(labelsOf(gh, issue), ["Ready for Release"], "moved for QA, since nobody else would");
  const asked = await requestApproval(env, record, { actor: alice });
  assert.equal(asked.blocked, undefined);
});

test("a release branch promotes the tested commit, not the branch as it is now", async () => {
  const { gh, env } = setup({ release: { type: "release-branch", from: "staging", to: "main", tag_prefix: "production-" } });
  gh.world.branches.staging = [...gh.world.branches.main, newSha()];
  const issue = gh.addIssue({ title: "Feature", labels: ["Ready for Staging"] });
  gh.addPull({ issue, base: "staging" });
  const { items } = await readyWork(env);
  const { record } = await openRelease(env, { items, actor: alice });
  await announceRegression(env, record);
  const tested = record.state.testedSha;
  gh.world.issues.find((i) => i.number === issue.number).labels = new Set(["Ready for Release"]);
  gh.commit("staging"); // merged during QA: must not ship

  await requestApproval(env, record, { actor: alice });
  const { release } = await decide(env, record, { actor: bob, verdict: "approved" });
  const promotion = gh.world.pulls.find((p) => p.head === `ako/promote-${record.state.tag}`);
  assert.equal(promotion.base, "main");
  assert.equal(promotion.method, "merge");
  assert.equal(release.target_commitish, promotion.mergeSha);
  assert.equal(gh.world.branches[`ako/promote-${record.state.tag}`], undefined, "the temporary branch is gone");
  assert.ok(tested);
});

test("two copies can't act on one release at once", async () => {
  const { gh, env } = setup();
  const issue = gh.addIssue({ title: "Done", labels: ["Ready for Release"] });
  const { record } = await openRelease(env, { items: [{ id: String(issue.number), ref: "#1", number: issue.number, title: "Done" }], actor: alice });
  await env.store.withLock(record, "terminal:alice", async () => {
    await assert.rejects(env.store.withLock(record, "slack:bot", async () => "never"), LockedError);
  });
  assert.equal(await env.store.withLock(record, "slack:bot", async () => "after"), "after");
});

test("the deploy watch reports a deploy that never started", async () => {
  const { gh, env } = setup();
  const issue = gh.addIssue({ title: "Done", labels: ["Ready for Release"] });
  const { record } = await openRelease(env, { items: [{ id: String(issue.number), ref: "#1", number: issue.number, title: "Done" }], actor: alice });
  await requestApproval(env, record, { actor: alice });
  await decide(env, record, { actor: bob, verdict: "approved" });
  const result = await watchDeploy(env, record, { intervalMs: 60 * 1000 });
  assert.deepEqual(result, { kind: "not_found" });
});

test("a GitHub Projects board: ready items come from its columns, and staging moves the card", async () => {
  const gh = fakeGitHub();
  const project = projectFrom({
    tracker: { type: "github-projects", number: 3, statuses: { ready: "Ready for Staging", staged: "Staged", ready_for_release: "Ready for Release", done: "Done", catch_up: "In Progress" } },
  });
  gh.useBoard(["In Progress", "Ready for Staging", "Staged", "Ready for Release", "Done"]);
  const ready = gh.addIssue({ title: "On the board" });
  gh.putOnBoard(ready, "Ready for Staging");
  gh.addPull({ issue: ready });
  const left = gh.addIssue({ title: "Closed, merged, left behind", state: "closed" });
  gh.putOnBoard(left, "In Progress");
  gh.addPull({ issue: left, state: "merged" });
  const open = gh.addIssue({ title: "Still being worked on" });
  gh.putOnBoard(open, "In Progress");

  const env = { project, gh, tracker: createTracker(project, { gh }), store: createStore(gh, project, { now: () => NOV_2 }), now: () => NOV_2 };
  const { items } = await readyWork(env);
  assert.deepEqual(items.map((i) => [i.title, Boolean(i.caughtUp)]), [["On the board", false], ["Closed, merged, left behind", true]]);
  await openRelease(env, { items, actor: alice });
  assert.deepEqual(gh.world.board.items.map((i) => i.status), ["Staged", "Staged", "In Progress"]);
});

test("a tag ruleset that refuses a person's token: the app creates the tag where it can, else AKO says where to approve", async () => {
  const ruleError = Object.assign(new Error("GitHub POST failed with 422"), { status: 422, data: { message: "Repository rule violations found\n\nCannot create ref due to creations being restricted." } });
  const asPerson = (gh) => ({
    ...gh,
    async request(method, path, body) {
      if (method === "POST" && path.endsWith("/releases")) throw ruleError;
      return gh.request(method, path, body);
    },
  });

  for (const withAppKey of [true, false]) {
    const { gh, env } = setup();
    env.gh = asPerson(gh);
    env.store = createStore(env.gh, env.project, { now: env.now });
    env.tracker = createTracker(env.project, { gh: env.gh });
    if (withAppKey) env.appClient = async () => gh;
    const issue = gh.addIssue({ title: "Done", labels: ["Ready for Release"] });
    const { record } = await openRelease(env, { items: [{ id: String(issue.number), ref: "#1", number: issue.number, title: "Done" }], actor: alice });
    await requestApproval(env, record, { actor: alice });
    if (withAppKey) {
      await decide(env, record, { actor: bob, verdict: "approved" });
      assert.equal(gh.world.releases.length, 1);
      assert.equal(record.state.decision.by, "github:bob", "the approval is still bob's");
    } else {
      await assert.rejects(decide(env, record, { actor: bob, verdict: "approved" }), /A tag ruleset probably lets only the AKO app create it\. Approve in Slack/);
      assert.equal(gh.world.releases.length, 0);
      assert.equal(record.state.status, "awaiting_approval", "approving again retries");
    }
  }
});

test("a solo project lists no release managers: whoever asked approves, and nobody else", async () => {
  const { gh, env } = setup({ approval: "self", people: { release_managers: {} } });
  const issue = gh.addIssue({ title: "Done", labels: ["Ready for Release"] });
  const { record } = await openRelease(env, { items: [{ id: String(issue.number), ref: "#1", number: issue.number, title: "Done" }], actor: alice });
  await requestApproval(env, record, { actor: alice });
  await assert.rejects(decide(env, record, { actor: mallory, verdict: "approved" }), /lists no GitHub release managers/);
  await decide(env, record, { actor: alice, verdict: "approved" });
  assert.equal(record.state.status, "published");
});

test("a PR that couldn't merge is retried when the open release is opened again", async () => {
  const { gh, env } = setup();
  const issue = gh.addIssue({ title: "Needs review", labels: ["Ready for Staging"] });
  const pr = gh.addPull({ issue });
  gh.world.pulls.find((x) => x.number === pr.number).blocked = "At least 1 approving review is required";
  const { record } = await openRelease(env, { items: (await readyWork(env)).items, actor: alice });
  assert.deepEqual(unmerged(record).map((i) => i.ref), [`#${issue.number}`]);
  await announceRegression(env, record);

  // Once it's approved on GitHub, opening the release again merges it, and QA tests again
  delete gh.world.pulls.find((x) => x.number === pr.number).blocked;
  const retry = await openRelease(env, { items: [], actor: alice });
  assert.equal(retry.reused, true);
  assert.deepEqual(retry.retried.map((i) => i.ref), [`#${issue.number}`]);
  assert.deepEqual(retry.merges.results.map((r) => r.result), ["merged"]);
  assert.deepEqual(labelsOf(gh, issue), ["Staged"]);
  assert.equal(retry.retested, true);
  assert.equal(retry.record.state.status, "open");
  assert.match(gh.world.comments.at(-1).body, new RegExp(`Merged the PRs of #${issue.number} after regression started.*Tell QA again`));

  // With nothing left to merge, there's nothing to do
  assert.deepEqual(unmerged(retry.record), []);
  await assert.rejects(openRelease(env, { items: [], actor: alice }), /Pick at least one issue/);
});

test("a retry leaves alone an issue QA passed after its PR was merged by hand", async () => {
  const { gh, env } = setup();
  const issue = gh.addIssue({ title: "Needs review", labels: ["Ready for Staging"] });
  const pr = gh.addPull({ issue });
  gh.world.pulls.find((x) => x.number === pr.number).blocked = "At least 1 approving review is required";
  const { record } = await openRelease(env, { items: (await readyWork(env)).items, actor: alice });
  await announceRegression(env, record);

  // Someone merges it on GitHub, and QA passes it
  Object.assign(gh.world.pulls.find((x) => x.number === pr.number), { blocked: undefined, merged: true, state: "merged" });
  stored(gh, issue).labels = new Set(["Ready for Release"]);

  const late = gh.addIssue({ title: "Late fix", labels: ["Ready for Staging"] });
  gh.addPull({ issue: late });
  const added = await openRelease(env, { items: (await readyWork(env)).items, actor: alice });
  assert.deepEqual(added.retried.map((i) => i.ref), [`#${issue.number}`]);
  assert.deepEqual(added.merges.staged, [`#${late.number}`], "only the new work moves to Staged");
  assert.deepEqual(labelsOf(gh, issue), ["Ready for Release"]);
  assert.deepEqual(unmerged(added.record), [], "the merge is now on record, so it isn't retried again");
});

test("work added after regression started sends the release back to QA, so the tag includes it", async () => {
  const { gh, env } = setup();
  const one = gh.addIssue({ title: "First", labels: ["Ready for Staging"] });
  gh.addPull({ issue: one });
  const { record } = await openRelease(env, { items: (await readyWork(env)).items, actor: alice });
  await announceRegression(env, record);
  const firstTested = record.state.testedSha;

  const two = gh.addIssue({ title: "Late fix", labels: ["Ready for Staging"] });
  gh.addPull({ issue: two });
  const added = await openRelease(env, { items: (await readyWork(env)).items, actor: alice });
  assert.equal(added.reused, true);
  assert.equal(added.retested, true);
  assert.equal(added.record.state.testedSha, null, "the old tested commit doesn't hold the late fix");
  assert.equal(added.record.state.status, "open");
  assert.match(gh.world.comments.at(-1).body, new RegExp(`Added #${two.number} after regression started.*Tell QA again`));

  await announceRegression(env, added.record);
  assert.notEqual(added.record.state.testedSha, firstTested);
  for (const issue of [one, two]) stored(gh, issue).labels = new Set(["Ready for Release"]);
  await requestApproval(env, added.record, { actor: alice });
  const { release } = await decide(env, added.record, { actor: bob, verdict: "approved" });
  assert.equal(release.target_commitish, gh.head("main"), "the tag holds both merges");
});

test("nothing can be added to a release waiting for approval; new work opens a new release", async () => {
  const { gh, env } = setup();
  const done = gh.addIssue({ title: "Done", labels: ["Ready for Release"] });
  const { record } = await openRelease(env, { items: [itemOf(done)], actor: alice });
  await requestApproval(env, record, { actor: alice });
  const late = gh.addIssue({ title: "Late", labels: ["Ready for Staging"] });
  assert.equal((await readyWork(env)).waiting.state.tag, "production_v20261102_0");
  const fresh = await openRelease(env, { items: [itemOf(late)], actor: alice });
  assert.equal(fresh.reused, false);
  assert.equal(fresh.record.state.tag, "production_v20261102_1");
  assert.equal(fresh.waiting.state.tag, "production_v20261102_0", "the release that keeps its tested commit");
  assert.deepEqual((await findRelease(env, "production_v20261102_0")).state.items.map((i) => i.ref), ["#1"]);

  // From now on new work joins the second release, not the one waiting
  const later = gh.addIssue({ title: "Later", labels: ["Ready for Staging"] });
  assert.equal((await readyWork(env)).current.state.tag, "production_v20261102_1");
  assert.equal((await openRelease(env, { items: [itemOf(later)], actor: alice })).record.state.tag, "production_v20261102_1");
});

test("without a tag, each step means the release it can act on", async () => {
  const { gh, env } = setup();
  const first = gh.addIssue({ title: "First", labels: ["Ready for Release"] });
  const { record } = await openRelease(env, { items: [itemOf(first)], actor: alice });
  assert.deepEqual((await releasesFor(env, "announce")).map((r) => r.state.tag), ["production_v20261102_0"]);
  await assert.rejects(releasesFor(env, "approve"), /Nobody has asked to publish a Web App release yet/);
  await assert.rejects(releasesFor(env, "watch"), /Web App has no published release to watch/);

  await announceRegression(env, record);
  await requestApproval(env, record, { actor: alice });
  const second = gh.addIssue({ title: "Second", labels: ["Ready for Staging"] });
  await openRelease(env, { items: [itemOf(second)], actor: alice });
  // Telling QA means the new release, and approving the one waiting
  assert.deepEqual((await releasesFor(env, "announce")).map((r) => r.state.tag), ["production_v20261102_1"]);
  assert.deepEqual((await releasesFor(env, "request")).map((r) => r.state.tag), ["production_v20261102_1"]);
  assert.deepEqual((await releasesFor(env, "approve")).map((r) => r.state.tag), ["production_v20261102_0"]);
  assert.deepEqual((await releasesFor(env, "unlock")).map((r) => r.state.tag), ["production_v20261102_1", "production_v20261102_0"]);
});

test("in a direct release, added work moves the tested commit forward", async () => {
  const { gh, env } = setup({ steps: "direct-release" });
  gh.addIssue({ title: "First", labels: ["Ready for Staging"] });
  await openRelease(env, { items: (await readyWork(env)).items, actor: alice });
  gh.commit("main"); // the second issue's work
  const two = gh.addIssue({ title: "Second", labels: ["Ready for Staging"] });
  const added = await openRelease(env, { items: (await readyWork(env)).items, actor: alice });
  assert.equal(added.record.state.testedSha, gh.head("main"));
  assert.deepEqual(labelsOf(gh, two), ["Ready for Release"]);
  await assert.rejects(announceRegression(env, added.record), /no regression step/);
});

test("asking for approval needs a person, so nobody approves a request they made signed out", async () => {
  const { gh, env } = setup();
  const done = gh.addIssue({ title: "Done", labels: ["Ready for Release"] });
  const { record } = await openRelease(env, { items: [itemOf(done)], actor: alice });
  await assert.rejects(requestApproval(env, record, { actor: APP_ACTOR }), /needs a person/);
  assert.equal(record.state.approval, null);
});

test("approving checks QA again, in case an issue was moved back after the request", async () => {
  const { gh, env } = setup();
  const done = gh.addIssue({ title: "Done", labels: ["Ready for Release"] });
  const { record } = await openRelease(env, { items: [itemOf(done)], actor: alice });
  await requestApproval(env, record, { actor: alice });
  stored(gh, done).labels = new Set(["Staged"]);
  await assert.rejects(decide(env, record, { actor: bob, verdict: "approved" }), /isn't ready any more: #1 is in Staged/);
  assert.equal(record.state.status, "awaiting_approval");
  assert.equal(gh.world.releases.length, 0);
  stored(gh, done).labels = new Set(["Ready for Release"]);
  await decide(env, record, { actor: bob, verdict: "approved" });
  assert.equal(record.state.status, "published");
});

test("a plain issue its PR closed still needs QA; one closed with no status label is done", async () => {
  const { gh, env } = setup();
  const byPr = gh.addIssue({ title: "Closed by its PR", labels: ["Staged"], state: "closed" });
  const byHand = gh.addIssue({ title: "Closed by QA", labels: [], state: "closed" });
  const { record } = await openRelease(env, { items: [itemOf(byPr), itemOf(byHand)], actor: alice });
  const check = await readiness(env, record);
  assert.deepEqual(check.notReady.map((i) => `${i.ref} ${i.status}`), ["#1 Staged"]);
});

test("a lock only counts from AKO's app or someone with access to the repo", async () => {
  const { gh, env, project } = setup();
  const done = gh.addIssue({ title: "Done", labels: ["Ready for Release"] });
  const { record } = await openRelease(env, { items: [itemOf(done)], actor: alice });
  const lock = { holder: "anyone", expires: "2999-01-01T00:00:00.000Z" };
  const forged = {
    id: 999,
    issue: record.issue,
    body: `<!-- ako-lock ${JSON.stringify(lock)} -->`,
    user: { login: "stranger", type: "User" },
    author_association: "NONE",
    created_at: "2000-01-01T00:00:00Z",
  };
  gh.world.comments.push(forged);
  assert.equal(await env.store.withLock(record, "terminal:alice", async () => "went ahead"), "went ahead");

  // The same comment from the app's own account, or from a member, holds
  forged.user = { login: "my-ako[bot]", type: "Bot" };
  const person = createStore(gh, project, { botLogin: "my-ako[bot]" });
  await assert.rejects(person.withLock(record, "terminal:alice", async () => "never"), LockedError);
  forged.user = { login: "lena", type: "User" };
  forged.author_association = "MEMBER";
  await assert.rejects(env.store.withLock(record, "terminal:alice", async () => "never"), LockedError);
});

test("a release is approved where it was asked for, since a GitHub login and a Slack user can't be matched", async () => {
  const { gh, env } = setup({ people: { release_managers: { github: ["bob"], slack: ["U000000009"] } } });
  const issue = gh.addIssue({ title: "Done", labels: ["Ready for Release"] });
  const { record } = await openRelease(env, { items: [itemOf(issue)], actor: alice });

  await requestApproval(env, record, { actor: alice });
  assert.match(gh.world.comments.at(-1).body, /^@bob: @alice asks to publish .* A release manager approves from the terminal with `npx ako release approve production_v20261102_0`/);
  await assert.rejects(
    decide(env, record, { actor: slackActor("U000000009"), verdict: "approved" }),
    /was asked for from the terminal, so a release manager approves it there/,
  );

  // A hold stops a release, so it may come from either place
  await decide(env, record, { actor: slackActor("U000000009"), verdict: "hold" });
  assert.equal(record.state.status, "on_hold");

  // Asked again in Slack, it's approved in Slack and not from the terminal
  await requestApproval(env, record, { actor: slackActor("U000000001") });
  await assert.rejects(decide(env, record, { actor: bob, verdict: "approved" }), /was asked for in Slack/);
  await decide(env, record, { actor: slackActor("U000000009"), verdict: "approved" });
  assert.equal(record.state.status, "published");
});

test("asking for approval is refused where nobody could give it", async () => {
  const { gh, env } = setup({ people: { release_managers: { slack: ["U000000009"] } } });
  const issue = gh.addIssue({ title: "Done", labels: ["Ready for Release"] });
  const { record } = await openRelease(env, { items: [itemOf(issue)], actor: alice });
  await assert.rejects(
    requestApproval(env, record, { actor: alice }),
    /Web App lists no release managers on GitHub, and a release is approved where it was asked for\. Ask in Slack instead\./,
  );
  assert.equal(record.state.status, "open");
  await requestApproval(env, record, { actor: slackActor("U000000001") });
  assert.equal(record.state.status, "awaiting_approval");
});
