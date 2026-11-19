// `ako login`: signs a person in through the GitHub App with GitHub's device
// flow. They confirm a short code in the browser; AKO never sees a password,
// and the app's private key is never needed in the terminal.
//
// The token is kept in ~/.config/deriv-ako/credentials.json, readable only by
// its owner, per app (by client ID). GitHub App user tokens expire after
// eight hours; refreshing needs the app's client secret, which a terminal
// shouldn't hold, so an expired sign-in simply asks to sign in again.

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { DEFAULT_GITHUB_URL } from "../github/manifest.js";
import { createGitHubClient, DEFAULT_API_URL } from "../github/client.js";

export function credentialsPath(home = homedir()) {
  return join(home, ".config", "deriv-ako", "credentials.json");
}

function readAll(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeAll(path, all) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The signed-in person for this app, or null when there is none or it expired. */
export function loadCredentials(clientId, { path = credentialsPath(), now = Date.now() } = {}) {
  if (!clientId) return null;
  const entry = readAll(path)[clientId];
  if (!entry?.token) return null;
  if (entry.expiresAt && Date.parse(entry.expiresAt) <= now) return null;
  return entry;
}

export function saveCredentials(clientId, entry, { path = credentialsPath() } = {}) {
  const all = readAll(path);
  all[clientId] = entry;
  writeAll(path, all);
}

export function forgetCredentials(clientId, { path = credentialsPath() } = {}) {
  const all = readAll(path);
  const had = Boolean(all[clientId]);
  delete all[clientId];
  writeAll(path, all);
  return had;
}

/**
 * Runs the device flow. Calls `onCode({ code, url })` once with the code to
 * show, then waits for the person to confirm it. Resolves with
 * `{ token, expiresAt }`; rejects when they decline or the code expires.
 */
export async function deviceLogin({ clientId, githubUrl = DEFAULT_GITHUB_URL, fetch = globalThis.fetch, onCode, sleep, now = () => Date.now() }) {
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const post = async (path, body) => {
    const response = await fetch(`${githubUrl}${path}`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.json();
  };

  const start = await post("/login/device/code", { client_id: clientId });
  if (!start.device_code) {
    const error = new Error(
      start.error === "device_flow_disabled"
        ? "Device flow is off for this GitHub App. Turn on \"Enable Device Flow\" in the app's settings, then try again."
        : `GitHub didn't start the sign-in (${start.error_description ?? start.error ?? "no device code"}).`,
    );
    // The setup checks for this one, and only then sends people to the app's settings.
    error.code = start.error;
    throw error;
  }
  onCode({ code: start.user_code, url: start.verification_uri });

  let interval = (start.interval ?? 5) * 1000;
  const deadline = now() + (start.expires_in ?? 900) * 1000;
  while (now() < deadline) {
    await wait(interval);
    const result = await post("/login/oauth/access_token", {
      client_id: clientId,
      device_code: start.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (result.access_token) {
      return {
        token: result.access_token,
        expiresAt: result.expires_in ? new Date(now() + result.expires_in * 1000).toISOString() : null,
      };
    }
    if (result.error === "slow_down") interval += 5000;
    else if (result.error === "access_denied") throw new Error("The sign-in was declined on GitHub.");
    else if (result.error === "expired_token") break;
    else if (result.error !== "authorization_pending") throw new Error(`GitHub refused the sign-in (${result.error_description ?? result.error}).`);
  }
  throw new Error("The code expired before it was confirmed. Sign in again with `npx ako login`.");
}

/**
 * Signs a person in and keeps their token: `ako login`, and the offers to
 * sign in from the setup and from `ako release request`. Resolves with their
 * GitHub login.
 */
export async function signIn({ clientId, githubUrl = DEFAULT_GITHUB_URL, apiUrl = DEFAULT_API_URL, fetch = globalThis.fetch, onCode, sleep, path }) {
  const result = await deviceLogin({ clientId, githubUrl, fetch, onCode, sleep });
  const gh = createGitHubClient({ token: result.token, apiUrl, fetch });
  const user = await gh.request("GET", "/user");
  saveCredentials(clientId, { token: result.token, expiresAt: result.expiresAt, login: user.login }, path ? { path } : undefined);
  return { login: user.login };
}
