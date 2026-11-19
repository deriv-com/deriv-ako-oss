// Stand-ins for GitHub, Slack and the app-creation flow, shared by the
// terminal and browser setup tests.

import { testPrivateKeyPem } from "./fakes.js";

export const PEM = testPrivateKeyPem().privateKey;
const STATUSES = ["Backlog", "In Progress", "Ready for Staging", "Staged", "Ready for Release", "Done"];

export function fakeGitHub() {
  return {
    async graphql(query) {
      if (query.includes("projectsV2(first")) {
        return { organization: { projectsV2: { nodes: [{ number: 3, title: "Web App", closed: false }] } } };
      }
      return { organization: { projectV2: { title: "Web App", url: "", fields: { nodes: [{ name: "Status", options: STATUSES.map((name) => ({ name })) }] } } } };
    },
    async request(method, path) {
      if (/\/repos\/acme\/web-app\/branches\/main$/.test(path)) return {};
      if (/\/actions\/workflows/.test(path)) return { workflows: [{ path: ".github/workflows/deploy.yml" }] };
      if (/^\/users\/alice$/.test(path)) return {};
      const error = new Error(`not found: ${path}`);
      error.status = 404;
      throw error;
    },
    async paginate() {
      return [];
    },
  };
}

export function fakeSetupServices(created = []) {
  return {
    async createAppFromManifest(options) {
      created.push(options);
      return { id: 42, slug: "ako-acme", client_id: "Iv1.test", name: options.name, pem: PEM };
    },
    createGitHubApp() {
      return {
        getApp: async () => ({ name: "AKO acme", slug: "ako-acme", owner: { login: "acme", type: "Organization" } }),
        listInstallations: async () => [{ id: 7, account: { login: "acme" } }],
        listRepos: async () => [{ full_name: "acme/web-app", name: "web-app", owner: "acme", ownerType: "Organization", default_branch: "main" }],
        clientForOwner: async () => fakeGitHub(),
      };
    },
    createSlackClient({ token }) {
      return {
        async call(method) {
          if (method === "auth.test") return { ok: true, team: "Acme", user: "ako" };
          if (method === "apps.connections.open") {
            if (!token.startsWith("xapp-")) throw Object.assign(new Error("bad"), { code: "not_allowed_token_type" });
            return { ok: true };
          }
          if (method === "usergroups.list") return { usergroups: [{ id: "S000000001", handle: "release-managers", name: "Release managers" }] };
          throw new Error(`unexpected ${method}`);
        },
        async paginate(method) {
          if (method === "conversations.list") return [{ id: "C000000001", name: "releases", is_member: false }];
          if (method === "users.list") return [{ id: "U000000002", name: "bob", real_name: "Bob Example", profile: { display_name: "bob" } }];
          return [];
        },
      };
    },
    async listModels() {
      throw new Error("not used");
    },
    // Nobody is signed in, and signing in never reaches GitHub.
    loadCredentials: () => null,
    async signIn({ onCode }) {
      onCode({ code: "ABCD-1234", url: "https://github.com/login/device" });
      return { login: "alice" };
    },
  };
}
