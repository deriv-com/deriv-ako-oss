import { test } from "node:test";
import assert from "node:assert/strict";
import { nextTag, latestTag, dateStamp } from "../../src/engine/tags.js";

const NOV_2 = Date.UTC(2026, 10, 2, 23, 30);

test("the date stamp is UTC", () => {
  assert.equal(dateStamp(NOV_2), "20261102");
});

test("the next tag counts past every name used today, and ignores other days and prefixes", () => {
  assert.equal(nextTag("production_v", [], NOV_2), "production_v20261102_0");
  assert.equal(nextTag("production_v", ["production_v20261102_0", "production_v20261102_3", "production_v20261101_7", "production_V20261102_9", "staging_v20261102_5"], NOV_2), "production_v20261102_4");
  assert.equal(nextTag("release-", ["release-20261102_0"], NOV_2), "release-20261102_1");
});

test("a prefix with regex characters is matched literally", () => {
  assert.equal(nextTag("v1.", ["v1x20261102_0", "v1.20261102_0"], NOV_2), "v1.20261102_1");
});

test("the latest tag is by date then number, and can be the one before a given tag", () => {
  const tags = ["production_v20261030_0", "production_v20261102_1", "production_v20261102_0", "production_v20261101_10", "production_v20261101_9", "notes"];
  assert.equal(latestTag("production_v", tags), "production_v20261102_1");
  assert.equal(latestTag("production_v", tags, { before: "production_v20261102_0" }), "production_v20261101_10");
  assert.equal(latestTag("production_v", tags, { before: "production_v20261102_2" }), "production_v20261102_1");
  assert.equal(latestTag("production_v", tags, { before: "production_v20261030_0" }), null);
  assert.equal(latestTag("production_v", []), null);
});
