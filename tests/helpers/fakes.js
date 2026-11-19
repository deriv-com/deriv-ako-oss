// Test doubles: a routed fetch, a throwaway folder and an app key.

import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A fetch that answers from `routes`: `[method, urlPattern, reply]`, where
 * `reply` is a body, or a function `(match, init) => body | { status, body }`.
 * Unrouted requests answer 404 and are recorded in `unrouted`.
 */
export function fakeFetch(routes) {
  const calls = [];
  const unrouted = [];
  async function fetch(url, init = {}) {
    const method = (init.method ?? "GET").toUpperCase();
    const href = String(url);
    calls.push({ method, url: href, body: init.body });
    for (const [routeMethod, pattern, reply] of routes) {
      if (routeMethod !== method) continue;
      const match = href.match(pattern);
      if (!match) continue;
      const result = typeof reply === "function" ? await reply(match, init) : reply;
      const { status = 200, body = result } = result && typeof result === "object" && "status" in result && "body" in result ? result : {};
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }
    unrouted.push(`${method} ${href}`);
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  }
  return Object.assign(fetch, { calls, unrouted });
}

export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ako-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let cachedKey;
/** A throwaway RSA key in PEM, generated once per test run. */
export function testPrivateKeyPem() {
  cachedKey ??= generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return cachedKey;
}
