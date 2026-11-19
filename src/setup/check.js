// `ako check` (`npm run check`): tests every connection the flow file relies
// on, so a wrong token, missing permission or misspelled status shows up
// before the first release instead of in the middle of one.

import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readEnvFile } from "../config/env.js";
import { FLOW_FILE, parseFlow } from "../config/flow.js";
import { createGitHubApp, readPrivateKey } from "../github/appAuth.js";
import { DEFAULT_API_URL } from "../github/client.js";
import { DEFAULT_GITHUB_URL, appSettingsUrl, installAppUrl } from "../github/manifest.js";
import { permissionsFor, missingPermissions } from "../github/permissions.js";
import { trackerStatuses, unknownStatuses } from "../trackers/index.js";
import { createClickUpClient } from "../trackers/clickup.js";
import { aiSettings, checkAiProvider } from "../ai/provider.js";
import { createSlackClient } from "../chat/slack.js";

const MARK = { ok: "✓", warn: "!", fail: "✗", info: "·" };

export async function runCheck({
  cwd = process.cwd(),
  env: baseEnv = process.env,
  fetch = globalThis.fetch,
  post = true,
  write = (text) => process.stdout.write(text),
} = {}) {
  const results = [];
  const report = (status, area, message) => {
    results.push({ status, area, message });
    write(`${MARK[status]} ${area}: ${message}\n`);
  };

  const envPath = join(cwd, ".env");
  const env = { ...baseEnv, ...readEnvFile(envPath) };
  if (!existsSync(envPath)) report("warn", "files", "no .env file, so only environment variables are used");

  const flow = readFlow(join(cwd, FLOW_FILE), report);
  const app = await checkGitHubApp(env, fetch, report);

  if (flow && app) {
    for (const project of flow.projects) await checkProject(project, { env, fetch, app, report });
  }
  await checkAi(env, fetch, report);
  if (flow) await checkSlack(flow, { env, fetch, post, report });

  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  write(
    failed
      ? `\n${failed} problem(s) to fix${warned ? ` and ${warned} warning(s)` : ""}. Fix them and run \`npx ako check\` again.\n`
      : `\nAll set${warned ? `, with ${warned} warning(s) worth a look` : ""}.\n`,
  );
  return { results, failed, warned };
}

function readFlow(path, report) {
  if (!existsSync(path)) {
    report("fail", "files", `no ${FLOW_FILE}. Run \`npx ako setup\` to create it`);
    return null;
  }
  const { flow, errors, warnings } = parseFlow(readFileSync(path, "utf8"));
  for (const error of errors) report("fail", FLOW_FILE, error);
  for (const warning of warnings) report("warn", FLOW_FILE, warning);
  if (errors.length) return null;
  report("ok", FLOW_FILE, `${flow.projects.length} project(s): ${flow.projects.map((p) => p.key).join(", ")}`);
  return flow;
}

async function checkGitHubApp(env, fetch, report) {
  if (!env.GITHUB_APP_ID) {
    report("fail", "GitHub", "GITHUB_APP_ID is not set. Run `npx ako setup`");
    return null;
  }
  let privateKey;
  try {
    privateKey = readPrivateKey(env);
  } catch (error) {
    report("fail", "GitHub", `the app's private key can't be read: ${error.message}`);
    return null;
  }
  if (!privateKey) {
    report("fail", "GitHub", "no private key. Set GITHUB_APP_PRIVATE_KEY_BASE64 or GITHUB_APP_PRIVATE_KEY_PATH");
    return null;
  }

  const githubUrl = env.GITHUB_URL || DEFAULT_GITHUB_URL;
  const app = createGitHubApp({ appId: env.GITHUB_APP_ID, privateKey, apiUrl: env.GITHUB_API_URL || DEFAULT_API_URL, fetch });
  try {
    const info = await app.getApp();
    app.info = { id: info.id, slug: info.slug, owner: info.owner?.login, ownerType: info.owner?.type, githubUrl };
    report("ok", "GitHub", `signed in as the app "${info.name}"`);
  } catch (error) {
    report("fail", "GitHub", `GitHub refused the app (${error.status ?? error.message}). Check GITHUB_APP_ID belongs to this key`);
    return null;
  }
  if (!env.GITHUB_APP_CLIENT_ID) {
    report("warn", "GitHub", "GITHUB_APP_CLIENT_ID is not set, so `npx ako login` won't work in the terminal");
  }
  return app;
}

async function checkProject(project, { env, fetch, app, report }) {
  const area = project.key;
  const [owner] = project.repo.split("/");
  const installation = await app.installationFor(owner);
  if (!installation) {
    report("fail", area, `the app isn't installed on ${owner}. Install it: ${installAppUrl(app.info)}`);
    return;
  }

  // A board in another org is read through that org's installation instead.
  const boardElsewhere = project.tracker.type === "github-projects" && project.tracker.owner.toLowerCase() !== owner.toLowerCase();
  const needed = permissionsFor([project]);
  if (boardElsewhere) delete needed.organization_projects;
  const missing = missingPermissions(installation.permissions, needed);
  if (missing.length) {
    const list = missing.map((m) => `${m.name}: ${m.level} (has ${m.granted})`).join(", ");
    report(
      "fail",
      area,
      `the app needs more permissions: ${list}. Add them at ${appSettingsUrl(app.info)}/permissions, then accept them on the installation`,
    );
  }

  const github = await app.clientForOwner(owner);
  let repo;
  try {
    repo = await github.request("GET", `/repos/${project.repo}`);
    report("ok", area, `can reach ${project.repo}`);
  } catch (error) {
    report("fail", area, `can't reach ${project.repo} (${error.status}). Add it to the app's installation on ${owner}`);
    return;
  }

  await checkBranches(project, repo, github, report);
  const boardGithub = boardElsewhere ? await boardClient(project, { app, report }) : github;
  if (boardGithub) await checkTracker(project, { env, fetch, github: boardGithub, report });
  await checkDeploy(project, github, report);
  await checkGitHubPeople(project, github, report);
  await checkTagProtection(project, { github, appId: app.info.id, report });
}

/**
 * A GitHub Projects board can belong to another org than the repo, and an
 * installation token only sees its own account, so that board is read with
 * the board org's installation. Returns null after reporting when it can't be.
 */
async function boardClient(project, { app, report }) {
  const { owner } = project.tracker;
  const installation = await app.installationFor(owner);
  if (!installation) {
    report("fail", project.key, `the board belongs to ${owner}, where the app isn't installed. Install it there too: ${installAppUrl(app.info)}`);
    return null;
  }
  const missing = missingPermissions(installation.permissions, { organization_projects: "write" });
  if (missing.length) {
    report(
      "fail",
      project.key,
      `the app's installation on ${owner} needs organization_projects: write to read the board (has ${missing[0].granted}). Add it at ${appSettingsUrl(app.info)}/permissions`,
    );
  }
  return app.clientForOwner(owner);
}

async function checkBranches(project, repo, github, report) {
  const { release } = project;
  const branches = release.type === "release-branch" ? [release.from, release.to] : [release.branch ?? repo.default_branch];
  for (const branch of branches) {
    try {
      await github.request("GET", `/repos/${project.repo}/branches/${encodeURIComponent(branch).replace(/%2F/g, "/")}`);
    } catch (error) {
      report("fail", project.key, `branch "${branch}" (${error.status === 404 ? "not found" : error.status})`);
      return;
    }
  }
  report("ok", project.key, `releases ${release.type === "release-branch" ? `${release.from} → ${release.to}` : `from ${branches[0]}`}, tags ${release.tag_prefix}<date>_<n>`);
}

async function checkTracker(project, { env, fetch, github, report }) {
  const clickup = env.CLICKUP_API_TOKEN ? createClickUpClient({ token: env.CLICKUP_API_TOKEN, fetch }) : null;
  try {
    const info = await trackerStatuses(project, { github, clickup });
    const unknown = unknownStatuses(project.tracker, info.statuses);
    if (unknown.length) {
      report("fail", project.key, `"${info.title}" has no ${unknown.map((s) => `"${s}"`).join(", ")}. It has: ${info.statuses.join(", ")}`);
    } else {
      report("ok", project.key, `"${info.title}" has every status the flow uses`);
    }
  } catch (error) {
    report("fail", project.key, `can't read the ${project.tracker.type} tracker: ${error.message}`);
  }
}

async function checkDeploy(project, github, report) {
  const { deploy } = project;
  if (deploy.type === "actions") {
    try {
      await github.request("GET", `/repos/${project.repo}/actions/workflows/${encodeURIComponent(deploy.workflow)}`);
      report("ok", project.key, `watches the ${deploy.workflow} workflow`);
    } catch (error) {
      report("fail", project.key, `no workflow "${deploy.workflow}" in ${project.repo} (${error.status})`);
    }
  } else if (deploy.type === "commit-status") {
    report("info", project.key, `watches commit statuses starting "${deploy.context}" (checked on the first release)`);
  } else if (deploy.type === "check-run") {
    report("info", project.key, `watches check runs starting "${deploy.check}" (checked on the first release)`);
  }
}

async function checkGitHubPeople(project, github, report) {
  const entries = [...(project.people.release_managers.github ?? []), ...(project.people.qa.github ?? [])];
  for (const entry of new Set(entries)) {
    const [org, team] = entry.includes("/") ? entry.split("/") : [];
    try {
      await github.request("GET", team ? `/orgs/${org}/teams/${team}` : `/users/${entry}`);
    } catch (error) {
      report(
        team ? "warn" : "fail",
        project.key,
        team ? `can't read team ${entry} (${error.status}). It needs the app's Members permission` : `no GitHub user "${entry}"`,
      );
    }
  }
}

/**
 * Warns when anyone with write access could create a release tag and skip
 * the approval. Only a tag ruleset restricting creation closes that gap.
 */
async function checkTagProtection(project, { github, appId, report }) {
  const prefix = project.release.tag_prefix;
  const advice = `anyone with write access can create ${prefix}* tags and skip the approval. Add a tag ruleset (see docs/adopter-guide.md)`;
  let rulesets;
  try {
    rulesets = await github.request("GET", `/repos/${project.repo}/rulesets?includes_parents=true&per_page=100`);
  } catch (error) {
    report("warn", project.key, `can't read rulesets (${error.status}), so ${advice}. Private repos need a paid plan for rulesets`);
    return;
  }

  for (const summary of rulesets.filter((r) => r.target === "tag" && r.enforcement === "active")) {
    const ruleset = await github.request("GET", `/repos/${project.repo}/rulesets/${summary.id}?includes_parents=true`);
    const restrictsCreation = (ruleset.rules ?? []).some((r) => r.type === "creation");
    if (!restrictsCreation || !refMatches(ruleset.conditions?.ref_name, `refs/tags/${prefix}20260101_0`)) continue;
    if (!ruleset.bypass_actors) {
      report("ok", project.key, `${prefix}* tags are protected by "${ruleset.name}". Make sure the AKO app is on its bypass list`);
    } else if (ruleset.bypass_actors.some((a) => a.actor_type === "Integration" && String(a.actor_id) === String(appId))) {
      report("ok", project.key, `${prefix}* tags are protected by "${ruleset.name}", and AKO may create them`);
    } else {
      report("fail", project.key, `"${ruleset.name}" protects ${prefix}* tags but doesn't let the AKO app bypass it, so AKO can't publish`);
    }
    return;
  }
  report("warn", project.key, `release tags aren't protected: ${advice}`);
}

/** Matches a ref against a ruleset's include/exclude patterns. */
export function refMatches(condition, ref) {
  if (!condition) return false;
  const matches = (pattern) => pattern === "~ALL" || globToRegExp(pattern).test(ref);
  return (condition.include ?? []).some(matches) && !(condition.exclude ?? []).some(matches);
}

function globToRegExp(glob) {
  const source = glob
    .split("**")
    .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

async function checkAi(env, fetch, report) {
  const settings = aiSettings(env);
  if (!settings) {
    report("info", "AI", "no OPENAI_API_KEY, so AKO takes plain commands only");
    return;
  }
  try {
    const result = await checkAiProvider(settings, { fetch });
    report(result.ok ? (result.modelListed === false ? "warn" : "ok") : "fail", "AI", result.detail);
  } catch (error) {
    report("fail", "AI", `can't reach ${settings.baseUrl} (${error.message})`);
  }
}

async function checkSlack(flow, { env, fetch, post, report }) {
  const uses = flow.projects.filter((p) => p.slack.channels.length || p.people.release_managers.slack?.length);
  if (!env.SLACK_BOT_TOKEN && !env.SLACK_APP_TOKEN) {
    if (uses.length) report("fail", "Slack", `the flow file uses Slack but SLACK_BOT_TOKEN isn't set. Run \`npx ako chat add slack\``);
    else report("info", "Slack", "not connected. Add it any time with `npx ako chat add slack`");
    return;
  }

  const bot = createSlackClient({ token: env.SLACK_BOT_TOKEN, fetch });
  try {
    const auth = await bot.call("auth.test");
    report("ok", "Slack", `bot token works in ${auth.team} as @${auth.user}`);
  } catch (error) {
    report("fail", "Slack", `the bot token was refused (${error.code ?? error.message})`);
    return;
  }
  try {
    await createSlackClient({ token: env.SLACK_APP_TOKEN, fetch }).call("apps.connections.open");
    report("ok", "Slack", "the app-level token can open Socket Mode");
  } catch (error) {
    report("fail", "Slack", `the app-level token was refused (${error.code ?? error.message}). It needs connections:write`);
  }

  const channels = new Map();
  for (const project of flow.projects) {
    for (const channel of project.slack.channels) {
      channels.set(channel, [...(channels.get(channel) ?? []), project.name]);
    }
  }
  for (const [channel, names] of channels) {
    try {
      const { channel: info } = await bot.call("conversations.info", { channel });
      if (!info.is_member) {
        report("fail", "Slack", `@ako isn't in #${info.name}. Run /invite @ako there`);
        continue;
      }
      if (post) {
        await bot.call("chat.postMessage", {
          channel,
          text: `AKO is connected for ${names.join(", ")}. This is a test message from \`npx ako check\`.`,
        });
        report("ok", "Slack", `posted a test message in #${info.name}`);
      } else {
        report("ok", "Slack", `@ako is in #${info.name}`);
      }
    } catch (error) {
      report("fail", "Slack", `channel ${channel}: ${error.code ?? error.message}`);
    }
  }
}
