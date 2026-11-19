import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCheck, refMatches } from "../../src/setup/check.js";
import { updateEnvFile } from "../../src/config/env.js";
import { fakeFetch, tempDir, testPrivateKeyPem } from "../helpers/fakes.js";

const APP_ID = 4242;
const STATUSES = ["Backlog", "In Progress", "In Review", "Ready for Staging", "Staged", "Ready for Release", "Done"];
const ALL_PERMISSIONS = { metadata: "read", contents: "write", pull_requests: "write", issues: "write", actions: "read", organization_projects: "write", members: "read" };

function setup(t, overrides = {}) {
  const dir = tempDir(t);
  copyFileSync(new URL("../../examples/qa-regression.yaml", import.meta.url), join(dir, "release-flow.yaml"));
  if (overrides.boardOwner) {
    const flowPath = join(dir, "release-flow.yaml");
    writeFileSync(flowPath, readFileSync(flowPath, "utf8").replace("      number: 3\n", `      number: 3\n      owner: ${overrides.boardOwner}\n`));
  }
  const env = {
    GITHUB_APP_ID: String(APP_ID),
    GITHUB_APP_CLIENT_ID: "Iv1.test",
    GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(testPrivateKeyPem().privateKey).toString("base64"),
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_APP_TOKEN: "xapp-test",
  };
  // The settings come from .env, as they do for a real team.
  updateEnvFile(join(dir, ".env"), env);
  const routes = {
    app: ["GET", /\/app$/, { id: APP_ID, slug: "ako-acme", name: "AKO acme", owner: { login: "acme", type: "Organization" } }],
    installations: [
      "GET",
      /\/app\/installations\?/,
      overrides.installations ?? [{ id: 7, account: { login: "acme" }, permissions: overrides.permissions ?? ALL_PERMISSIONS }],
    ],
    // Each installation's token names it, so a test can tell which one a request used.
    token: ["POST", /\/app\/installations\/(\d+)\/access_tokens$/, (match) => ({ token: `t-${match[1]}`, expires_at: new Date(Date.now() + 3600e3).toISOString() })],
    repo: ["GET", /\/repos\/acme\/web-app$/, { default_branch: "main" }],
    branch: ["GET", /\/repos\/acme\/web-app\/branches\/main$/, {}],
    board: [
      "POST",
      /\/graphql$/,
      (_, init) =>
        // Like GitHub, a board outside the token's account is simply not found.
        overrides.boardToken && init.headers.Authorization !== `Bearer ${overrides.boardToken}`
          ? { data: { organization: null } }
          : { data: { organization: { projectV2: { title: "Web App", url: "", fields: { nodes: [{ name: "Status", options: (overrides.statuses ?? STATUSES).map((name) => ({ name })) }, {}] } } } } },
    ],
    workflow: ["GET", /\/actions\/workflows\/deploy-production\.yml$/, {}],
    users: ["GET", /\/users\/(alice|bob)$/, {}],
    team: ["GET", /\/orgs\/acme\/teams\/release-managers$/, {}],
    rulesets: ["GET", /\/rulesets\?/, overrides.rulesets ?? [{ id: 1, target: "tag", enforcement: "active" }]],
    ruleset: [
      "GET",
      /\/rulesets\/1\?includes_parents=true$/,
      {
        name: "Release tags",
        rules: [{ type: "creation" }],
        conditions: { ref_name: { include: ["refs/tags/production_v*"], exclude: [] } },
        bypass_actors: [{ actor_type: "Integration", actor_id: APP_ID }],
      },
    ],
    auth: ["POST", /slack\.com\/api\/auth\.test$/, { ok: true, team: "Acme", user: "ako" }],
    socket: ["POST", /slack\.com\/api\/apps\.connections\.open$/, { ok: true, url: "wss://example.invalid" }],
    channel: ["POST", /slack\.com\/api\/conversations\.info$/, { ok: true, channel: { name: "releases", is_member: overrides.isMember ?? true } }],
    post: ["POST", /slack\.com\/api\/chat\.postMessage$/, { ok: true }],
  };
  const fetch = fakeFetch(Object.values(routes));
  return { dir, fetch };
}

async function check(t, overrides) {
  const { dir, fetch } = setup(t, overrides);
  const output = [];
  const result = await runCheck({ cwd: dir, env: {}, fetch, write: (line) => output.push(line) });
  return { ...result, output: output.join(""), fetch };
}

const messages = (results, status) => results.filter((r) => r.status === status).map((r) => `${r.area}: ${r.message}`);

test("a correct setup passes every check and posts one Slack test message", async (t) => {
  const { failed, warned, results, fetch } = await check(t);
  assert.deepEqual(messages(results, "fail"), []);
  assert.deepEqual(messages(results, "warn"), []);
  assert.equal(failed + warned, 0);
  assert.deepEqual(fetch.unrouted, []);
  assert.equal(fetch.calls.filter((c) => c.url.endsWith("chat.postMessage")).length, 1);
});

test("a status the board doesn't have fails, naming it", async (t) => {
  const { results } = await check(t, { statuses: STATUSES.filter((s) => s !== "Staged") });
  assert.ok(messages(results, "fail").some((m) => /has no "Staged"/.test(m)));
});

test("a missing app permission fails, naming it", async (t) => {
  const { organization_projects, ...rest } = ALL_PERMISSIONS;
  const { results } = await check(t, { permissions: rest });
  assert.ok(messages(results, "fail").some((m) => /organization_projects: write \(has none\)/.test(m)));
});

test("a board in another org is read with that org's installation", async (t) => {
  const { organization_projects, ...repoPermissions } = ALL_PERMISSIONS;
  const { results, failed } = await check(t, {
    boardOwner: "acme-boards",
    boardToken: "t-8",
    installations: [
      { id: 7, account: { login: "acme" }, permissions: repoPermissions },
      { id: 8, account: { login: "acme-boards" }, permissions: { metadata: "read", organization_projects: organization_projects } },
    ],
  });
  assert.deepEqual(messages(results, "fail"), []);
  assert.equal(failed, 0);
  assert.ok(messages(results, "ok").some((m) => /"Web App" has every status/.test(m)));
});

test("a board org without the app fails, naming the org", async (t) => {
  const { results } = await check(t, { boardOwner: "acme-boards" });
  assert.ok(messages(results, "fail").some((m) => /board belongs to acme-boards, where the app isn't installed/.test(m)));
});

test("unprotected release tags are a warning", async (t) => {
  const { results, failed } = await check(t, { rulesets: [] });
  assert.equal(failed, 0);
  assert.ok(messages(results, "warn").some((m) => /release tags aren't protected/.test(m)));
});

test("a channel AKO isn't in fails instead of posting", async (t) => {
  const { results, fetch } = await check(t, { isMember: false });
  assert.ok(messages(results, "fail").some((m) => /isn't in #releases/.test(m)));
  assert.equal(fetch.calls.filter((c) => c.url.endsWith("chat.postMessage")).length, 0);
});

test("without a GitHub App the check stops early and says what to run", async (t) => {
  const { dir, fetch } = setup(t);
  writeFileSync(join(dir, ".env"), "");
  const { failed, results } = await runCheck({ cwd: dir, env: {}, fetch, write: () => {} });
  assert.ok(failed >= 1);
  assert.ok(messages(results, "fail").some((m) => /GITHUB_APP_ID is not set/.test(m)));
});

test("ruleset patterns match like GitHub's", () => {
  assert.equal(refMatches({ include: ["refs/tags/production_v*"] }, "refs/tags/production_v20261102_0"), true);
  assert.equal(refMatches({ include: ["refs/tags/v*"] }, "refs/tags/production_v20261102_0"), false);
  assert.equal(refMatches({ include: ["~ALL"], exclude: ["refs/tags/production_*"] }, "refs/tags/production_v1"), false);
  assert.equal(refMatches({ include: ["refs/tags/**"] }, "refs/tags/a/b"), true);
});
