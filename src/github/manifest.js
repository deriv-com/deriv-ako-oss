// Creates AKO's GitHub App from a manifest, so nobody fills in the app form by
// hand or copies a personal access token.
//
// GitHub's manifest flow: a form posts the manifest to github.com, the person
// confirms, and GitHub redirects back with a one-time code that AKO trades for
// the app's ID, client ID and private key. The redirect lands on a server AKO
// runs on 127.0.0.1 for the length of the setup only.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createGitHubClient, DEFAULT_API_URL } from "./client.js";
import { BASE_PERMISSIONS } from "./permissions.js";

export const DEFAULT_GITHUB_URL = "https://github.com";
export const PROJECT_URL = "https://github.com/deriv-com/deriv-ako-oss";

/**
 * Builds the GitHub App manifest. Webhooks stay off: AKO reads GitHub when it
 * needs to, so it never needs a public URL.
 */
export function buildGitHubAppManifest({ name = "AKO", redirectUrl, permissions = BASE_PERMISSIONS } = {}) {
  const manifest = {
    name,
    url: PROJECT_URL,
    description: "Deriv AKO: picks up ready work, opens releases, merges linked PRs, and tags and publishes after a release manager approves.",
    public: false,
    hook_attributes: { url: PROJECT_URL, active: false },
    default_permissions: { ...BASE_PERMISSIONS, ...permissions },
    default_events: [],
  };
  if (redirectUrl) manifest.redirect_url = redirectUrl;
  return manifest;
}

/** Where the manifest form posts: a personal account or an organization. */
export function newAppUrl({ owner, ownerType, githubUrl = DEFAULT_GITHUB_URL, state }) {
  const base = ownerType === "Organization"
    ? `${githubUrl}/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : `${githubUrl}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}

/** The page that posts the manifest to GitHub as soon as it loads. */
export function manifestFormHtml({ action, manifest }) {
  const json = JSON.stringify(manifest).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Create the AKO GitHub App</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; line-height: 1.5">
  <h1>Create the AKO GitHub App</h1>
  <p>This sends AKO's app settings to GitHub. Check them there and click <b>Create GitHub App</b>.</p>
  <form id="f" method="post" action="${action}">
    <input type="hidden" name="manifest" value="${json}">
    <button type="submit">Continue to GitHub</button>
  </form>
  <script>document.getElementById("f").submit()</script>
</body></html>`;
}

const DONE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>AKO GitHub App created</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 34rem; margin: 3rem auto; line-height: 1.5">
  <h1>App created</h1><p>Go back to the setup, in your terminal or its browser tab, to install it and finish. You can close this tab.</p>
</body></html>`;

/**
 * Runs the manifest flow and resolves with GitHub's conversion result:
 * `{ id, slug, client_id, pem, html_url, owner }`.
 */
export async function createAppFromManifest({
  name,
  owner,
  ownerType,
  permissions,
  githubUrl = DEFAULT_GITHUB_URL,
  apiUrl = DEFAULT_API_URL,
  fetch = globalThis.fetch,
  openUrl = () => {},
  log = () => {},
  timeoutMs = 10 * 60 * 1000,
}) {
  const state = randomBytes(16).toString("hex");
  const github = createGitHubClient({ apiUrl, fetch });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      error ? reject(error) : resolve(value);
    };

    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/") {
        const { port } = server.address();
        const manifest = buildGitHubAppManifest({
          name,
          permissions,
          redirectUrl: `http://127.0.0.1:${port}/callback`,
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(manifestFormHtml({ action: newAppUrl({ owner, ownerType, githubUrl, state }), manifest }));
        return;
      }
      if (url.pathname === "/callback") {
        if (url.searchParams.get("state") !== state) {
          res.writeHead(400).end("State mismatch. Start the setup again.");
          return;
        }
        const code = url.searchParams.get("code");
        try {
          const app = await github.request("POST", `/app-manifests/${encodeURIComponent(code)}/conversions`, {});
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(DONE_HTML);
          finish(null, app);
        } catch (error) {
          res.writeHead(500).end("GitHub did not return the app. Check the terminal.");
          finish(error);
        }
        return;
      }
      res.writeHead(404).end();
    });

    const timer = setTimeout(() => finish(new Error("Timed out waiting for the GitHub App to be created.")), timeoutMs);
    timer.unref?.();

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const start = `http://127.0.0.1:${port}/`;
      log(`Opening ${start} to create the app on GitHub. If no browser opens, visit it yourself.`);
      openUrl(start);
    });
    server.on("error", (error) => finish(error));
  });
}

/** Where the app is installed from. */
export function installAppUrl({ slug, githubUrl = DEFAULT_GITHUB_URL }) {
  return `${githubUrl}/apps/${slug}/installations/new`;
}

/** The app's settings page, where device flow is switched on and permissions changed. */
export function appSettingsUrl({ slug, owner, ownerType, githubUrl = DEFAULT_GITHUB_URL }) {
  return ownerType === "Organization"
    ? `${githubUrl}/organizations/${owner}/settings/apps/${slug}`
    : `${githubUrl}/settings/apps/${slug}`;
}
