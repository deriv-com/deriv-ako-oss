import { test } from "node:test";
import assert from "node:assert/strict";
import { RULES, scanText, loadDenylist } from "../../scripts/leak-check.js";

const rulesHit = (text, rules = RULES) => scanText(text, rules).map((f) => f.rule);

test("secrets are caught", () => {
  assert.deepEqual(rulesHit("-----BEGIN RSA PRIVATE KEY-----"), ["private key"]);
  assert.deepEqual(rulesHit(`token: ghs_${"a".repeat(36)}`), ["GitHub token"]);
  assert.deepEqual(rulesHit(`SLACK_BOT_TOKEN=xoxb-${"1".repeat(12)}-abcdef`), ["Slack token"]);
  assert.deepEqual(rulesHit(`OPENAI_API_KEY=sk-proj-${"x".repeat(30)}`), ["AI API key"]);
});

test("real-looking Slack IDs and links are caught, placeholders are not", () => {
  assert.deepEqual(rulesHit("slack: [U0ABCD1234]"), ["Slack ID"]);
  assert.deepEqual(rulesHit("slack: [U000000001, S000000002, C000000003]"), []);
  assert.deepEqual(rulesHit("see https://acme.slack.com/archives/C000000001/p123"), ["Slack archive link"]);
});

test("emails are caught unless they're the security contact, no-reply or example", () => {
  assert.deepEqual(rulesHit("by someone@acme.io"), ["email address"]);
  assert.deepEqual(rulesHit("security@deriv.com, 1+bot@users.noreply.github.com, alice@example.com"), []);
});

test("the denylist comes from the environment, skipping comments and blanks", () => {
  const denylist = loadDenylist({ env: { LEAK_DENYLIST: "# internal\n\ninternal-host\\.example\n\\bsecretproject\\b" } });
  assert.equal(denylist.length, 2);
  const findings = scanText("deploys to internal-host.example for SecretProject", denylist);
  assert.equal(findings.length, 2);
  assert.ok(findings.every((f) => f.match === null), "denylist matches are never echoed");
});

test("the env example and placeholder values pass", () => {
  assert.deepEqual(rulesHit("SLACK_BOT_TOKEN=\nGITHUB_APP_PRIVATE_KEY_BASE64=\n# xoxb-...  xapp-..."), []);
});
