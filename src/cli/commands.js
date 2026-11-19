// The terminal commands: `ako release …`, `ako login`, `ako logout`,
// `ako whoami`, and the `ako` chat.

import { join } from "node:path";
import { readEnvFile } from "../config/env.js";
import { DEFAULT_API_URL } from "../github/client.js";
import { DEFAULT_GITHUB_URL } from "../github/manifest.js";
import { openWorkspace } from "../engine/workspace.js";
import { aiSettings } from "../ai/provider.js";
import { understand } from "../ai/intent.js";
import { runRequest, HELP } from "./actions.js";
import { signIn, loadCredentials, forgetCredentials } from "./login.js";
import { openUrl as defaultOpenUrl } from "../setup/openUrl.js";
import { SetupCancelled } from "../setup/pretty.js";

export const RELEASE_ACTIONS = ["ready", "create", "status", "announce", "request", "approve", "hold", "watch", "archive", "unlock"];
const TAG = /\d{8}_\d+$/;

/** `ako release <action> [tag|project] [--project p] [--items 1,2] [--all] [--new] [--note "…"] [--yes]` */
export function parseReleaseArgs(args) {
  const [action, ...rest] = args;
  const request = { action, project: null, tag: null, items: null, all: false, newRelease: false, note: null, yes: false };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--project" || arg === "-p") request.project = rest[++i];
    else if (arg === "--items") request.items = String(rest[++i] ?? "").split(",").filter(Boolean);
    else if (arg === "--all") request.all = true;
    else if (arg === "--new") request.newRelease = true;
    else if (arg === "--note") request.note = rest[++i];
    else if (arg === "--yes" || arg === "-y") request.yes = true;
    else if (TAG.test(arg)) request.tag = arg;
    else request.project ??= arg;
  }
  return request;
}

function settings(cwd, env) {
  return { ...env, ...readEnvFile(join(cwd, ".env")) };
}

/**
 * The workspace, acting as the signed-in person when there is one. Its
 * `signIn(prompter)` signs in on the way and switches it to that person, for
 * a step that needs one.
 */
export function openSignedIn(options = {}) {
  const open = ({ cwd = process.cwd(), env = process.env, fetch = globalThis.fetch, credentialsPath } = {}) => {
    const vars = settings(cwd, env);
    const user = loadCredentials(vars.GITHUB_APP_CLIENT_ID, credentialsPath ? { path: credentialsPath } : undefined);
    return openWorkspace({ cwd, env, fetch, user });
  };
  const ws = open(options);
  ws.signIn = async (prompter) => {
    if ((await login({ prompter, ...options })) !== 0) return false;
    Object.assign(ws, open(options));
    return true;
  };
  return ws;
}

export async function release(args, { prompter, ...options }) {
  const request = parseReleaseArgs(args);
  if (!RELEASE_ACTIONS.includes(request.action)) {
    prompter.write(`Usage: npx ako release <${RELEASE_ACTIONS.join("|")}> [project or tag] [options]\n\n${HELP.join("\n")}\n`);
    return 2;
  }
  const ws = openSignedIn(options);
  const { ok } = await runRequest(ws, request, prompter);
  return ok ? 0 : 1;
}

/** `ako login`: GitHub's device flow, through the AKO app. */
export async function login({ prompter: p, cwd = process.cwd(), env = process.env, fetch = globalThis.fetch, openUrl = defaultOpenUrl, credentialsPath }) {
  const vars = settings(cwd, env);
  const clientId = vars.GITHUB_APP_CLIENT_ID;
  if (!clientId) {
    p.write("  ✗ GITHUB_APP_CLIENT_ID isn't set. Run `npx ako setup`, or copy the Client ID from the app's settings into .env.\n");
    return 1;
  }
  const user = await signIn({
    clientId,
    githubUrl: vars.GITHUB_URL || DEFAULT_GITHUB_URL,
    apiUrl: vars.GITHUB_API_URL || DEFAULT_API_URL,
    fetch,
    path: credentialsPath,
    onCode: ({ code, url }) => {
      p.note([`Code: ${code}`, `Enter it at ${url}`, "", "Waiting for you to confirm…"], "Sign in on GitHub");
      openUrl(url);
    },
  });
  p.write(`Signed in as @${user.login}. Merges, tags and approvals from this terminal now show as you.\n`);
  return 0;
}

export function logout({ prompter: p, cwd = process.cwd(), env = process.env, credentialsPath }) {
  const vars = settings(cwd, env);
  const had = vars.GITHUB_APP_CLIENT_ID && forgetCredentials(vars.GITHUB_APP_CLIENT_ID, credentialsPath ? { path: credentialsPath } : undefined);
  p.write(had ? "Signed out.\n" : "You weren't signed in.\n");
  return 0;
}

export function whoami({ prompter: p, cwd = process.cwd(), env = process.env, credentialsPath }) {
  const vars = settings(cwd, env);
  const user = loadCredentials(vars.GITHUB_APP_CLIENT_ID, credentialsPath ? { path: credentialsPath } : undefined);
  p.write(user ? `@${user.login}${user.expiresAt ? ` (until ${user.expiresAt.slice(11, 16)} UTC)` : ""}\n` : "Not signed in. Run `npx ako login`.\n");
  return 0;
}

/**
 * `ako`: ask in plain words, one request after another, until "exit" or Esc
 * at the main question. Esc at a question inside a request stops only that
 * request; whatever it already did on GitHub stays done.
 */
export async function chat({ prompter: p, ...options }) {
  const ws = openSignedIn(options);
  const ai = aiSettings(ws.vars);
  p.intro("Deriv AKO");
  p.write(
    `${ws.actor.kind === "github" ? `Signed in as @${ws.actor.login}.` : "Not signed in: AKO acts as its app, and offers to sign you in when a step needs you."} ` +
      `Ask for what you need, like "create release for ${ws.flow.projects[0].key}", or type help. Esc or "exit" leaves.\n`,
  );
  const stopped = (error) => {
    if (!(error instanceof SetupCancelled)) throw error;
  };
  for (;;) {
    let text;
    try {
      text = await p.ask("What do you need?", { optional: true });
    } catch (error) {
      stopped(error);
      break;
    }
    if (!text) continue;
    if (/^(exit|quit|bye)$/i.test(text.trim())) break;
    const request = await understand(text, ws.flow.projects, { ai, fetch: options.fetch });
    await runRequest(ws, request, p).catch(stopped);
  }
  p.outro("Bye.");
  return 0;
}
