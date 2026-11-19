import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFlow } from "../../src/config/flow.js";
import { createStore } from "../../src/engine/store.js";
import { createTracker } from "../../src/trackers/index.js";
import { githubActor } from "../../src/engine/people.js";
import { readyWork, openRelease, announceRegression, requestApproval, decide, archive } from "../../src/engine/release.js";
import { fakeGitHub } from "../helpers/fakeGitHub.js";

const NOV_2 = Date.UTC(2026, 10, 2, 9, 0, 0);

// An in-memory ClickUp: tasks with statuses, links, comments and custom fields.
function fakeClickUp() {
  const tasks = new Map();
  const calls = [];
  let nextId = 100;
  const add = (task) => {
    const id = task.id ?? `t${nextId++}`;
    tasks.set(id, { id, url: `https://app.clickup.com/t/${id}`, links: [], comments: [], custom_fields: [], ...task, status: { status: task.status ?? "to do", type: task.type ?? "custom" } });
    return tasks.get(id);
  };
  async function request(method, path, body) {
    calls.push({ method, path, body });
    let m;
    if (method === "GET" && (m = path.match(/^\/list\/(\d+)\/task\?(.*)$/))) {
      const wanted = new URLSearchParams(m[2]).getAll("statuses[]").map((s) => s.toLowerCase());
      return { tasks: [...tasks.values()].filter((t) => t.list === m[1] && wanted.includes(t.status.status.toLowerCase())), last_page: true };
    }
    if (method === "GET" && (m = path.match(/^\/task\/([^/?]+)/))) return tasks.get(m[1]);
    if (method === "POST" && (m = path.match(/^\/list\/(\d+)\/task$/))) return add({ name: body.name, list: m[1], description: body.description });
    if (method === "POST" && (m = path.match(/^\/task\/([^/]+)\/link\/([^/]+)$/))) return tasks.get(m[1]).links.push(m[2]) && {};
    if (method === "POST" && (m = path.match(/^\/task\/([^/]+)\/comment$/))) return tasks.get(m[1]).comments.push(body.comment_text) && {};
    if (method === "PUT" && (m = path.match(/^\/task\/([^/]+)$/))) {
      tasks.get(m[1]).status = { status: body.status, type: "custom" };
      return tasks.get(m[1]);
    }
    throw new Error(`Unrouted ClickUp ${method} ${path}`);
  }
  return { request, add, tasks, calls };
}

test("a ClickUp project: tasks are picked from the list, linked to a release task and moved by status", async () => {
  const gh = fakeGitHub();
  const clickup = fakeClickUp();
  const { flow, errors } = validateFlow({
    version: 1,
    projects: [
      {
        key: "web-app",
        name: "Web App",
        repo: "acme/web-app",
        tracker: { type: "clickup", list: "901", release_list: "902", statuses: { ready: "Ready for Staging", staged: "Staged", ready_for_release: "Ready for Release", done: "Released" } },
        people: { release_managers: { github: ["bob"] } },
      },
    ],
  });
  assert.deepEqual(errors, []);
  const project = flow.projects[0];

  const issue = gh.addIssue({ title: "Fix the payout label" });
  const pr = gh.addPull({ issue });
  const task = clickup.add({ name: "Fix the payout label", list: "901", status: "ready for staging", markdown_description: `PR: https://github.com/acme/web-app/pull/${pr.number}` });
  clickup.add({ name: "Not ready", list: "901", status: "in progress" });

  const env = { project, gh, tracker: createTracker(project, { gh, clickup }), store: createStore(gh, project, { now: () => NOV_2 }), now: () => NOV_2 };
  const { items } = await readyWork(env);
  assert.deepEqual(items.map((i) => i.title), ["Fix the payout label"]);

  const { record, merges } = await openRelease(env, { items, actor: githubActor("alice") });
  const releaseTask = clickup.tasks.get(record.state.trackerRelease.task);
  assert.equal(releaseTask.name, "production_v20261102_0");
  assert.equal(releaseTask.list, "902");
  assert.deepEqual(task.links, [releaseTask.id]);
  assert.deepEqual(merges.results.map((r) => r.result), ["merged"]);
  assert.equal(task.status.status, "Staged");

  await announceRegression(env, record);
  assert.deepEqual(releaseTask.comments, ["Regression can start for production_v20261102_0."]);

  // ClickUp keeps status names in lower case, so the comparison ignores case
  task.status = { status: "ready for release", type: "custom" };
  const asked = await requestApproval(env, record, { actor: githubActor("alice") });
  assert.equal(asked.blocked, undefined);
  await decide(env, record, { actor: githubActor("bob"), verdict: "approved" });

  await archive(env, record, { actor: githubActor("bob") });
  assert.equal(task.status.status, "Released");
});
