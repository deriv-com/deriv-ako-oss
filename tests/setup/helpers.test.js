import { test } from "node:test";
import assert from "node:assert/strict";
import { scriptedPrompter } from "../../src/setup/prompts.js";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newFlowDocument, addProject, setProjectValues, compact, readFlowDocument } from "../../src/setup/flowFile.js";
import { toKey, toTitle, splitList } from "../../src/setup/projectSection.js";
import { parseListId } from "../../src/trackers/clickup.js";
import { unknownStatuses } from "../../src/trackers/index.js";
import { buildSlackManifest, tokenKind, matchUsers, matchGroups, createSlackAppUrl } from "../../src/chat/slack.js";

test("ask re-asks until the answer validates, and uses the default on Enter", async () => {
  const p = scriptedPrompter(["", "bad", "good", ""]);
  assert.equal(await p.ask("Name", { validate: (v) => (v === "good" ? null : "no") }), "good");
  assert.equal(await p.ask("Branch", { default: "main" }), "main");
  assert.ok(p.output.includes("  An answer is needed.\n"));
  assert.ok(p.output.includes("  no\n"));
});

test("an optional question can be skipped", async () => {
  const p = scriptedPrompter([""]);
  assert.equal(await p.ask("Aliases", { optional: true }), "");
});

test("choose and chooseMany take numbers and defaults", async () => {
  const options = [
    { label: "a", value: "A" },
    { label: "b", value: "B" },
    { label: "c", value: "C" },
  ];
  const p = scriptedPrompter(["9", "2", "", "1, 3", ""]);
  assert.equal(await p.choose("Pick", options), "B");
  assert.equal(await p.choose("Pick", options, { default: "C" }), "C");
  assert.deepEqual(await p.chooseMany("Pick", options), ["A", "C"]);
  assert.deepEqual(await p.chooseMany("Pick", options, { defaults: ["B"] }), ["B"]);
});

test("confirm reads y and n and falls back to the default", async () => {
  const p = scriptedPrompter(["", "n", "maybe", "y"]);
  assert.equal(await p.confirm("Go?"), true);
  assert.equal(await p.confirm("Go?"), false);
  assert.equal(await p.confirm("Go?", false), true);
});

test("the flow document drops empty values and sets nested ones", () => {
  const doc = newFlowDocument();
  addProject(doc, { key: "web-app", aliases: [], tracker: { type: "github-issues", statuses: { ready: ["x"], staged: null } } });
  setProjectValues(doc, "web-app", [
    [["slack", "channels"], ["C000000001"]],
    [["people", "qa", "slack"], []],
  ]);
  assert.deepEqual(doc.toJS().projects[0], {
    key: "web-app",
    tracker: { type: "github-issues", statuses: { ready: ["x"] } },
    slack: { channels: ["C000000001"] },
  });
  assert.deepEqual(compact({ a: "", b: {}, c: [null], d: 0 }), { c: [null], d: 0 });
});

test("names become keys and titles", () => {
  assert.equal(toKey("My_Web.App"), "my-web-app");
  assert.equal(toTitle("web-app_v2"), "Web App V2");
  assert.deepEqual(splitList(" a, ,b ,"), ["a", "b"]);
});

test("ClickUp list IDs come from list URLs, view URLs or bare IDs", () => {
  assert.equal(parseListId("900000000001"), "900000000001");
  assert.equal(parseListId("https://app.clickup.com/9000000/v/li/900000000001"), "900000000001");
  assert.equal(parseListId("https://app.clickup.com/9000000/v/l/6-900000000001-1"), "900000000001");
  assert.equal(parseListId("https://example.com/board"), null);
});

test("ClickUp statuses match without case; GitHub's must match exactly", () => {
  const statuses = { ready: ["Ready"], staged: null, ready_for_release: "QA Passed", done: "Done", catch_up: [] };
  assert.deepEqual(unknownStatuses({ type: "clickup", statuses }, ["ready", "qa passed", "done"]), []);
  assert.deepEqual(unknownStatuses({ type: "github-projects", statuses }, ["ready", "qa passed", "done"]), ["Ready", "QA Passed", "Done"]);
});

test("the Slack manifest uses Socket Mode, and the agent adds its side panel", () => {
  const app = buildSlackManifest();
  assert.equal(app.settings.socket_mode_enabled, true);
  assert.equal(app.features.assistant_view, undefined);
  const agent = buildSlackManifest({ agent: true });
  assert.ok(agent.oauth_config.scopes.bot.includes("assistant:write"));
  assert.ok(agent.settings.event_subscriptions.bot_events.includes("assistant_thread_started"));
  assert.match(createSlackAppUrl(app), /^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=%7B/);
});

test("the Slack app can't read channel history or open direct messages", () => {
  // A mention in a thread arrives as an app_mention event, and AKO only answers
  // direct messages people send it, so neither is ever needed.
  for (const manifest of [buildSlackManifest(), buildSlackManifest({ agent: true })]) {
    const scopes = manifest.oauth_config.scopes.bot;
    for (const scope of ["channels:history", "groups:history", "mpim:history", "im:read", "im:write"]) {
      assert.ok(!scopes.includes(scope), scope);
    }
    assert.ok(scopes.includes("im:history"), "direct messages to AKO still arrive");
  }
});

test("Slack lookups skip bots, deleted users and deleted groups", () => {
  assert.equal(tokenKind("xoxb-1"), "bot");
  assert.equal(tokenKind("xapp-1"), "app");
  assert.equal(tokenKind("xoxp-1"), "unknown");
  const users = [
    { id: "U000000001", name: "alice", real_name: "Alice Example" },
    { id: "U000000002", name: "alicebot", is_bot: true },
    { id: "U000000003", name: "alice2", deleted: true },
  ];
  assert.deepEqual(matchUsers(users, "@Alice").map((u) => u.id), ["U000000001"]);
  const groups = [
    { id: "S000000001", handle: "qa", name: "QA" },
    { id: "S000000002", handle: "qa-old", name: "Old QA", date_delete: 1 },
  ];
  assert.deepEqual(matchGroups(groups, "@qa").map((g) => g.id), ["S000000001"]);
});

test("written setup text splits into headings, results, warnings, errors and messages", async () => {
  const { toBlocks } = await import("../../src/setup/pretty.js");
  const blocks = toBlocks("\n== GitHub ==\nAKO uses its own app.\nIt never uses a token.\n  Connected to the GitHub App \"AKO\".\n  ! The app isn't installed anywhere yet.\n  ✗ GitHub refused the app.\n");
  assert.deepEqual(blocks, [
    { kind: "heading", lines: ["GitHub"] },
    { kind: "message", lines: ["AKO uses its own app.", "It never uses a token."] },
    { kind: "success", lines: ['Connected to the GitHub App "AKO".'] },
    { kind: "warn", lines: ["The app isn't installed anywhere yet."] },
    { kind: "error", lines: ["GitHub refused the app."] },
  ]);
});

test("the plain prompter writes intro, note and outro as text", () => {
  const p = scriptedPrompter([]);
  p.intro("Deriv AKO setup");
  p.note(["Turn on device flow.", "Invite @ako."], "Still to do");
  p.outro("Next, run npm run check.");
  assert.equal(p.output.join(""), "Deriv AKO setup\nStill to do:\n  - Turn on device flow.\n  - Invite @ako.\nNext, run npm run check.\n");
});

test("URLs open without a shell, so a Slack link keeps everything after its first &", async () => {
  const { openCommand } = await import("../../src/setup/openUrl.js");
  const url = "https://api.slack.com/apps?new_app=1&manifest_json=%7B%22a%22%3A1%7D";
  assert.deepEqual(openCommand(url, "win32"), ["rundll32", ["url.dll,FileProtocolHandler", url]]);
  assert.deepEqual(openCommand(url, "darwin"), ["open", [url]]);
  assert.deepEqual(openCommand(url, "linux"), ["xdg-open", [url]]);
});

test("readFlowDocument names the file when it has too many aliases", () => {
  const names = "abcdefghi";
  const bomb = [
    "a: &a [x, x, x, x, x, x, x, x, x]",
    ...[...names.slice(1)].map((n, i) => `${n}: &${n} [${Array(9).fill(`*${names[i]}`).join(", ")}]`),
  ].join("\n");
  const path = join(mkdtempSync(join(tmpdir(), "ako-flow-")), "release-flow.yaml");
  writeFileSync(path, bomb);
  assert.throws(() => readFlowDocument(path), (error) => error.message.startsWith(`${path}: `) && /alias/i.test(error.message));
});
