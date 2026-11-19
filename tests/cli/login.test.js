import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deviceLogin, loadCredentials, saveCredentials, forgetCredentials } from "../../src/cli/login.js";
import { fakeFetch, tempDir } from "../helpers/fakes.js";

test("the device flow shows the code once, waits, slows down when asked, and returns the token", async () => {
  const replies = [{ error: "authorization_pending" }, { error: "slow_down" }, { access_token: "ghu_test", expires_in: 28800 }];
  const fetch = fakeFetch([
    ["POST", /\/login\/device\/code$/, { device_code: "dev", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 }],
    ["POST", /\/login\/oauth\/access_token$/, () => replies.shift()],
  ]);
  const codes = [];
  const waits = [];
  let clock = 0;
  const result = await deviceLogin({
    clientId: "Iv1.test",
    fetch,
    onCode: (c) => codes.push(c),
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  assert.deepEqual(codes, [{ code: "ABCD-1234", url: "https://github.com/login/device" }]);
  assert.deepEqual(waits, [5000, 5000, 10000]);
  assert.equal(result.token, "ghu_test");
  assert.equal(result.expiresAt, new Date(20000 + 28800 * 1000).toISOString());
  assert.deepEqual(JSON.parse(fetch.calls[0].body), { client_id: "Iv1.test" });
});

test("the device flow explains a disabled app setting, a decline and an expired code", async () => {
  const off = fakeFetch([["POST", /device\/code$/, { error: "device_flow_disabled" }]]);
  await assert.rejects(deviceLogin({ clientId: "x", fetch: off, onCode() {} }), /Turn on "Enable Device Flow"/);

  const start = ["POST", /device\/code$/, { device_code: "d", user_code: "C", verification_uri: "u", interval: 1, expires_in: 3 }];
  const declined = fakeFetch([start, ["POST", /access_token$/, { error: "access_denied" }]]);
  await assert.rejects(deviceLogin({ clientId: "x", fetch: declined, onCode() {}, sleep: async () => {} }), /declined/);

  let clock = 0;
  const pending = fakeFetch([start, ["POST", /access_token$/, { error: "authorization_pending" }]]);
  await assert.rejects(
    deviceLogin({ clientId: "x", fetch: pending, onCode() {}, sleep: async (ms) => (clock += ms), now: () => clock }),
    /The code expired/,
  );
});

test("credentials are kept per app, readable only by their owner, and expire", (t) => {
  const path = join(tempDir(t), "deriv-ako", "credentials.json");
  saveCredentials("Iv1.a", { token: "ghu_a", login: "alice", expiresAt: "2026-11-02T17:00:00Z" }, { path });
  saveCredentials("Iv1.b", { token: "ghu_b", login: "alice", expiresAt: null }, { path });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(loadCredentials("Iv1.a", { path, now: Date.parse("2026-11-02T16:59:00Z") }).token, "ghu_a");
  assert.equal(loadCredentials("Iv1.a", { path, now: Date.parse("2026-11-02T17:00:00Z") }), null);
  assert.equal(loadCredentials("Iv1.b", { path }).token, "ghu_b");
  assert.equal(loadCredentials(undefined, { path }), null);
  assert.equal(forgetCredentials("Iv1.a", { path }), true);
  assert.equal(forgetCredentials("Iv1.a", { path }), false);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8"))), ["Iv1.b"]);
});
