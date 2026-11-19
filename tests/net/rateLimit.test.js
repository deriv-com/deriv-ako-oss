import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimitWait, fetchWithRateLimit, MAX_RATE_LIMIT_WAIT_MS } from "../../src/net/rateLimit.js";
import { createGitHubClient, GitHubError } from "../../src/github/client.js";
import { createClickUpClient } from "../../src/trackers/clickup.js";
import { createSlackClient } from "../../src/chat/slack.js";

const NOW = Date.UTC(2026, 10, 9, 9, 0, 0);
const reply = (status, headers = {}, body = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/** A fetch that answers with `responses` in order and records each request. */
function scripted(responses) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    return responses.shift()();
  };
  return { fetch, calls };
}

function recordingSleep() {
  const waits = [];
  return { waits, sleep: async (ms) => waits.push(ms) };
}

test("rateLimitWait reads Retry-After, the reset time, or falls back to a minute", () => {
  assert.equal(rateLimitWait(reply(200), NOW), null);
  assert.equal(rateLimitWait(reply(404), NOW), null);
  // A plain 403 is a permission problem, not a rate limit.
  assert.equal(rateLimitWait(reply(403), NOW), null);

  assert.equal(rateLimitWait(reply(429, { "Retry-After": "3" }), NOW), 3000);
  assert.equal(rateLimitWait(reply(403, { "Retry-After": "7" }), NOW), 7000);
  assert.equal(rateLimitWait(reply(429, { "Retry-After": new Date(NOW + 5000).toUTCString() }), NOW), 5000);
  const reset = String(NOW / 1000 + 30);
  assert.equal(rateLimitWait(reply(403, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": reset }), NOW), 31_000);
  assert.equal(rateLimitWait(reply(429, { "X-RateLimit-Reset": reset }), NOW), 31_000);
  assert.equal(rateLimitWait(reply(429), NOW), 60_000);
});

test("the GitHub client waits out a 429 and retries", async () => {
  const { fetch, calls } = scripted([() => reply(429, { "Retry-After": "2" }, { message: "slow down" }), () => reply(200, {}, { ok: true })]);
  const { waits, sleep } = recordingSleep();
  const github = createGitHubClient({ token: "t", fetch, sleep });
  assert.deepEqual(await github.request("GET", "/repos/acme/web-app"), { ok: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [2000]);
});

test("a refused write is sent again: a rate-limited request was never applied", async () => {
  const { fetch, calls } = scripted([() => reply(403, { "Retry-After": "1" }, { message: "secondary rate limit" }), () => reply(201, {}, { number: 9 })]);
  const { sleep } = recordingSleep();
  const github = createGitHubClient({ token: "t", fetch, sleep });
  assert.deepEqual(await github.request("POST", "/repos/acme/web-app/issues", { title: "x" }), { number: 9 });
  assert.deepEqual(calls.map((c) => c.method), ["POST", "POST"]);
  assert.equal(calls[1].body, calls[0].body);
});

test("a plain 403 is not retried", async () => {
  const { fetch, calls } = scripted([() => reply(403, {}, { message: "Resource not accessible by integration" })]);
  const { waits, sleep } = recordingSleep();
  const github = createGitHubClient({ token: "t", fetch, sleep });
  await assert.rejects(github.request("GET", "/repos/acme/web-app"), (error) => error instanceof GitHubError && error.status === 403);
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test("it gives up after two retries, and never waits longer than the cap", async () => {
  const limited = () => reply(429, { "Retry-After": "1" }, { message: "API rate limit exceeded" });
  const retried = scripted([limited, limited, limited, limited]);
  const github = createGitHubClient({ token: "t", fetch: retried.fetch, sleep: recordingSleep().sleep });
  await assert.rejects(github.request("GET", "/x"), (error) => error.status === 429 && /rate limit exceeded/.test(error.message));
  assert.equal(retried.calls.length, 3);

  // A primary limit an hour from reset is reported straight away.
  const reset = String(Math.floor(Date.now() / 1000) + 3600);
  const longWait = scripted([() => reply(403, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": reset }, { message: "API rate limit exceeded" })]);
  const { waits, sleep } = recordingSleep();
  await assert.rejects(createGitHubClient({ token: "t", fetch: longWait.fetch, sleep }).request("GET", "/x"), (error) => error.status === 403);
  assert.equal(longWait.calls.length, 1);
  assert.deepEqual(waits, []);
});

test("the ClickUp client waits for the rate limit to reset", async () => {
  const reset = String(Math.floor(Date.now() / 1000) + 10);
  const { fetch, calls } = scripted([() => reply(429, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": reset }, { err: "Rate limit reached" }), () => reply(200, {}, { user: { id: 1 } })]);
  const { waits, sleep } = recordingSleep();
  const clickup = createClickUpClient({ token: "pk", fetch, sleep });
  assert.deepEqual(await clickup.request("GET", "/user"), { user: { id: 1 } });
  assert.equal(calls.length, 2);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] <= MAX_RATE_LIMIT_WAIT_MS);
});

test("the Slack client waits out a 429 and retries", async () => {
  const { fetch, calls } = scripted([() => reply(429, { "Retry-After": "4" }, { ok: false, error: "ratelimited" }), () => reply(200, {}, { ok: true, user: "ako" })]);
  const { waits, sleep } = recordingSleep();
  const slack = createSlackClient({ token: "xoxb-test", fetch, sleep });
  assert.equal((await slack.call("auth.test")).user, "ako");
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [4000]);
});

test("fetchWithRateLimit passes other responses through untouched", async () => {
  const { fetch, calls } = scripted([() => reply(500, {}, { message: "boom" })]);
  const response = await fetchWithRateLimit(fetch, "https://api.example/x", {}, { sleep: recordingSleep().sleep });
  assert.equal(response.status, 500);
  assert.equal(calls.length, 1);
});
