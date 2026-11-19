// Waiting out API rate limits.
//
// GitHub and ClickUp refuse a request over their rate limit with 429. GitHub
// can also use 403, with `x-ratelimit-remaining: 0` (primary limit) or a
// `Retry-After` header (secondary limit). A refused request was not applied,
// so it is safe to send again, writes included.
//
// AKO waits as long as the server asks and then retries, a few times at most.
// A wait longer than MAX_RATE_LIMIT_WAIT_MS (a primary limit can reset an hour
// later) is not waited out: the response goes back to the client, which reports
// it, so a command never hangs.

export const RATE_LIMIT_RETRIES = 2;
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;

// GitHub's advice for a secondary limit with no header: wait at least a minute.
const DEFAULT_WAIT_MS = 60_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait before retrying `response`, in milliseconds, or null when
 * it is not a rate-limit response.
 */
export function rateLimitWait(response, now = Date.now()) {
  const header = (name) => response.headers?.get?.(name) ?? null;
  const retryAfter = header("retry-after");
  const remaining = header("x-ratelimit-remaining");
  const limited = response.status === 429 || (response.status === 403 && (retryAfter !== null || remaining === "0"));
  if (!limited) return null;

  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (retryAfter.trim() !== "" && Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return Math.max(0, date - now);
  }
  // Both services send the reset time in Unix seconds. A second more allows
  // for clock skew.
  const reset = Number(header("x-ratelimit-reset"));
  if (reset > 0) return Math.max(0, reset * 1000 - now) + 1000;
  return DEFAULT_WAIT_MS;
}

/** `fetch(url, init)`, retried while the server answers with a rate limit it asks AKO to wait out. */
export async function fetchWithRateLimit(fetch, url, init, { sleep = defaultSleep, now = Date.now, retries = RATE_LIMIT_RETRIES, maxWaitMs = MAX_RATE_LIMIT_WAIT_MS } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, init);
    const wait = rateLimitWait(response, now());
    if (wait === null || attempt >= retries || wait > maxWaitMs) return response;
    // Release the connection before waiting; the body is not needed.
    await response.body?.cancel().catch(() => {});
    await sleep(wait);
  }
}
