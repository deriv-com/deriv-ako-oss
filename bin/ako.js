#!/usr/bin/env node
// The `ako` command.

import { readFileSync, existsSync } from "node:fs";
import { plainPrompter } from "../src/setup/prompts.js";
import { prettyPrompter, SetupCancelled } from "../src/setup/pretty.js";
import { runSetup, runChatAdd } from "../src/setup/wizard.js";
import { runCheck } from "../src/setup/check.js";
import { startSetupServer } from "../src/setup/web/server.js";
import { openUrl } from "../src/setup/openUrl.js";
import { release, login, logout, whoami, chat } from "../src/cli/commands.js";
import { serve } from "../src/chat/bot.js";
import { FlowError, FLOW_FILE } from "../src/config/flow.js";
import { SetupNeeded } from "../src/engine/workspace.js";

const HELP = `Deriv AKO: a release manager for the terminal and Slack.

Usage, from the folder holding .env and release-flow.yaml:
  npx ako                       Ask in plain words: "create release for web-app", "status"
  npx ako release <action> <project>
                                ready | create | status | announce | request | approve | hold | watch | archive | unlock
                                Each finds the release it acts on, and asks when several fit.
                                A tag names one: npx ako release approve production_v20261102_0
  npx ako login                 Sign in through the AKO app, so your approvals show as you
  npx ako logout | npx ako whoami
  npx ako serve                 Run the Slack bot (keeps running; no public URL needed)

  npx ako setup                 Connect GitHub, your projects, an AI provider and Slack.
                                Asks first whether to do it in your browser or here;
                                --ui or --terminal skips that question. Run it again to
                                add a project or change one part.
  npx ako check [--no-post]     Test every connection; --no-post skips the Slack test message
  npx ako chat add slack [--ui] Connect Slack to an existing setup
  npx ako help                  Show this help
  npx ako version               Show the version
`;

async function main(args) {
  const [command, ...rest] = args;
  const chosen = rest.includes("--ui") ? "browser" : rest.includes("--terminal") ? "terminal" : null;
  const interactive = (where, run) => (where === "browser" ? inBrowser(run) : inTerminal(run));
  switch (command) {
    case "setup":
      return interactive(chosen ?? (await askWhere()), (options) => runSetup(options));
    case "check": {
      const { failed } = await runCheck({ post: !rest.includes("--no-post") });
      return failed ? 1 : 0;
    }
    case "chat":
      if (rest[0] !== "add" || !rest[1]) {
        process.stderr.write("Usage: npx ako chat add slack\n");
        return 2;
      }
      return interactive(chosen ?? "terminal", (options) => runChatAdd(rest[1], options));
    case "release":
      return release(rest, { prompter: terminalPrompter(STOPPED) });
    case "login":
      return login({ prompter: terminalPrompter(STOPPED) });
    case "logout":
      return logout({ prompter: terminalPrompter(STOPPED) });
    case "whoami":
      return whoami({ prompter: terminalPrompter(STOPPED) });
    case "serve":
      return serve({ log: (line) => process.stdout.write(`${new Date().toISOString()} ${line}\n`) });
    case "version":
    case "--version":
    case "-v": {
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      process.stdout.write(`${pkg.version}\n`);
      return 0;
    }
    case undefined:
      if (process.stdin.isTTY) {
        terminal = prettyPrompter({ cancelMessage: "Stopped.", backHint: false });
        return chat({ prompter: terminal });
      }
      process.stdout.write(HELP);
      return 0;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
      return 2;
  }
}

const SETUP_STEPS = [
  ["GitHub", "create AKO's GitHub App and install it on your repos"],
  ["Projects", "each repo, its board, branches, deploy and approvers"],
  ["AI", "optional: a key so people can ask in their own words"],
  ["Slack", "optional: hand-offs to QA and release managers"],
];

// What Esc or Ctrl+C at a question says, outside the setup.
const STOPPED = { cancelMessage: "Stopped. Anything AKO already did stays done.", backHint: false };

let terminal;
/** The styled prompter in a real terminal, the plain one for piped input. */
function terminalPrompter(options) {
  terminal ??= process.stdin.isTTY ? prettyPrompter(options) : plainPrompter();
  return terminal;
}

/** The setup's first question: it has several steps, so offer the browser. */
async function askWhere() {
  if (!process.stdin.isTTY) return "terminal";
  const p = terminalPrompter();
  p.intro("Deriv AKO setup");
  // Run again, the setup asks what to change, so the steps aren't known yet.
  if (!existsSync(FLOW_FILE)) {
    p.note(
      SETUP_STEPS.map(([name, what], i) => `${i + 1}  ${name.padEnd(10)}${what}`),
      `${SETUP_STEPS.length} steps`,
    );
  }
  return p.choose(
    "Where do you want to do it?",
    [
      { label: "In your browser: a form, one question at a time", value: "browser" },
      { label: "Here in the terminal", value: "terminal" },
    ],
    { default: "browser" },
  );
}

async function inTerminal(run) {
  const prompter = terminalPrompter();
  try {
    const { errors } = await run({ prompter });
    return errors.length ? 1 : 0;
  } finally {
    prompter.close();
  }
}

/** Runs the same setup through a page served on this machine for as long as it lasts. */
async function inBrowser(run) {
  const p = terminalPrompter();
  // The terminal follows along. Lines written together are shown together.
  let pending = "";
  const mirror = (text) => {
    if (!pending) {
      setImmediate(() => {
        const lines = pending;
        pending = "";
        p.write(lines);
      });
    }
    pending += text;
  };
  const ui = await startSetupServer({ openUrl, mirror });
  p.note(["If it didn't open, go to:", ui.url, "", "Keep this terminal open until it finishes. Ctrl+C cancels."], "Continue in your browser");
  openUrl(ui.url);
  try {
    const { errors } = await run({ prompter: ui.prompter, openUrl: ui.openUrl });
    ui.finish();
    p.outro("Setup finished in the browser.");
    return errors.length ? 1 : 0;
  } catch (error) {
    ui.fail(error);
    throw error;
  } finally {
    await ui.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    // A cancelled setup or command has already said so.
    if (error instanceof SetupCancelled) process.exit(130);
    if (error instanceof FlowError || error instanceof SetupNeeded) {
      process.stderr.write(`\n${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`\n${error.message}\n`);
    process.exit(1);
  },
);
