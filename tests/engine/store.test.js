import { test } from "node:test";
import assert from "node:assert/strict";
import { parseState, renderBody, activeLocks, LOCK_MS } from "../../src/engine/store.js";

const project = { key: "web-app", name: "Web App" };
const state = {
  version: 1,
  project: "web-app",
  tag: "production_v20261102_0",
  status: "in_regression",
  openedBy: "github:alice",
  testedSha: "0123456789abcdef",
  items: [{ id: "1", ref: "#1", title: "Fix --> the label", url: "https://github.com/acme/web-app/issues/1" }],
};

test("the state round-trips through the issue body, with a summary for people above it", () => {
  const body = renderBody(project, state);
  assert.match(body, /\*\*Status:\*\* In regression/);
  assert.match(body, /\*\*Tested commit:\*\* 0123456/);
  assert.match(body, /\[#1\]\(https:\/\/github.com\/acme\/web-app\/issues\/1\) Fix/);
  assert.deepEqual(parseState(body), state);
  assert.doesNotMatch(body.slice(body.indexOf("<!-- ako-state") + 4, -3), /--/, "nothing ends the hidden comment early");
});

test("a body without state, or with broken state, reads as no release", () => {
  assert.equal(parseState("Just an issue"), null);
  assert.equal(parseState("<!-- ako-state\n{not json\n-->"), null);
  assert.equal(parseState(undefined), null);
});

test("locks: the earliest unexpired one wins, and expired ones are ignored", () => {
  const at = Date.UTC(2026, 10, 2, 9, 0);
  const lock = (id, holder, expires) => ({ id, body: `<!-- ako-lock ${JSON.stringify({ holder, expires: new Date(expires).toISOString() })} -->` });
  const comments = [
    lock(1, "terminal:old", at - 1000),
    { id: 2, body: "A normal comment" },
    lock(3, "slack:bot", at + LOCK_MS),
    lock(4, "terminal:alice", at + LOCK_MS),
  ];
  assert.deepEqual(activeLocks(comments, at).map((l) => l.holder), ["slack:bot", "terminal:alice"]);
  assert.deepEqual(activeLocks(comments, at, { includeExpired: true }).map((l) => l.holder), ["terminal:old", "slack:bot", "terminal:alice"]);
});

test("locks: only comments that pass the trust check count", () => {
  const at = Date.UTC(2026, 10, 2, 9, 0, 0);
  const lock = (id, user) => ({ id, user: { login: user }, body: `<!-- ako-lock ${JSON.stringify({ holder: user, expires: new Date(at + LOCK_MS).toISOString() })} -->` });
  const comments = [lock(1, "stranger"), lock(2, "ako[bot]")];
  assert.deepEqual(activeLocks(comments, at, { trusted: (c) => c.user.login === "ako[bot]" }).map((l) => l.holder), ["ako[bot]"]);
});
