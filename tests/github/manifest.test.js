import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildGitHubAppManifest,
  createAppFromManifest,
  manifestFormHtml,
  newAppUrl,
  appSettingsUrl,
} from "../../src/github/manifest.js";
import { manifestFiles } from "../../scripts/write-manifests.js";

test("the files in manifests/ match the code that builds them", () => {
  for (const [path, text] of Object.entries(manifestFiles())) {
    assert.equal(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"), text, `${path} is stale: run node scripts/write-manifests.js`);
  }
});

test("the app manifest has no webhook and only the permissions asked for", () => {
  const manifest = buildGitHubAppManifest({ name: "AKO acme", permissions: { checks: "read" } });
  assert.equal(manifest.hook_attributes.active, false);
  assert.deepEqual(manifest.default_events, []);
  assert.equal(manifest.public, false);
  assert.equal(manifest.default_permissions.checks, "read");
  assert.equal(manifest.default_permissions.organization_projects, undefined);
});

test("organization apps and personal apps are created in different places", () => {
  assert.equal(newAppUrl({ owner: "acme", ownerType: "Organization", state: "s" }), "https://github.com/organizations/acme/settings/apps/new?state=s");
  assert.equal(newAppUrl({ owner: null, ownerType: "User", state: "s" }), "https://github.com/settings/apps/new?state=s");
  assert.equal(appSettingsUrl({ slug: "ako", owner: "acme", ownerType: "Organization" }), "https://github.com/organizations/acme/settings/apps/ako");
});

test("the manifest form escapes the JSON into its attribute", () => {
  const html = manifestFormHtml({ action: "https://github.com/x", manifest: { name: '"><script>' } });
  assert.doesNotMatch(html, /"><script>/);
  assert.match(html, /&lt;script>/);
});

test("the manifest flow trades GitHub's code for the app, and refuses a wrong state", async () => {
  let started;
  const githubFetch = async (url, init) => {
    assert.equal(init.method, "POST");
    assert.match(String(url), /\/app-manifests\/the-code\/conversions$/);
    return new Response(JSON.stringify({ id: 42, slug: "ako-acme", client_id: "Iv1.test", pem: "PEM" }), { status: 201 });
  };
  const created = createAppFromManifest({
    name: "AKO acme",
    owner: "acme",
    ownerType: "Organization",
    fetch: githubFetch,
    openUrl: (url) => started(url),
  });
  const startUrl = await new Promise((resolve) => (started = resolve));

  const page = await (await fetch(startUrl)).text();
  const state = page.match(/state=([0-9a-f]+)/)[1];
  assert.match(page, /organizations\/acme\/settings\/apps\/new/);
  assert.match(page, /redirect_url&quot;:&quot;http:\/\/127\.0\.0\.1:\d+\/callback/);

  const wrong = await fetch(new URL(`/callback?state=nope&code=the-code`, startUrl));
  assert.equal(wrong.status, 400);

  const done = await fetch(new URL(`/callback?state=${state}&code=the-code`, startUrl));
  assert.equal(done.status, 200);
  assert.deepEqual(await created, { id: 42, slug: "ako-acme", client_id: "Iv1.test", pem: "PEM" });
});

test("THIRD_PARTY_NOTICES.md lists every installed dependency", async () => {
  const { noticesText } = await import("../../scripts/third-party-notices.js");
  const current = readFileSync(new URL("../../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  assert.equal(current, noticesText(), "stale: run node scripts/third-party-notices.js");
});
