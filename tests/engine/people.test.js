import { test } from "node:test";
import assert from "node:assert/strict";
import { isReleaseManager, pruneExpired, slackActor } from "../../src/engine/people.js";

test("pruneExpired drops only the entries whose time is up", () => {
  const cache = new Map([
    ["S1", { members: ["U1"], until: 1000 }],
    ["S2", { members: ["U2"], until: 2000 }],
  ]);
  pruneExpired(cache, 1500);
  assert.deepEqual([...cache.keys()], ["S2"]);
  pruneExpired(cache, 2000);
  assert.equal(cache.size, 0);
});

test("a Slack group's members are cached for 10 minutes, then read again", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 9, 9, 0, 0) });
  let reads = 0;
  const slack = { call: async () => ({ users: reads++ === 0 ? ["U000000001"] : ["U000000002"] }) };
  const project = { name: "Web App", key: "web-app", people: { release_managers: { slack: ["S000000007"] } } };

  assert.equal((await isReleaseManager(project, slackActor("U000000001"), { slack })).ok, true);
  t.mock.timers.tick(9 * 60 * 1000);
  assert.equal((await isReleaseManager(project, slackActor("U000000001"), { slack })).ok, true, "still cached");
  assert.equal(reads, 1);

  t.mock.timers.tick(60 * 1000);
  assert.equal((await isReleaseManager(project, slackActor("U000000001"), { slack })).ok, false, "membership read again");
  assert.equal((await isReleaseManager(project, slackActor("U000000002"), { slack })).ok, true);
  assert.equal(reads, 2);
});
