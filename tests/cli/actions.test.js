import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFlow } from "../../src/config/flow.js";
import { createStore } from "../../src/engine/store.js";
import { createTracker } from "../../src/trackers/index.js";
import { githubActor, APP_ACTOR } from "../../src/engine/people.js";
import { runRequest } from "../../src/cli/actions.js";
import { parseReleaseArgs } from "../../src/cli/commands.js";
import { scriptedPrompter } from "../../src/setup/prompts.js";
import { fakeGitHub } from "../helpers/fakeGitHub.js";

const NOV_2 = Date.UTC(2026, 10, 2, 9, 0, 0);

function workspace({ actor = githubActor("bob"), slack = null } = {}) {
  const { flow } = validateFlow({
    version: 1,
    projects: [
      {
        key: "web-app",
        name: "Web App",
        aliases: ["web"],
        repo: "acme/web-app",
        tracker: { type: "github-issues", statuses: { ready: "Ready for Staging", staged: "Staged", ready_for_release: "Ready for Release", done: "closed" } },
        deploy: { type: "actions", workflow: "deploy.yml" },
        people: { release_managers: { github: ["bob"], slack: ["U000000002"] }, qa: { slack: ["S000000003"] } },
        slack: { announce_channel: "C000000001" },
      },
      {
        key: "api",
        name: "API",
        repo: "acme/api",
        release: { tag_prefix: "api_v" },
        tracker: { type: "github-issues", statuses: { ready: "Ready", ready_for_release: "Ready for Release" } },
        people: { release_managers: { github: ["bob"] } },
      },
    ],
  });
  const gh = fakeGitHub();
  let clock = NOV_2;
  const ws = {
    flow,
    actor,
    slack,
    findProject: (name) => flow.projects.find((p) => [p.key, p.name, ...p.aliases].some((n) => n.toLowerCase() === String(name).toLowerCase())) ?? null,
    async envFor(project) {
      return {
        project,
        gh,
        slack,
        tracker: createTracker(project, { gh }),
        store: createStore(gh, project, { now: () => clock }),
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        },
      };
    },
  };
  return { ws, gh };
}

function fakeSlack() {
  const posts = [];
  return {
    posts,
    async call(method, params) {
      assert.equal(method, "chat.postMessage");
      posts.push(params);
      return { ts: `1.${posts.length}` };
    },
  };
}

const text = (p) => p.output.join("");

test("release arguments: action, tag or project, and options", () => {
  assert.deepEqual(parseReleaseArgs(["create", "web", "--items", "1,#3", "--new", "--yes"]), {
    action: "create", project: "web", tag: null, items: ["1", "#3"], all: false, newRelease: true, note: null, yes: true,
  });
  const hold = parseReleaseArgs(["hold", "production_v20261102_0", "--note", "backend not ready"]);
  assert.equal(hold.tag, "production_v20261102_0");
  assert.equal(hold.project, null);
  assert.equal(hold.note, "backend not ready");
});

test("the terminal runs a release: pick issues, tell QA, ask, approve, watch", async () => {
  const slack = fakeSlack();
  const { ws, gh } = workspace({ actor: githubActor("alice"), slack });
  const one = gh.addIssue({ title: "Fix the payout label", labels: ["Ready for Staging"] });
  gh.addIssue({ title: "Landscape message", labels: ["Ready for Staging"] });
  gh.addPull({ issue: one });

  // Which project? Then pick only the first issue, and tell QA
  let p = scriptedPrompter(["1", "1", "y"]);
  assert.deepEqual((await runRequest(ws, { action: "create" }, p)).ok, true);
  assert.match(text(p), /Opened production_v20261102_0 with 1 issue\(s\)/);
  assert.match(text(p), /Merged PR #\d+ \(for #1\)/);
  assert.match(text(p), /Told QA on the tracking issue/);
  assert.match(slack.posts[0].text, /^<!subteam\^S000000003> Regression can start on staging for `production_v20261102_0`/);

  // Asking is blocked until QA passes the issue
  p = scriptedPrompter([]);
  assert.equal((await runRequest(ws, { action: "request", tag: "production_v20261102_0" }, p)).ok, false);
  assert.match(text(p), /#1 Fix the payout label \(Staged\)/);

  gh.world.issues.find((i) => i.number === one.number).labels = new Set(["Ready for Release"]);
  p = scriptedPrompter([]);
  assert.equal((await runRequest(ws, { action: "request", tag: "production_v20261102_0" }, p)).ok, true);
  assert.match(slack.posts[1].text, /<@U000000002> @alice asks to publish/);
  assert.equal(slack.posts[1].thread_ts, "1.1", "follow-ups go in the release's thread");

  // Bob approves from his own terminal, watches the deploy, and leaves archiving for later
  const bob = workspace({ actor: githubActor("bob"), slack });
  bob.ws.envFor = ws.envFor;
  gh.world.runs.push({ workflow: "deploy.yml", tag: "production_v20261102_0", status: "completed", conclusion: "success", html_url: "https://run/9" });
  p = scriptedPrompter(["y", "y", "n"]);
  assert.equal((await runRequest(bob.ws, { action: "approve", tag: "production_v20261102_0" }, p)).ok, true);
  assert.match(text(p), /Published production_v20261102_0: https:\/\/github.com\/acme\/web-app\/releases\/tag\/production_v20261102_0/);
  assert.match(text(p), /Deployed production_v20261102_0: https:\/\/run\/9/);
  assert.equal(p.remaining(), 0);
  assert.deepEqual(slack.posts.slice(2).map((m) => m.text.split(":")[0]), ["Released `production_v20261102_0` (Web App)", "Deployed `production_v20261102_0` (Web App) https"]);
});

test("a tag finds its project by prefix, and an unknown project is named", async () => {
  const { ws } = workspace();
  let p = scriptedPrompter([]);
  await runRequest(ws, { action: "status", tag: "api_v20261102_0" }, p);
  assert.match(text(p), /There.s no release `api_v20261102_0` for API\./, "the api_v prefix picked the API project");

  p = scriptedPrompter([]);
  assert.equal((await runRequest(ws, { action: "ready", project: "mobile" }, p)).ok, false);
  assert.match(text(p), /There's no project "mobile". Projects: web-app, api/);
});

test("approving needs a personal sign-in, so GitHub records who approved", async () => {
  const { ws } = workspace({ actor: APP_ACTOR });
  const p = scriptedPrompter([]);
  assert.equal((await runRequest(ws, { action: "approve", project: "web", tag: "production_v20261102_0" }, p)).ok, false);
  assert.match(text(p), /Run `npx ako login` first/);
});

test("--items and --yes run without questions, and a failed merge says how to retry", async () => {
  const { ws, gh } = workspace();
  const one = gh.addIssue({ title: "Blocked PR", labels: ["Ready for Staging"] });
  const pr = gh.addPull({ issue: one });
  gh.world.pulls.find((x) => x.number === pr.number).blocked = "Required status check \"test\" is failing";
  gh.addIssue({ title: "Left out", labels: ["Ready for Staging"] });
  const p = scriptedPrompter([]);
  await runRequest(ws, { action: "create", project: "web", items: [String(one.number)], yes: true }, p);
  assert.match(text(p), /Opened production_v20261102_0 with 1 issue\(s\)/);
  assert.match(text(p), /✗ PR #\d+ \(for #1\) not merged: Required status check "test" is failing/);
  assert.match(text(p), /run `npx ako release create web-app` again to retry/);
});

test("a skipped hand-off says how to do it later; asking for approval needs a sign-in", async () => {
  const { ws, gh } = workspace({ actor: APP_ACTOR });
  const one = gh.addIssue({ title: "Fix the payout label", labels: ["Ready for Staging"] });
  gh.addPull({ issue: one });

  // Keep the picked issue, then don't tell QA yet
  let p = scriptedPrompter(["", "n"]);
  await runRequest(ws, { action: "create", project: "web" }, p);
  assert.match(text(p), /Tell QA later with: npx ako release announce web-app/);

  p = scriptedPrompter([]);
  assert.equal((await runRequest(ws, { action: "announce", tag: "production_v20261102_0" }, p)).ok, true);
  assert.match(text(p), /Told QA on the tracking issue: regression can start at commit \w{7}/);

  gh.world.issues.find((i) => i.number === one.number).labels = new Set(["Ready for Release"]);
  p = scriptedPrompter([]);
  assert.equal((await runRequest(ws, { action: "request", tag: "production_v20261102_0" }, p)).ok, false);
  assert.match(text(p), /Asking for approval needs your own GitHub sign-in.*Run `npx ako login` first/);
});

test("without a tag, each step finds the release it can act on, and new work waits for the next one", async () => {
  const { ws, gh } = workspace({ actor: githubActor("alice") });
  const one = gh.addIssue({ title: "Fix the payout label", labels: ["Ready for Staging"] });
  gh.addPull({ issue: one });
  let p = scriptedPrompter([]);
  await runRequest(ws, { action: "create", project: "web", items: [String(one.number)], yes: true }, p);
  gh.world.issues.find((i) => i.number === one.number).labels = new Set(["Ready for Release"]);
  p = scriptedPrompter([]);
  assert.equal((await runRequest(ws, { action: "request", project: "web" }, p)).ok, true);
  assert.match(text(p), /Asked the release managers to approve production_v20261102_0/);

  // The first release waits for approval at its tested commit, so new work opens the next one
  const tested = gh.head("main");
  const two = gh.addIssue({ title: "Landscape message", labels: ["Ready for Staging"] });
  gh.addPull({ issue: two });
  p = scriptedPrompter(["", "n"]);
  await runRequest(ws, { action: "create", project: "web" }, p);
  assert.match(text(p), /Opened production_v20261102_1 with 1 issue\(s\)/);
  assert.match(text(p), new RegExp(`production_v20261102_0 is waiting for approval and still ships only its tested commit ${tested.slice(0, 7)}\\. This work goes out with production_v20261102_1\\.`));
  assert.ok(!p.asked.some((q) => /new release/i.test(q)), "no question about adding or opening");

  // "Tell QA" means the release QA hasn't heard about; "approve" the one waiting
  p = scriptedPrompter([]);
  await runRequest(ws, { action: "announce", project: "web" }, p);
  assert.match(text(p), /Told QA/);
  assert.match(gh.world.comments.filter((c) => /Regression can start/i.test(c.body)).at(-1).body, /production_v20261102_1/);

  const bob = workspace({ actor: githubActor("bob") });
  bob.ws.envFor = ws.envFor;
  p = scriptedPrompter(["y", "n"]);
  assert.equal((await runRequest(bob.ws, { action: "approve", project: "web" }, p)).ok, true);
  assert.match(text(p), /Published production_v20261102_0/);
});

test("when several releases fit, the terminal asks, and --yes names them instead", async () => {
  const { ws, gh } = workspace({ actor: githubActor("alice") });
  for (const title of ["First", "Second"]) {
    const issue = gh.addIssue({ title, labels: ["Ready for Staging"] });
    gh.addPull({ issue });
    await runRequest(ws, { action: "create", project: "web", items: [String(issue.number)], newRelease: true, yes: true }, scriptedPrompter([]));
  }

  let p = scriptedPrompter([]);
  assert.equal((await runRequest(ws, { action: "request", project: "web", yes: true }, p)).ok, false);
  assert.match(text(p), /2 Web App releases could be meant: production_v20261102_1, production_v20261102_0\. Name one/);

  p = scriptedPrompter(["2"]);
  await runRequest(ws, { action: "request", project: "web" }, p);
  assert.match(text(p), /Which Web App release\?\n  1\) production_v20261102_1: in regression, 1 issue\(s\)\n  2\) production_v20261102_0/);
  assert.match(text(p), /Not everything in production_v20261102_0 is ready/);

  p = scriptedPrompter([]);
  assert.equal((await runRequest(ws, { action: "approve", project: "web" }, p)).ok, false);
  assert.match(text(p), /Nobody has asked to publish a Web App release yet/);
});

test("a step that needs a person offers to sign in, and goes on once signed in", async () => {
  const { ws, gh } = workspace({ actor: APP_ACTOR });
  const one = gh.addIssue({ title: "Fix the payout label", labels: ["Ready for Staging"] });
  gh.addPull({ issue: one });
  await runRequest(ws, { action: "create", project: "web", items: [String(one.number)], yes: true }, scriptedPrompter([]));
  gh.world.issues.find((i) => i.number === one.number).labels = new Set(["Ready for Release"]);
  ws.signIn = async () => {
    ws.actor = githubActor("alice");
    return true;
  };

  let p = scriptedPrompter(["n"]);
  assert.equal((await runRequest(ws, { action: "request", project: "web" }, p)).ok, false);
  assert.match(text(p), /^Asking for approval needs your own GitHub sign-in/);

  p = scriptedPrompter(["y"]);
  assert.equal((await runRequest(ws, { action: "request", project: "web" }, p)).ok, true);
  assert.match(text(p), /Asked the release managers to approve production_v20261102_0/);
});

test("create retries the PRs that didn't merge, and tells QA again when that changes what they tested", async () => {
  const { ws, gh } = workspace({ actor: githubActor("alice") });
  const one = gh.addIssue({ title: "Needs review", labels: ["Ready for Staging"] });
  const pr = gh.addPull({ issue: one });
  gh.world.pulls.find((x) => x.number === pr.number).blocked = "At least 1 approving review is required";
  let p = scriptedPrompter([]);
  await runRequest(ws, { action: "create", project: "web", items: [String(one.number)], yes: true }, p);
  assert.match(text(p), /not merged: At least 1 approving review is required[\s\S]*run `npx ako release create web-app` again to retry/);

  delete gh.world.pulls.find((x) => x.number === pr.number).blocked;
  p = scriptedPrompter(["y"]);
  assert.equal((await runRequest(ws, { action: "create", project: "web" }, p)).ok, true);
  assert.match(text(p), /^Nothing new is ready in Web App, so this retries the PRs of #1 in production_v20261102_0\./);
  assert.match(text(p), /Retried the merges in production_v20261102_0\.[\s\S]*Merged PR #\d+ \(for #1\)/);
  assert.match(text(p), /The new work came after the commit QA was testing, so tell QA again[\s\S]*Told QA/);

  // Nothing left to retry, and nothing new
  p = scriptedPrompter([]);
  assert.equal((await runRequest(ws, { action: "create", project: "web" }, p)).ok, false);
  assert.match(text(p), /Nothing is ready to release in Web App/);
});

test("approving says why not before asking anything, and an archived release says it's already out", async () => {
  const { ws, gh } = workspace({ actor: githubActor("alice") });
  const one = gh.addIssue({ title: "Fix the payout label", labels: ["Ready for Staging"] });
  gh.addPull({ issue: one });
  await runRequest(ws, { action: "create", project: "web", items: [String(one.number)], yes: true }, scriptedPrompter([]));
  gh.world.issues.find((i) => i.number === one.number).labels = new Set(["Ready for Release"]);
  await runRequest(ws, { action: "request", project: "web" }, scriptedPrompter([]));

  // Alice isn't a release manager: she's told so, and asked nothing
  let p = scriptedPrompter([]);
  assert.equal((await runRequest(ws, { action: "approve", project: "web" }, p)).ok, false);
  assert.match(text(p), /@alice isn't a release manager for Web App\. They are: bob\./);
  assert.deepEqual(p.asked, []);
  p = scriptedPrompter([]);
  assert.equal((await runRequest(ws, { action: "hold", project: "web" }, p)).ok, false);
  assert.deepEqual(p.asked, [], "no reason is asked for a hold that can't happen");

  // Bob publishes and archives; approving again is refused before any question
  const bob = workspace({ actor: githubActor("bob") });
  bob.ws.envFor = ws.envFor;
  await runRequest(bob.ws, { action: "approve", project: "web" }, scriptedPrompter(["y", "n"]));
  await runRequest(bob.ws, { action: "archive", project: "web" }, scriptedPrompter([]));
  p = scriptedPrompter([]);
  assert.equal((await runRequest(bob.ws, { action: "approve", tag: "production_v20261102_0" }, p)).ok, false);
  assert.match(text(p), /`production_v20261102_0` is already published and archived\./);
  assert.deepEqual(p.asked, []);
});
