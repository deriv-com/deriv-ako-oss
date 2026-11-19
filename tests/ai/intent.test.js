import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRequest, projectIn, validateIntent, understand } from "../../src/ai/intent.js";
import { fakeFetch } from "../helpers/fakes.js";

const projects = [
  { key: "web-app", name: "Web App", aliases: ["web"] },
  { key: "web-app-mobile", name: "Web App Mobile", aliases: [] },
  { key: "api", name: "API", aliases: ["backend"] },
];
const ai = { apiKey: "sk-test", baseUrl: "https://ai.test/v1", model: "small" };

test("plain wording is read without AI", () => {
  const cases = [
    ["what's ready for web?", { action: "ready", project: "web-app", tag: null }],
    ["create release for Web App Mobile", { action: "create", project: "web-app-mobile", tag: null }],
    ["start a new release for the backend", { action: "create", project: "api", tag: null }],
    ["status of api", { action: "status", project: "api", tag: null }],
    ["production_v20261102_0 is ready for release", { action: "request", project: null, tag: "production_v20261102_0" }],
    ["regression passed, request approval for `production_v20261102_1`", { action: "request", project: null, tag: "production_v20261102_1" }],
    ["can you ask the release managers to approve production_v20261102_0", { action: "request", project: null, tag: "production_v20261102_0" }],
    ["tell QA regression can start for production_v20261102_0", { action: "announce", project: null, tag: "production_v20261102_0" }],
    ["start regression for web", { action: "announce", project: "web-app", tag: null }],
    ["approve production_v20261102_0", { action: "approve", project: null, tag: "production_v20261102_0" }],
    ["yes, approve it", { action: "approve", project: null, tag: null }],
    ["LGTM", { action: "approve", project: null, tag: null }],
    ["hold production-20261027_0 until the payments fix lands", { action: "hold", project: null, tag: "production-20261027_0" }],
    ["did it deploy?", { action: "watch", project: null, tag: null }],
    ["archive api_v20261101_3", { action: "archive", project: null, tag: "api_v20261101_3" }],
    ["help", { action: "help", project: null, tag: null }],
  ];
  for (const [text, expected] of cases) assert.deepEqual(parseRequest(text, projects), expected, text);
  assert.equal(parseRequest("how's the weather", projects), null);
});

test("mentioning approval isn't approving: no questions, no negations, no asking others", () => {
  for (const text of ["don't approve until the fix lands", "who can approve this?", "approve production_v20261102_0?", "please don't approve yet"]) {
    assert.notEqual(parseRequest(text, projects)?.action, "approve", text);
  }
});

test("a project is matched as a whole name, longest first", () => {
  assert.equal(projectIn("release web-app-mobile", projects), "web-app-mobile");
  assert.equal(projectIn("release web-app", projects), "web-app");
  assert.equal(projectIn("release webapp", projects), null);
  assert.equal(projectIn("deploy the API now", projects), "api");
});

test("only known actions, projects and tag-shaped strings survive from the model", () => {
  assert.deepEqual(validateIntent({ action: "create", project: "api", tag: null }, projects), { action: "create", project: "api", tag: null });
  assert.deepEqual(validateIntent({ action: "approve", project: "mobile", tag: "production_v20261102_0; rm -rf" }, projects), {
    action: "approve",
    project: null,
    tag: "production_v20261102_0",
  });
  assert.equal(validateIntent({ action: "delete_repo" }, projects), null);
  assert.equal(validateIntent("create", projects), null);
});

test("the AI is asked only when the rules can't tell, with the project list and the text alone", async () => {
  const fetch = fakeFetch([["POST", /ai\.test\/v1\/chat\/completions$/, { choices: [{ message: { content: 'Sure! {"action":"create","project":"web-app","tag":null}' } }] }]]);
  assert.deepEqual(await understand("let's get web out the door", projects, { ai, fetch }), { action: "create", project: "web-app", tag: null, by: "ai" });
  const sent = JSON.parse(fetch.calls[0].body);
  assert.equal(sent.model, "small");
  assert.match(sent.messages[0].content, /- web-app: Web App \(also: web\)/);
  assert.equal(sent.messages[1].content, "let's get web out the door");

  await understand("create release for api", projects, { ai, fetch });
  assert.equal(fetch.calls.length, 1, "rules answered without the AI");
});

test("without AI, or when it fails or answers nonsense, the answer is help", async () => {
  assert.equal((await understand("let's get web out the door", projects)).by, "fallback");
  const down = fakeFetch([["POST", /completions$/, { status: 500, body: {} }]]);
  assert.equal((await understand("let's get web out the door", projects, { ai, fetch: down })).action, "help");
  const odd = fakeFetch([["POST", /completions$/, { choices: [{ message: { content: '{"action":"merge_everything"}' } }] }]]);
  assert.equal((await understand("let's get web out the door", projects, { ai, fetch: odd })).action, "help");
});
