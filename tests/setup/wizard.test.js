import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "../../src/config/env.js";
import { parseFlow } from "../../src/config/flow.js";
import { runSetup, runChatAdd } from "../../src/setup/wizard.js";
import { scriptedPrompter } from "../../src/setup/prompts.js";
import { tempDir } from "../helpers/fakes.js";
import { PEM, fakeSetupServices as services } from "../helpers/setupFakes.js";

// Every answer the wizard asks for, in order. "" takes the default.
const ANSWERS = [
  "1", // connect GitHub: create a new app
  "1", // owned by an organization
  "acme", // organization name
  "", // app name: AKO acme
  "", // boards: GitHub Projects
  "", // deploys: GitHub Actions
  "n", // install on another account too?
  "2", // sign in now? later
  "1", // repo: acme/web-app
  "", // key: web-app
  "", // name: Web App
  "web", // aliases
  "", // flow: QA regression
  "", // tracker: GitHub Projects
  "1", // board #3
  "", // ready: guessed Ready for Staging
  "", // staged: guessed Staged
  "", // ready for release: guessed
  "", // done: guessed
  "", // release: a tag
  "", // branch: main
  "", // tag prefix: production_v
  "", // deploy: GitHub Actions
  "1", // workflow: deploy.yml
  "", // approval: a release manager
  "alice", // GitHub release managers
  "", // GitHub QA
  "n", // add another project?
  "", // AI: no
  "y", // connect Slack
  "", // install as a Slack app
  "xoxb-test", // bot token
  "xapp-1-test", // app-level token
  "", // set up Slack for web-app
  "#releases", // channel
  "@release-managers", // Slack release managers
  "Bob", // Slack QA
];

test("setup writes a valid flow file and a private .env from the answers", async (t) => {
  const dir = tempDir(t);
  const created = [];
  const prompter = scriptedPrompter(ANSWERS);
  const opened = [];
  const result = await runSetup({ cwd: dir, prompter, env: {}, services: services(created), openUrl: (url) => opened.push(url) });

  assert.equal(prompter.remaining(), 0);
  assert.deepEqual(result.errors, []);

  // The app was created with the board permission chosen, and no others.
  assert.equal(created[0].owner, "acme");
  assert.equal(created[0].permissions.organization_projects, "write");
  assert.equal(created[0].permissions.checks, undefined);

  const env = parseEnv(readFileSync(join(dir, ".env"), "utf8"));
  assert.equal(env.GITHUB_APP_ID, "42");
  assert.equal(env.GITHUB_APP_CLIENT_ID, "Iv1.test");
  assert.equal(Buffer.from(env.GITHUB_APP_PRIVATE_KEY_BASE64, "base64").toString(), PEM);
  assert.equal(env.SLACK_BOT_TOKEN, "xoxb-test");
  assert.equal(env.SLACK_APP_TOKEN, "xapp-1-test");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(statSync(join(dir, ".env")).mode & 0o777, 0o600);

  const text = readFileSync(join(dir, "release-flow.yaml"), "utf8");
  assert.match(text, /^# Deriv AKO release flow/);
  const { flow, errors } = parseFlow(text);
  assert.deepEqual(errors, []);
  const [project] = flow.projects;
  assert.equal(project.key, "web-app");
  assert.deepEqual(project.aliases, ["web"]);
  assert.deepEqual(project.tracker.statuses.ready, ["Ready for Staging"]);
  assert.equal(project.tracker.statuses.staged, "Staged");
  assert.equal(project.tracker.statuses.ready_for_release, "Ready for Release");
  assert.equal(project.tracker.statuses.done, "Done");
  assert.deepEqual(project.release, { type: "tag", tag_prefix: "production_v", branch: "main", merge_method: "squash" });
  assert.deepEqual(project.deploy, { type: "actions", workflow: "deploy.yml" });
  assert.deepEqual(project.people.release_managers, { github: ["alice"], slack: ["S000000001"] });
  assert.deepEqual(project.people.qa, { slack: ["U000000002"] });
  assert.deepEqual(project.slack.channels, ["C000000001"]);

  assert.ok(result.todo.some((item) => /Enable Device Flow/.test(item)));
  assert.ok(result.todo.some((item) => /\/invite @ako/.test(item)));
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^\.env$/m);
  assert.ok(opened.some((url) => url.startsWith("https://api.slack.com/apps?new_app=1")));
});

test("each step the browser page lists starts with a heading of the same name", async (t) => {
  // The page files what a step says under its name, so a renamed heading would
  // leave the step empty and its notes under the one before.
  const dir = tempDir(t);
  const prompter = scriptedPrompter(ANSWERS);
  const seen = [];
  const write = prompter.write;
  prompter.write = (text) => {
    for (const [, heading] of String(text).matchAll(/^== (.+) ==$/gm)) seen.push(heading);
    return write(text);
  };
  prompter.progress = ({ steps, at }) => seen.push(at < 0 ? "(start)" : at >= steps.length ? "(end)" : `step ${steps[at]}`);
  await runSetup({ cwd: dir, prompter, env: {}, services: services(), openUrl: () => {} });
  assert.deepEqual(seen, [
    "(start)",
    "step GitHub",
    "GitHub",
    "step Projects",
    "Projects",
    "step AI (optional)",
    "AI (optional)",
    "step Chat (optional)",
    "Chat (optional)",
    "Slack", // part of the chat step
    "(end)",
    "Done",
  ]);
});

test("chat add slack keeps comments and fields already in the flow file", async (t) => {
  const dir = tempDir(t);
  writeFileSync(
    join(dir, "release-flow.yaml"),
    readFileSync(new URL("../../examples/direct-release.yaml", import.meta.url), "utf8"),
  );
  const prompter = scriptedPrompter(["", "xoxb-test", "xapp-1-test", "", "releases", "", ""]);
  const result = await runChatAdd("slack", { cwd: dir, prompter, env: {}, services: services([]), openUrl: () => {} });

  assert.deepEqual(result.errors, []);
  const text = readFileSync(join(dir, "release-flow.yaml"), "utf8");
  assert.match(text, /# `closed` closes the issue instead of adding a label/);
  const { flow } = parseFlow(text);
  assert.deepEqual(flow.projects[0].slack.channels, ["C000000001"]);
  assert.deepEqual(flow.projects[0].people.release_managers.github, ["carol"]);
});

test("going back re-asks earlier answers without repeating what they did", async (t) => {
  const dir = tempDir(t);
  const created = [];
  const answers = [...ANSWERS];
  // At "How does a release go?", go back and change the other names.
  answers.splice(answers.indexOf("web") + 1, 0, "<", "web-2");
  // At "Use an AI provider?", go back to "Add another project?" in the step before.
  const aiAnswer = answers.lastIndexOf("n") + 1;
  answers.splice(aiAnswer, 0, "<", "n");

  const prompter = scriptedPrompter(answers);
  const result = await runSetup({ cwd: dir, prompter, env: {}, services: services(created), openUrl: () => {} });

  assert.equal(prompter.remaining(), 0);
  assert.deepEqual(result.errors, []);
  assert.equal(created.length, 1, "the GitHub App is created once");
  const { flow } = parseFlow(readFileSync(join(dir, "release-flow.yaml"), "utf8"));
  assert.deepEqual(flow.projects.map((p) => p.key), ["web-app"], "the project is added once");
  assert.deepEqual(flow.projects[0].aliases, ["web-2"]);
  assert.equal(result.todo.length, 2, "no to-do is listed twice");
});

/** A folder that has been set up before: an app and Slack in .env, and one project. */
function setUpBefore(dir) {
  writeFileSync(
    join(dir, ".env"),
    [
      "GITHUB_APP_ID=42",
      "GITHUB_APP_CLIENT_ID=Iv1.test",
      `GITHUB_APP_PRIVATE_KEY_BASE64=${Buffer.from(PEM).toString("base64")}`,
      "SLACK_BOT_TOKEN=xoxb-test",
      "SLACK_APP_TOKEN=xapp-1-test",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "release-flow.yaml"), readFileSync(new URL("../../examples/direct-release.yaml", import.meta.url), "utf8"));
}

const PROJECT_ANSWERS = ANSWERS.slice(ANSWERS.indexOf("1", 7), ANSWERS.indexOf("n", 26) + 1); // repo … add another? n

test("run again, setup asks what to change and runs only that part", async (t) => {
  const dir = tempDir(t);
  setUpBefore(dir);
  // Add a project: the app in .env is used without asking, and the new project gets its Slack channel
  const prompter = scriptedPrompter(["", "n", ...PROJECT_ANSWERS, "", "#releases", "", ""]);
  const plans = [];
  prompter.progress = ({ steps }) => plans.push(steps.join(", "));
  const result = await runSetup({ cwd: dir, prompter, env: {}, services: services(), openUrl: () => {} });

  assert.equal(prompter.remaining(), 0);
  assert.deepEqual(result.errors, []);
  const said = prompter.output.join("");
  assert.match(said, /already has 1 project\(s\): api\. What do you want to change\?/);
  assert.doesNotMatch(said, /Use the GitHub App already in \.env|sign in as yourself|Use an AI provider|Connect Slack now/);
  assert.deepEqual([...new Set(plans)], ["GitHub, Projects"]);
  const text = readFileSync(join(dir, "release-flow.yaml"), "utf8");
  assert.match(text, /# `closed` closes the issue instead of adding a label/);
  const { flow } = parseFlow(text);
  assert.deepEqual(flow.projects.map((p) => p.key), ["api", "web-app"]);
  assert.deepEqual(flow.projects[1].slack.channels, ["C000000001"]);
  assert.deepEqual(flow.projects[0].slack.channels, [], "only the new project was asked about");

  // Change the AI provider: nothing else is asked
  const ai = scriptedPrompter(["3", "n"]);
  ai.progress = ({ steps }) => plans.push(steps.join(", "));
  await runSetup({ cwd: dir, prompter: ai, env: {}, services: services(), openUrl: () => {} });
  assert.equal(ai.remaining(), 0);
  assert.equal(plans.at(-1), "AI (optional)");
});

test("setup doesn't finish with a project nobody can approve", async (t) => {
  const dir = tempDir(t);
  const answers = [...ANSWERS.slice(0, ANSWERS.indexOf("y", 28)), "n"]; // no Slack
  answers[answers.indexOf("alice")] = ""; // no GitHub release managers
  const prompter = scriptedPrompter([...answers, "", "bob", "alice"]);
  const result = await runSetup({ cwd: dir, prompter, env: {}, services: services(), openUrl: () => {} });

  assert.equal(prompter.remaining(), 0);
  const said = prompter.output.join("");
  assert.match(said, /No GitHub release managers yet[\s\S]*Nobody can approve releases of "web-app" yet\./);
  assert.match(said, /There's no GitHub user "bob"/, "the usernames are checked on GitHub");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(parseFlow(readFileSync(join(dir, "release-flow.yaml"), "utf8")).flow.projects[0].people.release_managers.github, ["alice"]);
});

test("setup signs the person in straight away when Device Flow is on", async (t) => {
  const dir = tempDir(t);
  const answers = [...ANSWERS];
  answers[answers.indexOf("2")] = "1"; // sign in now
  const prompter = scriptedPrompter(answers);
  const opened = [];
  const result = await runSetup({ cwd: dir, prompter, env: {}, services: services(), openUrl: (url) => opened.push(url) });

  assert.equal(prompter.remaining(), 0);
  assert.ok(opened.includes("https://github.com/login/device"), "GitHub's sign-in page opens");
  assert.ok(!opened.some((url) => url.includes("/settings/apps/")), "the app's settings page isn't needed");
  assert.match(prompter.output.join(""), /Code: ABCD-1234[\s\S]*Signed in as @alice/);
  assert.ok(!result.todo.some((item) => /Enable Device Flow/.test(item)));
});

test("setup opens the app's settings only when Device Flow is off, then signs in", async (t) => {
  const dir = tempDir(t);
  const answers = [...ANSWERS];
  const at = answers.indexOf("2");
  answers.splice(at, 1, "1", ""); // sign in now; continue once Device Flow is saved
  const prompter = scriptedPrompter(answers);
  const opened = [];
  let attempts = 0;
  const signIn = async ({ onCode }) => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("Device flow is off for this GitHub App."), { code: "device_flow_disabled" });
    onCode({ code: "WXYZ-9876", url: "https://github.com/login/device" });
    return { login: "alice" };
  };
  await runSetup({ cwd: dir, prompter, env: {}, services: { ...services(), signIn }, openUrl: (url) => opened.push(url) });

  assert.equal(prompter.remaining(), 0);
  assert.equal(attempts, 2, "it tries again by itself once the setting is saved");
  const settings = opened.indexOf("https://github.com/organizations/acme/settings/apps/ako-acme");
  assert.ok(settings >= 0 && settings < opened.indexOf("https://github.com/login/device"), "the settings page opens first");
  assert.match(prompter.output.join(""), /tick "Enable Device Flow" and save[\s\S]*Code: WXYZ-9876[\s\S]*Signed in as @alice/);
  assert.ok(prompter.asked.some((q) => q.startsWith("Continue once it's saved.")), "it waits for the setting to be saved");
});
