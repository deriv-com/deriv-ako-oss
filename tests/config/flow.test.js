import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFlow, validateFlow, STEPS, STEP_PRESETS, loadFlow, FlowError } from "../../src/config/flow.js";

const minimal = () => ({
  version: 1,
  projects: [
    {
      key: "web-app",
      repo: "acme/web-app",
      tracker: {
        type: "github-projects",
        number: 3,
        statuses: { ready: "Ready", staged: "Staged", ready_for_release: "Ready for Release", done: "Done" },
      },
      people: { release_managers: { github: ["alice"] } },
    },
  ],
});

function errorsOf(raw) {
  return validateFlow(raw).errors.join("\n");
}

test("every example flow file is valid", () => {
  const dir = new URL("../../examples/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
  assert.ok(files.length >= 3);
  for (const file of files) {
    const { errors, warnings } = parseFlow(readFileSync(new URL(file, dir), "utf8"));
    assert.deepEqual(errors, [], file);
    assert.deepEqual(warnings, [], file);
  }
});

test("a minimal project gets the defaults", () => {
  const { flow, errors } = validateFlow(minimal());
  assert.deepEqual(errors, []);
  const [project] = flow.projects;
  assert.equal(project.name, "web-app");
  assert.deepEqual(project.steps, STEPS);
  assert.equal(project.approval, "others");
  assert.deepEqual(project.release, { type: "tag", tag_prefix: "production_v", branch: null, merge_method: "squash" });
  assert.deepEqual(project.deploy, { type: "none" });
  assert.equal(project.tracker.owner, "acme");
  assert.equal(project.tracker.status_field, "Status");
  assert.deepEqual(project.tracker.statuses.ready, ["Ready"]);
});

test("version must be 1", () => {
  assert.match(errorsOf({ ...minimal(), version: undefined }), /`version` is missing/);
  assert.match(errorsOf({ ...minimal(), version: 2 }), /not supported/);
});

test("YAML syntax and duplicate keys are reported, not thrown", () => {
  assert.match(parseFlow("version: 1\nversion: 1\nprojects: []").errors[0], /YAML/);
  assert.match(parseFlow("projects: [").errors[0], /YAML/);
});

test("hostile YAML is reported, not thrown", () => {
  // Deeply nested collections: yaml >= 2.8.3 turns the stack overflow into a
  // parse error (GHSA-48c2-rrv3-qjmp).
  const deep = `version: 1\nprojects: ${"[".repeat(10000)}${"]".repeat(10000)}\n`;
  assert.match(parseFlow(deep).errors[0], /^YAML: /);

  // Alias expansion ("billion laughs"): toJS() throws on this one.
  const names = "abcdefghi";
  const bomb = [
    "version: 1",
    "a: &a [x, x, x, x, x, x, x, x, x]",
    ...[...names.slice(1)].map((n, i) => `${n}: &${n} [${Array(9).fill(`*${names[i]}`).join(", ")}]`),
    "projects: []",
  ].join("\n");
  assert.match(parseFlow(bomb).errors[0], /^YAML: .*alias/i);
  const path = join(mkdtempSync(join(tmpdir(), "ako-flow-")), "release-flow.yaml");
  writeFileSync(path, bomb);
  assert.throws(() => loadFlow(path), FlowError);
});

test("steps must keep their order and include the core steps", () => {
  const out = minimal();
  out.projects[0].steps = ["open_release", "pick_issues", "approval", "publish"];
  assert.match(errorsOf(out), /must keep this order/);

  out.projects[0].steps = ["pick_issues", "open_release", "publish"];
  assert.match(errorsOf(out), /`approval` step is required/);

  out.projects[0].steps = ["pick_issues", "open_release", "approval", "publish", "deploy_to_moon"];
  assert.match(errorsOf(out), /unknown step "deploy_to_moon"/);
});

test("step presets expand to lists", () => {
  const out = minimal();
  out.projects[0].steps = "direct-release";
  const { flow, errors } = validateFlow(out);
  assert.deepEqual(errors, []);
  assert.deepEqual(flow.projects[0].steps, STEP_PRESETS["direct-release"]);
  assert.ok(!flow.projects[0].steps.includes("merge_prs"));
});

test("a release-branch release needs two different branches", () => {
  const out = minimal();
  out.projects[0].release = { type: "release-branch", from: "staging" };
  assert.match(errorsOf(out), /needs `release.from`.*and `release.to`/);
  out.projects[0].release = { type: "release-branch", from: "main", to: "main" };
  assert.match(errorsOf(out), /must be different/);
  out.projects[0].release = { type: "release-branch", from: "staging", to: "main" };
  const { flow, errors } = validateFlow(out);
  assert.deepEqual(errors, []);
  assert.equal(flow.projects[0].release.branch, "staging");
});

test("each deploy type needs its field", () => {
  const out = minimal();
  out.projects[0].deploy = { type: "actions" };
  assert.match(errorsOf(out), /deploy.workflow/);
  out.projects[0].deploy = { type: "commit-status" };
  assert.match(errorsOf(out), /deploy.context/);
  out.projects[0].deploy = { type: "check-run" };
  assert.match(errorsOf(out), /deploy.check/);
  out.projects[0].deploy = { type: "ftp" };
  assert.match(errorsOf(out), /deploy.type/);
});

test("watching a deploy with nothing to watch is a warning", () => {
  const { warnings } = validateFlow(minimal());
  assert.ok(warnings.some((w) => /watch_deploy/.test(w)));
});

test("approval by others needs a release manager", () => {
  const out = minimal();
  out.projects[0].people = {};
  assert.match(errorsOf(out), /at least one release manager/);
  out.projects[0].approval = "self";
  assert.deepEqual(validateFlow(out).errors, []);
});

test("people are stored as IDs, not names", () => {
  const out = minimal();
  out.projects[0].people.release_managers.slack = ["Alice Example"];
  assert.match(errorsOf(out), /not a Slack user ID/);
  out.projects[0].people.release_managers = { github: ["not a login!"] };
  assert.match(errorsOf(out), /not a GitHub username/);
  out.projects[0].people.release_managers = { teams: ["x"] };
  assert.match(errorsOf(out), /unknown/);
});

test("trackers check their own fields", () => {
  const out = minimal();
  delete out.projects[0].tracker.number;
  assert.match(errorsOf(out), /tracker.number/);

  out.projects[0].tracker = { type: "clickup", list: "not-an-id", statuses: { ready: "a", ready_for_release: "b", done: "c" } };
  assert.match(errorsOf(out), /ClickUp list ID/);

  out.projects[0].tracker = { type: "jira", statuses: {} };
  assert.match(errorsOf(out), /tracker.type/);
});

test("archive needs a done status", () => {
  const out = minimal();
  delete out.projects[0].tracker.statuses.done;
  assert.match(errorsOf(out), /needs `tracker.statuses.done`/);
});

test("duplicate keys fail and shared aliases warn", () => {
  const out = minimal();
  out.projects.push({ ...structuredClone(out.projects[0]) });
  assert.match(errorsOf(out), /listed twice/);

  out.projects[1].key = "web-v2";
  out.projects[1].aliases = ["Web-App"];
  const { errors, warnings } = validateFlow(out);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => /names both "web-app" and "web-v2"/.test(w)));
});

test("defaults merge per section", () => {
  const out = minimal();
  out.defaults = { approval: "self", deploy: { type: "actions", workflow: "deploy.yml" }, release: { tag_prefix: "v" } };
  out.projects[0].release = { branch: "main" };
  const { flow, errors } = validateFlow(out);
  assert.deepEqual(errors, []);
  assert.equal(flow.projects[0].approval, "self");
  assert.equal(flow.projects[0].deploy.workflow, "deploy.yml");
  assert.deepEqual(flow.projects[0].release, { type: "tag", tag_prefix: "v", branch: "main", merge_method: "squash" });
});

test("loadFlow throws a FlowError naming the file", () => {
  assert.throws(() => loadFlow("/no/such/release-flow.yaml"), (error) => error instanceof FlowError && /npx ako setup/.test(error.message));
});
