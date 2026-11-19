// Everything a command needs to act on a project: the flow file, the secrets
// in .env, and a GitHub client that acts as the right identity.
//
// In the terminal, a person signed in with `ako login` acts as themselves
// through the app: GitHub records the merge or tag under their name, and they
// can only do what both they and the app may. The Slack bot, and a terminal
// without a sign-in, act as the app itself.

import { join } from "node:path";
import { readEnvFile } from "../config/env.js";
import { loadFlow, FLOW_FILE } from "../config/flow.js";
import { createGitHubApp, readPrivateKey } from "../github/appAuth.js";
import { createGitHubClient, DEFAULT_API_URL } from "../github/client.js";
import { createClickUpClient } from "../trackers/clickup.js";
import { createSlackClient } from "../chat/slack.js";
import { createTracker } from "../trackers/index.js";
import { createStore } from "./store.js";
import { githubActor, APP_ACTOR } from "./people.js";

export class SetupNeeded extends Error {
  constructor(message) {
    super(message);
    this.name = "SetupNeeded";
  }
}

/**
 * Opens the workspace in `cwd`. `user` is a signed-in person's
 * `{ token, login }` from `ako login`, or null to act as the app.
 */
export function openWorkspace({ cwd = process.cwd(), env = process.env, fetch = globalThis.fetch, user = null } = {}) {
  const vars = { ...env, ...readEnvFile(join(cwd, ".env")) };
  const { flow, warnings } = loadFlow(join(cwd, FLOW_FILE));
  const apiUrl = vars.GITHUB_API_URL || DEFAULT_API_URL;

  const privateKey = vars.GITHUB_APP_ID ? readPrivateKey(vars) : null;
  const app = privateKey ? createGitHubApp({ appId: vars.GITHUB_APP_ID, privateKey, apiUrl, fetch }) : null;
  const clickup = vars.CLICKUP_API_TOKEN ? createClickUpClient({ token: vars.CLICKUP_API_TOKEN, fetch }) : null;
  const slack = vars.SLACK_BOT_TOKEN ? createSlackClient({ token: vars.SLACK_BOT_TOKEN, fetch }) : null;
  const userClient = user ? createGitHubClient({ token: user.token, apiUrl, fetch }) : null;

  async function clientFor(owner) {
    if (userClient) return userClient;
    if (app) return app.clientForOwner(owner);
    throw new SetupNeeded("GitHub isn't connected. Run `npx ako setup`, or sign in with `npx ako login`.");
  }

  return {
    vars,
    flow,
    warnings,
    app,
    slack,
    clickup,
    apiUrl,
    actor: user ? githubActor(user.login) : APP_ACTOR,

    /** The project a name refers to: its key, an alias or its display name. */
    findProject(name) {
      if (!name) return flow.projects.length === 1 ? flow.projects[0] : null;
      const wanted = String(name).toLowerCase();
      return flow.projects.find((p) => [p.key, p.name, ...p.aliases].some((n) => n.toLowerCase() === wanted)) ?? null;
    },

    /** The engine's view of one project. */
    async envFor(project) {
      const owner = project.repo.split("/")[0];
      const gh = await clientFor(owner);
      const boardOwner = project.tracker.type === "github-projects" ? project.tracker.owner : owner;
      const boardGh = boardOwner.toLowerCase() === owner.toLowerCase() ? gh : await clientFor(boardOwner);
      return {
        project,
        gh,
        slack,
        // A signed-in person acts as themselves; the app is the fallback for a protected tag.
        appClient: userClient && app ? () => app.clientForOwner(owner) : null,
        tracker: createTracker(project, { gh, boardGh, clickup }),
        store: createStore(gh, project, { botLogin: vars.GITHUB_APP_SLUG ? `${vars.GITHUB_APP_SLUG}[bot]` : null }),
      };
    },
  };
}
