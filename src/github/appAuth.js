// GitHub App authentication: the app signs a short-lived JWT with its private
// key, then trades it for an installation token scoped to one account.
//
// An installation token only sees the account it was issued for, and GitHub
// answers 404 (not 403) for anything outside it, so tokens are picked per repo
// owner rather than shared.

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createGitHubClient, DEFAULT_API_URL, GitHubError } from "./client.js";

/** Builds the app's RS256 JWT. Valid for 9 minutes, backdated 60s for clock skew. */
export function createAppJwt({ appId, privateKey, now = Date.now() }) {
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 600, iss: String(appId) }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

/**
 * Reads the app's private key from the environment, in order:
 * GITHUB_APP_PRIVATE_KEY_BASE64, GITHUB_APP_PRIVATE_KEY (raw PEM),
 * GITHUB_APP_PRIVATE_KEY_PATH (a .pem file). Returns null when none is set.
 */
export function readPrivateKey(env = process.env) {
  let pem = null;
  if (env.GITHUB_APP_PRIVATE_KEY_BASE64) {
    pem = Buffer.from(env.GITHUB_APP_PRIVATE_KEY_BASE64, "base64").toString("utf8");
  } else if (env.GITHUB_APP_PRIVATE_KEY) {
    pem = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  } else if (env.GITHUB_APP_PRIVATE_KEY_PATH) {
    pem = readFileSync(env.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
  }
  return pem === null ? null : createPrivateKey(pem);
}

/**
 * Returns the app's API helpers: the app client (signed with the JWT), the
 * installation for an owner, and an installation client per owner.
 */
export function createGitHubApp({ appId, privateKey, apiUrl = DEFAULT_API_URL, fetch = globalThis.fetch, now = () => Date.now() }) {
  const appClient = createGitHubClient({
    token: async () => createAppJwt({ appId, privateKey, now: now() }),
    apiUrl,
    fetch,
  });

  let installations = null;
  const tokens = new Map();

  async function listInstallations({ refresh = false } = {}) {
    if (refresh || !installations) installations = await appClient.paginate("/app/installations");
    return installations;
  }

  async function installationFor(owner) {
    const list = await listInstallations();
    return list.find((i) => i.account?.login?.toLowerCase() === owner.toLowerCase()) ?? null;
  }

  async function installationToken(installationId) {
    const cached = tokens.get(installationId);
    // Refresh five minutes before expiry.
    if (cached && Date.parse(cached.expires_at) - now() > 5 * 60 * 1000) return cached.token;
    const fresh = await appClient.request("POST", `/app/installations/${installationId}/access_tokens`, {});
    tokens.set(installationId, fresh);
    return fresh.token;
  }

  async function clientForOwner(owner) {
    const installation = await installationFor(owner);
    if (!installation) {
      throw new GitHubError(`The GitHub App is not installed on "${owner}".`, { status: 404 });
    }
    return createGitHubClient({ token: () => installationToken(installation.id), apiUrl, fetch });
  }

  /** Every repo the app can reach, across all its installations. */
  async function listRepos() {
    const repos = [];
    for (const installation of await listInstallations()) {
      const client = await clientForOwner(installation.account.login);
      const list = await client.paginate("/installation/repositories", { key: "repositories" });
      for (const repo of list) {
        repos.push({
          full_name: repo.full_name,
          name: repo.name,
          owner: repo.owner.login,
          ownerType: repo.owner.type,
          default_branch: repo.default_branch,
          private: repo.private,
        });
      }
    }
    return repos.sort((a, b) => a.full_name.localeCompare(b.full_name));
  }

  return {
    appClient,
    getApp: () => appClient.request("GET", "/app"),
    listInstallations,
    installationFor,
    clientForOwner,
    listRepos,
  };
}
