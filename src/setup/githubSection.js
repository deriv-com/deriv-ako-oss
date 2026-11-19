// Setup step: connect AKO to GitHub through its own GitHub App, and offer to
// sign the person running the setup in, so they can approve from the terminal.

import { existsSync, readFileSync } from "node:fs";
import { createPrivateKey } from "node:crypto";
import { readPrivateKey } from "../github/appAuth.js";
import { DEFAULT_API_URL } from "../github/client.js";
import { DEFAULT_GITHUB_URL, installAppUrl, appSettingsUrl } from "../github/manifest.js";
import { BASE_PERMISSIONS } from "../github/permissions.js";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** `quick` uses the app already in .env without asking, and skips the sign-in, for adding a project. */
export async function setupGitHub(ctx, { quick = false } = {}) {
  const p = ctx.prompter;
  p.write("\n== GitHub ==\n");
  p.write("AKO uses its own GitHub App, never a personal token. Merges and tags show as the app.\n");

  const { env } = ctx;
  const hasApp = env.GITHUB_APP_ID && (env.GITHUB_APP_PRIVATE_KEY_BASE64 || env.GITHUB_APP_PRIVATE_KEY || env.GITHUB_APP_PRIVATE_KEY_PATH);
  const reuse = hasApp && (quick || (await p.confirm(`Use the GitHub App already in .env (ID ${env.GITHUB_APP_ID})?`)));
  if (!reuse || !(await tryConnect(ctx))) {
    const mode = await p.choose(
      "How do you want to connect GitHub?",
      [
        { label: "Create a new GitHub App for AKO (recommended)", value: "create" },
        { label: "Use a GitHub App I already created", value: "existing" },
      ],
      { default: "create" },
    );
    if (mode === "create") await createApp(ctx);
    else await useExistingApp(ctx);
  }

  await waitForInstall(ctx);
  if (!quick) await offerSignIn(ctx);
}

/**
 * Asking for and giving approvals from the terminal is done as a person, who
 * signs in through the app with GitHub's device flow. That needs the app's
 * "Enable Device Flow" setting, which GitHub only shows on its settings page
 * and offers no way to read. So this tries to sign in first, and opens that
 * page only when GitHub says the setting is off.
 */
async function offerSignIn(ctx) {
  const p = ctx.prompter;
  const clientId = ctx.env.GITHUB_APP_CLIENT_ID;
  const settings = appSettingsUrl({ ...ctx.appInfo, githubUrl: githubUrl(ctx) });
  if (!clientId) {
    ctx.todo.push(
      `Copy the app's Client ID into .env as GITHUB_APP_CLIENT_ID and turn on "Enable Device Flow" at ${settings}, so people can sign in with \`npx ako login\`.`,
    );
    return;
  }
  const current = ctx.services.loadCredentials(clientId);
  if (current) {
    p.write(`  Signed in as @${current.login}.\n`);
    return;
  }

  p.write("People ask for and give approvals from the terminal as themselves, by signing in through the app.\n");
  const later = [
    { label: "Sign in now", value: true },
    { label: "Later, with npx ako login", value: false },
  ];
  const todo = () =>
    ctx.todo.push(`Turn on "Enable Device Flow" at ${settings} if it's off, then sign in with \`npx ako login\` to ask for and give approvals.`);
  if (!(await p.choose("Sign in as yourself?", later, { default: true }))) {
    todo();
    return;
  }
  for (;;) {
    try {
      const user = await ctx.services.signIn({
        clientId,
        githubUrl: githubUrl(ctx),
        apiUrl: apiUrl(ctx),
        fetch: ctx.fetch,
        onCode: ({ code, url }) => {
          p.note([`Code: ${code}`, `Enter it at ${url}`, "Waiting for you to confirm…"], "Sign in on GitHub");
          ctx.openUrl(url);
        },
      });
      p.write(`  Signed in as @${user.login}. Approvals from this terminal show as you.\n`);
      return;
    } catch (error) {
      if (error.code === "device_flow_disabled") {
        // GitHub made no code, so there's nothing to cancel: turn it on and ask again.
        p.write(
          [
            "  ! Signing in needs one setting the app doesn't have yet.",
            `On the app's settings page, tick "Enable Device Flow" and save: ${settings}`,
            "",
          ].join("\n"),
        );
        ctx.openUrl(settings);
        await p.pause("Continue once it's saved.");
        continue;
      }
      p.write(`  ✗ ${error.message}\n`);
      if (!(await p.choose("Try signing in again?", later, { default: true }))) {
        todo();
        return;
      }
    }
  }
}

async function createApp(ctx) {
  const p = ctx.prompter;
  const ownerType = await p.choose(
    "Who should own the app? Use the account that owns your repos.",
    [
      { label: "An organization", value: "Organization" },
      { label: "My personal account", value: "User" },
    ],
    { default: "Organization" },
  );
  const owner =
    ownerType === "Organization"
      ? await p.ask("Organization name, as in github.com/<name>", {
          validate: (v) => (LOGIN.test(v) ? null : "That isn't a GitHub organization name."),
        })
      : null;
  const name = await p.ask("App name (it must be unique on GitHub)", {
    default: owner ? `AKO ${owner}`.slice(0, 34) : "AKO",
    validate: (v) => (v.length <= 34 ? null : "GitHub allows at most 34 characters."),
  });

  const boards = await p.chooseMany(
    "Which boards will your projects use?",
    [
      { label: "GitHub Projects", value: "github-projects" },
      { label: "GitHub issues with labels", value: "github-issues" },
      { label: "ClickUp", value: "clickup" },
    ],
    { defaults: ["github-projects"] },
  );
  const deploys = await p.chooseMany(
    "How do your deploys report back on GitHub?",
    [
      { label: "GitHub Actions", value: "actions" },
      { label: "Commit statuses (CircleCI, Jenkins, Bitrise...)", value: "commit-status" },
      { label: "Check runs (Google Cloud Build...)", value: "check-run" },
      { label: "Nothing to watch", value: "none" },
    ],
    { defaults: ["actions"] },
  );

  const permissions = { ...BASE_PERMISSIONS };
  if (boards.includes("github-projects")) permissions.organization_projects = "write";
  if (deploys.includes("commit-status")) permissions.statuses = "read";
  if (deploys.includes("check-run")) permissions.checks = "read";

  const app = await ctx.services.createAppFromManifest({
    name,
    owner,
    ownerType,
    permissions,
    githubUrl: githubUrl(ctx),
    apiUrl: apiUrl(ctx),
    fetch: ctx.fetch,
    openUrl: ctx.openUrl,
    log: (line) => p.write(`${line}\n`),
  });

  // Saved straight away: the private key is only ever shown once.
  ctx.saveEnv(
    {
      GITHUB_APP_ID: String(app.id),
      GITHUB_APP_CLIENT_ID: app.client_id,
      GITHUB_APP_SLUG: app.slug,
      GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(app.pem).toString("base64"),
    },
    "GitHub App, created by npx ako setup",
  );
  p.write(`  Created the GitHub App "${app.name ?? name}" (ID ${app.id}). Its key is saved in .env.\n`);
  await connect(ctx);
}

async function useExistingApp(ctx) {
  do {
    await askExistingApp(ctx);
  } while (!(await tryConnect(ctx)));
}

async function askExistingApp(ctx) {
  const p = ctx.prompter;
  const appId = await p.ask("App ID, from the app's settings page", {
    default: ctx.env.GITHUB_APP_ID,
    validate: (v) => (/^\d+$/.test(v) ? null : "The App ID is a number."),
  });
  const clientId = await p.ask("Client ID, from the same page (needed for `npx ako login`)", {
    default: ctx.env.GITHUB_APP_CLIENT_ID,
    optional: true,
  });
  const keyPath = await p.ask("Path to the app's private key (.pem)", {
    validate: (v) => {
      if (!existsSync(v)) return `No file at ${v}.`;
      try {
        createPrivateKey(readFileSync(v, "utf8"));
        return null;
      } catch {
        return "That file isn't a private key.";
      }
    },
  });
  ctx.saveEnv(
    {
      GITHUB_APP_ID: appId,
      GITHUB_APP_CLIENT_ID: clientId || null,
      GITHUB_APP_PRIVATE_KEY_BASE64: readFileSync(keyPath).toString("base64"),
    },
    "GitHub App",
  );
}

/** Connects, or explains why GitHub refused the app and returns false. */
async function tryConnect(ctx) {
  try {
    await connect(ctx);
    return true;
  } catch (error) {
    if (error.status !== 401 && error.status !== 404) throw error;
    ctx.prompter.write(`  ✗ GitHub refused the app (${error.data?.message ?? error.status}). Check the App ID belongs to this private key.\n`);
    return false;
  }
}

async function connect(ctx) {
  ctx.githubApp = ctx.services.createGitHubApp({
    appId: ctx.env.GITHUB_APP_ID,
    privateKey: readPrivateKey(ctx.env),
    apiUrl: apiUrl(ctx),
    fetch: ctx.fetch,
  });
  const app = await ctx.githubApp.getApp();
  ctx.appInfo = { slug: app.slug, owner: app.owner?.login, ownerType: app.owner?.type };
  if (app.slug && ctx.env.GITHUB_APP_SLUG !== app.slug) ctx.saveEnv({ GITHUB_APP_SLUG: app.slug });
  ctx.prompter.write(`  Connected to the GitHub App "${app.name}".\n`);
}

async function waitForInstall(ctx) {
  const p = ctx.prompter;
  const url = installAppUrl({ slug: ctx.appInfo.slug, githubUrl: githubUrl(ctx) });
  for (;;) {
    const installations = await ctx.githubApp.listInstallations({ refresh: true });
    if (installations.length) {
      p.write(`  Installed on: ${installations.map((i) => i.account.login).join(", ")}\n`);
      if (!(await p.confirm("Install it on another account too?", false))) return installations;
    } else {
      p.write("  ! The app isn't installed anywhere yet.\n");
    }
    p.write(`Install it on the account that owns your repos, and pick the repos AKO releases:\n  ${url}\n`);
    ctx.openUrl(url);
    await p.pause("Continue once it's installed.");
  }
}

export function apiUrl(ctx) {
  return ctx.env.GITHUB_API_URL || DEFAULT_API_URL;
}

export function githubUrl(ctx) {
  return ctx.env.GITHUB_URL || DEFAULT_GITHUB_URL;
}
