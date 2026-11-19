// `ako setup` (`npm run setup`): asks for GitHub, the projects, an optional
// AI provider and optional Slack, then writes `.env` (secrets) and
// `release-flow.yaml`. Run again, it asks what to change and runs only that
// part. `ako chat add slack` runs the Slack part on its own.

import { join } from "node:path";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { readEnvFile, updateEnvFile } from "../config/env.js";
import { FLOW_FILE, validateFlow } from "../config/flow.js";
import { createAppFromManifest } from "../github/manifest.js";
import { createGitHubApp } from "../github/appAuth.js";
import { createClickUpClient } from "../trackers/clickup.js";
import { createSlackClient } from "../chat/slack.js";
import { listModels } from "../ai/provider.js";
import { signIn, loadCredentials } from "../cli/login.js";
import { newFlowDocument, readFlowDocument, writeFlowDocument, projectKeys, setProjectValues } from "./flowFile.js";
import { setupGitHub } from "./githubSection.js";
import { setupProjects, validateGitHubPeople, splitList } from "./projectSection.js";
import { setupAi } from "./aiSection.js";
import { setupSlack } from "./slackSection.js";
import { runSteps } from "./steps.js";
import { openUrl as defaultOpenUrl } from "./openUrl.js";

export const defaultServices = {
  createAppFromManifest,
  createGitHubApp,
  createClickUpClient,
  createSlackClient,
  listModels,
  signIn,
  loadCredentials,
};

export function createContext({
  cwd = process.cwd(),
  prompter,
  env,
  fetch = globalThis.fetch,
  openUrl = defaultOpenUrl,
  services = {},
}) {
  const envPath = join(cwd, ".env");
  const flowPath = join(cwd, FLOW_FILE);
  const ctx = {
    cwd,
    envPath,
    flowPath,
    prompter,
    fetch,
    openUrl,
    services: { ...defaultServices, ...services },
    env: { ...(env ?? process.env), ...readEnvFile(envPath) },
    todo: [],
    saveEnv(updates, section) {
      updateEnvFile(envPath, updates, { section });
      for (const [key, value] of Object.entries(updates)) {
        if (value === null) delete ctx.env[key];
        else ctx.env[key] = value;
      }
    },
    saveFlow(doc) {
      const text = writeFlowDocument(flowPath, doc);
      // A prompter that can show the file (the browser page) gets each version.
      ctx.prompter.file?.(FLOW_FILE, text);
    },
  };
  return ctx;
}

export async function runSetup(options) {
  const ctx = createContext(options);
  const base = ctx.prompter;
  base.intro("Deriv AKO setup");
  base.write(`This writes two files in ${ctx.cwd}: .env for secrets, and release-flow.yaml for your projects.\n`);
  ensureGitignored(ctx.cwd);
  showFlowFile(ctx);

  // Read once: the steps save the file as they go, and going back must start
  // from what was there before the setup, not from its own partial save.
  const original = readFlowDocument(ctx.flowPath);
  // With a flow file, the steps that run are only known once the person says
  // what to change, so none is listed before that.
  const state = { doc: null, plan: original ? null : "all" };
  const unless = (...plans) => () => !plans.includes(state.plan);

  await runSteps(
    base,
    [
      { run: (p) => choosePlan(p, original, state) },
      // Each name is the heading its step writes, so the browser page can
      // file what a step says under it. The plan picks which steps run.
      { name: "GitHub", skip: unless("all", "add", "github"), run: (p) => inStep(ctx, p, () => setupGitHub(ctx, { quick: state.plan === "add" })) },
      { name: "Projects", skip: unless("all", "add"), run: (p) => inStep(ctx, p, () => addProjects(ctx, original, state)) },
      { name: "AI (optional)", skip: unless("all", "ai"), run: (p) => inStep(ctx, p, () => setupAi(ctx)) },
      { name: "Chat (optional)", skip: unless("all"), run: (p) => inStep(ctx, p, () => setupChat(ctx, state.doc)) },
      { name: "Slack", skip: unless("slack"), run: (p) => inStep(ctx, p, () => setupSlack(ctx, state.doc)) },
      { run: (p) => inStep(ctx, p, () => ensureApprovers(ctx, state.doc)) },
    ],
    stepState(ctx, state),
  );

  ctx.saveFlow(state.doc);
  return finish(ctx, state.doc);
}

/** `ako chat add <tool>`: connects a chat tool to an existing setup, as the setup's Slack part does. */
export async function runChatAdd(tool, options) {
  if (tool !== "slack") throw new Error(`Unknown chat tool "${tool}". AKO supports: slack.`);
  const ctx = createContext(options);
  const doc = readFlowDocument(ctx.flowPath);
  if (!doc) throw new Error("No release-flow.yaml yet. Run `npx ako setup` first.");
  showFlowFile(ctx);
  const state = { doc, plan: "slack" };
  await runSteps(
    ctx.prompter,
    [
      { name: "Slack", run: (p) => inStep(ctx, p, () => setupSlack(ctx, state.doc)) },
      { run: (p) => inStep(ctx, p, () => ensureApprovers(ctx, state.doc)) },
    ],
    stepState(ctx, state),
  );
  return finish(ctx, state.doc);
}

/** A first setup runs every step. Run again, it asks which part to change. */
async function choosePlan(p, original, state) {
  state.doc = original ? original.clone() : newFlowDocument();
  if (!original) return;
  const keys = projectKeys(original);
  state.plan = await p.choose(
    `release-flow.yaml already has ${keys.length} project(s): ${keys.join(", ") || "none"}. What do you want to change?`,
    [
      { label: "Add a project", value: "add" },
      { label: "Connect Slack, or change its channels and people", value: "slack" },
      { label: "The AI provider", value: "ai" },
      { label: "The GitHub App, or where it's installed", value: "github" },
      { label: "Start release-flow.yaml over, and go through every step", value: "all" },
    ],
    { default: "add" },
  );
  if (state.plan === "all") state.doc = newFlowDocument();
}

/** Adds projects. On a run that only adds projects, sets up Slack for the new ones when Slack is connected. */
async function addProjects(ctx, original, state) {
  await setupProjects(ctx, state.doc);
  if (state.plan !== "add" || !ctx.env.SLACK_BOT_TOKEN) return;
  const before = new Set(original ? projectKeys(original) : []);
  await setupSlack(ctx, state.doc, { only: projectKeys(state.doc).filter((key) => !before.has(key)), reuse: true });
}

/**
 * A project nobody can approve leaves the flow file invalid, so the setup
 * asks before it finishes: release managers by GitHub username, or whoever
 * asks for the release.
 */
async function ensureApprovers(ctx, doc) {
  const p = ctx.prompter;
  for (const project of doc.toJS()?.projects ?? []) {
    const managers = project?.people?.release_managers ?? {};
    if (!project?.key || (project.approval ?? "others") !== "others" || managers.github?.length || managers.slack?.length) continue;
    const choice = await p.choose(
      `Nobody can approve releases of "${project.key}" yet.`,
      [
        { label: "Add release managers by GitHub username", value: "github" },
        { label: "Let whoever asks approve (for solo developers)", value: "self" },
      ],
      { default: "github" },
    );
    if (choice === "self") {
      setProjectValues(doc, project.key, [[["approval"], "self"]]);
    } else {
      const owner = String(project.repo ?? "").split("/")[0];
      const github = ctx.githubApp && owner ? await ctx.githubApp.clientForOwner(owner) : null;
      const list = await p.ask("Release managers' GitHub usernames or org/team, separated by commas", {
        validate: (v) => validateGitHubPeople(github, v),
      });
      setProjectValues(doc, project.key, [[["people", "release_managers", "github"], splitList(list)]]);
    }
    ctx.saveFlow(doc);
  }
}

async function setupChat(ctx, doc) {
  const p = ctx.prompter;
  p.write("\n== Chat (optional) ==\n");
  p.write("Without a chat tool, use AKO from the terminal. Slack adds hand-offs to QA and release managers.\n");
  if (await p.confirm("Connect Slack now? You can add it later with `npx ako chat add slack`.", Boolean(ctx.env.SLACK_BOT_TOKEN))) {
    await setupSlack(ctx, doc);
  }
}

/** Runs one step with its replaying prompter in place of the context's own. */
async function inStep(ctx, prompter, run) {
  const base = ctx.prompter;
  ctx.prompter = prompter;
  try {
    return await run();
  } finally {
    ctx.prompter = base;
  }
}

/**
 * What a step changes in memory, saved when it starts and put back before it
 * runs again: the flow document and the to-do list. Settings saved to .env are
 * kept on purpose, so going back past a created GitHub App offers that app
 * instead of creating a second one.
 */
function stepState(ctx, state) {
  return {
    capture: () => ({ doc: state.doc?.clone() ?? null, plan: state.plan, todo: ctx.todo.length }),
    restore: (saved) => {
      state.doc = saved.doc?.clone() ?? null;
      state.plan = saved.plan;
      ctx.todo.length = saved.todo;
    },
  };
}

function finish(ctx, doc) {
  const p = ctx.prompter;
  const { errors, warnings } = validateFlow(doc.toJS());
  p.write("\n== Done ==\n");
  p.write("Wrote .env and release-flow.yaml.\n");
  for (const error of errors) p.write(`  ✗ ${error}\n`);
  for (const warning of warnings) p.write(`  ! ${warning}\n`);
  if (errors.length) p.write("Fix the lines above in release-flow.yaml, then run `npx ako check`.\n");
  if (ctx.todo.length) p.note(ctx.todo, "Still to do");
  p.outro("Next, run `npx ako check` to test every connection before the first release.");
  return { errors, warnings, todo: ctx.todo };
}

/** Shows the flow file as it is now, where the prompter can show it. */
function showFlowFile(ctx) {
  ctx.prompter.file?.(FLOW_FILE, existsSync(ctx.flowPath) ? readFileSync(ctx.flowPath, "utf8") : "");
}

/** Makes sure a team's secrets and flow file never get committed by accident. */
function ensureGitignored(cwd) {
  const path = join(cwd, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = current.split(/\r?\n/).map((l) => l.trim());
  const missing = [".env", FLOW_FILE].filter((entry) => !lines.includes(entry));
  if (missing.length) appendFileSync(path, `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}
