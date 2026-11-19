import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { createAppJwt, createGitHubApp, readPrivateKey } from "../../src/github/appAuth.js";
import { createGitHubClient, GitHubError } from "../../src/github/client.js";
import { permissionsFor, missingPermissions, BASE_PERMISSIONS } from "../../src/github/permissions.js";
import { fakeFetch, testPrivateKeyPem } from "../helpers/fakes.js";

const { privateKey: pem, publicKey } = testPrivateKeyPem();

test("the app JWT is signed with the key and backdated for clock skew", () => {
  const now = Date.UTC(2026, 10, 2, 9, 0, 0);
  const jwt = createAppJwt({ appId: 42, privateKey: pem, now });
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.iss, "42");
  assert.equal(claims.iat, now / 1000 - 60);
  assert.equal(claims.exp - claims.iat, 600);
  assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), createPublicKey(publicKey), Buffer.from(signature, "base64url")));
});

test("readPrivateKey accepts base64, a raw PEM with escaped newlines, or nothing", () => {
  assert.equal(readPrivateKey({}), null);
  assert.equal(readPrivateKey({ GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(pem).toString("base64") }).type, "private");
  assert.equal(readPrivateKey({ GITHUB_APP_PRIVATE_KEY: pem.replace(/\n/g, "\\n") }).type, "private");
});

test("installation tokens are picked per owner and cached until near expiry", async () => {
  let minted = 0;
  const fetch = fakeFetch([
    ["GET", /\/app\/installations\?/, [{ id: 7, account: { login: "acme" } }]],
    ["POST", /\/app\/installations\/7\/access_tokens$/, () => ({ token: `token-${++minted}`, expires_at: new Date(Date.now() + 3600e3).toISOString() })],
    ["GET", /\/repos\/acme\/web-app$/, (_, init) => ({ auth: init.headers.Authorization })],
  ]);
  const app = createGitHubApp({ appId: 42, privateKey: pem, fetch });
  const github = await app.clientForOwner("ACME");
  assert.equal((await github.request("GET", "/repos/acme/web-app")).auth, "Bearer token-1");
  assert.equal((await github.request("GET", "/repos/acme/web-app")).auth, "Bearer token-1");
  assert.equal(minted, 1);
  await assert.rejects(app.clientForOwner("other-org"), /not installed on "other-org"/);
});

test("a non-JSON error page reports its status, never a JSON parse error", async () => {
  const fetch = async () => new Response("<!DOCTYPE html><title>502</title>", { status: 502 });
  const github = createGitHubClient({ token: "t", fetch });
  await assert.rejects(github.request("GET", "/repos/acme/web-app"), (error) => {
    assert.ok(error instanceof GitHubError);
    assert.equal(error.status, 502);
    assert.doesNotMatch(error.message, /JSON\.parse|Unexpected token/);
    return true;
  });
});

test("GraphQL errors throw", async () => {
  const fetch = fakeFetch([["POST", /\/graphql$/, { errors: [{ message: "Could not resolve to a ProjectV2" }] }]]);
  await assert.rejects(createGitHubClient({ fetch }).graphql("query { x }"), /Could not resolve/);
});

test("GraphQL goes to /api/graphql on GitHub Enterprise Server", async () => {
  const fetch = fakeFetch([["POST", /\/api\/graphql$/, { data: { ok: true } }]]);
  const github = createGitHubClient({ apiUrl: "https://github.example.com/api/v3", fetch });
  assert.deepEqual(await github.graphql("query { ok }"), { ok: true });
});

test("permissions grow only with what the flow file uses", () => {
  assert.deepEqual(permissionsFor([]), BASE_PERMISSIONS);
  const permissions = permissionsFor([
    { tracker: { type: "github-projects" }, deploy: { type: "check-run" }, people: { release_managers: { github: ["acme/leads"] } } },
    { tracker: { type: "clickup" }, deploy: { type: "commit-status" } },
  ]);
  assert.equal(permissions.organization_projects, "write");
  assert.equal(permissions.checks, "read");
  assert.equal(permissions.statuses, "read");
  assert.equal(permissions.members, "read");
});

test("missingPermissions compares access levels", () => {
  const missing = missingPermissions({ contents: "read", issues: "write", metadata: "read" }, { contents: "write", issues: "read", checks: "read" });
  assert.deepEqual(missing, [
    { name: "contents", level: "write", granted: "read" },
    { name: "checks", level: "read", granted: "none" },
  ]);
});
