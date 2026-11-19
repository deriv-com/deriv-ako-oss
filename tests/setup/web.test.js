import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startSetupServer } from "../../src/setup/web/server.js";
import { runChatAdd } from "../../src/setup/wizard.js";
import { parseFlow } from "../../src/config/flow.js";
import { parseEnv } from "../../src/config/env.js";
import { tempDir } from "../helpers/fakes.js";
import { fakeSetupServices } from "../helpers/setupFakes.js";
import { runSteps } from "../../src/setup/steps.js";

/** Reads the page's event stream the way the browser does. */
function connect(ui) {
  const events = [];
  let wake = () => {};
  const controller = new AbortController();
  const url = new URL(ui.url);
  const reading = (async () => {
    const res = await fetch(`${url.origin}/events?token=${url.searchParams.get("token")}`, { signal: controller.signal });
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const data = buffer.slice(0, end).replace(/^data: /, "");
        buffer = buffer.slice(end + 2);
        events.push(JSON.parse(data));
        wake();
      }
    }
  })().catch(() => {});

  async function waitFor(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.find(predicate);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`timed out; events so far: ${JSON.stringify(events)}`);
      await new Promise((resolve) => {
        wake = resolve;
        setTimeout(resolve, 50);
      });
    }
  }

  let lastId = 0;
  /** The next question after the last one answered. */
  async function nextQuestion() {
    const question = await waitFor((e) => e.type === "question" && e.id > lastId);
    lastId = question.id;
    return question;
  }

  return { events, waitFor, nextQuestion, close: () => controller.abort(), reading };
}

function answer(ui, id, value, { token, contentType = "application/json", back = false } = {}) {
  const url = new URL(ui.url);
  return fetch(`${url.origin}/answer`, {
    method: "POST",
    headers: { "Content-Type": contentType, "X-AKO-Token": token ?? url.searchParams.get("token") },
    body: JSON.stringify(back ? { id, back: true } : { id, value }),
  });
}

async function withServer(t, options) {
  const ui = await startSetupServer({ openUrl: () => {}, ...options });
  t.after(() => ui.close({ delayMs: 0 }));
  return ui;
}

test("every kind of question is asked in the page and checked on the server", async (t) => {
  const ui = await withServer(t);
  const p = ui.prompter;
  const answers = (async () => {
    p.write("\n== GitHub ==\nConnected to the GitHub App.\n");
    const org = await p.ask("Organization name", { validate: (v) => (v === "acme" ? null : "Not that one.") });
    const token = await p.ask("Bot token", { secret: true, default: "the-current-secret" });
    const repo = await p.choose("Which repo?", [
      { label: "acme/api", value: { id: 1 } },
      { label: "acme/web", value: { id: 2 } },
    ]);
    const boards = await p.chooseMany("Boards", [
      { label: "GitHub Projects", value: "gp" },
      { label: "GitHub issues", value: "gi" },
      { label: "ClickUp", value: "cu" },
    ]);
    const go = await p.confirm("Connect Slack?", false);
    await p.pause("Press continue once it's installed.");
    return { org, token, repo, boards, go };
  })();

  const page = connect(ui);
  t.after(page.close);

  let q = await page.nextQuestion();
  assert.equal(q.kind, "text");
  await answer(ui, q.id, "other");
  q = await page.nextQuestion();
  assert.equal(q.problem, "Not that one.");
  assert.equal(q.value, "other", "the field keeps what was typed");
  await answer(ui, q.id, "acme");

  q = await page.nextQuestion();
  assert.equal(q.kind, "secret");
  assert.equal(q.value, null, "a secret's value never goes to the page");
  assert.equal(q.hasDefault, true);
  await answer(ui, q.id, "");

  q = await page.nextQuestion();
  assert.deepEqual(q.options, ["acme/api", "acme/web"]);
  await answer(ui, q.id, 1);

  q = await page.nextQuestion();
  await answer(ui, q.id, [9]);
  q = await page.nextQuestion();
  assert.equal(q.problem, "Pick at least 1.");
  await answer(ui, q.id, [2, 0]);

  q = await page.nextQuestion();
  assert.equal(q.kind, "confirm");
  assert.equal(q.default, false);
  await answer(ui, q.id, true);

  q = await page.nextQuestion();
  assert.equal(q.kind, "pause");
  await answer(ui, q.id, true);

  assert.deepEqual(await answers, { org: "acme", token: "the-current-secret", repo: { id: 2 }, boards: ["gp", "cu"], go: true });
  assert.deepEqual(
    page.events.filter((e) => e.type === "log").map((e) => [e.kind, e.text]),
    [
      ["heading", "GitHub"],
      ["text", "Connected to the GitHub App."],
    ],
  );
  assert.ok(!JSON.stringify(page.events).includes("the-current-secret"));
});

test("a page that reloads gets the log and the open question again", async (t) => {
  const ui = await withServer(t);
  ui.prompter.write("== Projects ==\n");
  const asked = ui.prompter.ask("Project key", { default: "web-app" });
  const page = connect(ui);
  t.after(page.close);
  const q = await page.nextQuestion();
  assert.equal(q.value, "web-app");
  assert.ok(page.events.some((e) => e.type === "log" && e.text === "Projects"));
  await answer(ui, q.id, "");
  assert.equal(await asked, "web-app");
});

test("a page that reloads hears which step is running, in order with the log", async (t) => {
  const ui = await withServer(t);
  const run = runSteps(ui.prompter, [
    { name: "GitHub", run: async (p) => p.write("\n== GitHub ==\nConnected.\n") },
    { name: "Projects", run: async (p) => p.ask("Project key") },
  ]);
  const first = connect(ui);
  t.after(first.close);
  await first.nextQuestion();
  const page = connect(ui);
  t.after(page.close);
  const q = await page.nextQuestion();
  const replayed = page.events.map((e) => (e.type === "progress" ? `at ${e.at}` : e.type === "log" ? e.text : e.type));
  assert.deepEqual(replayed, ["at 0", "GitHub", "Connected.", "at 1", "question"]);
  assert.deepEqual(page.events[0].steps, ["GitHub", "Projects"]);
  await answer(ui, q.id, "web-app");
  await run;
  await page.waitFor((e) => e.type === "progress" && e.at === 2);
});

test("an answer to a question already answered is refused", async (t) => {
  const ui = await withServer(t);
  const asked = ui.prompter.confirm("Go?");
  const page = connect(ui);
  t.after(page.close);
  const q = await page.nextQuestion();
  assert.equal((await answer(ui, q.id, false)).status, 204);
  assert.equal((await answer(ui, q.id, true)).status, 409);
  assert.equal(await asked, false);
});

test("the page needs the link's token, the loopback host and JSON answers", async (t) => {
  const ui = await withServer(t);
  const url = new URL(ui.url);

  const page = await fetch(ui.url);
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  const nonce = csp.match(/script-src 'nonce-([^']+)'/)[1];
  assert.match(await page.text(), new RegExp(`<script nonce="${nonce.replace(/[+/=]/g, "\\$&")}">`));

  assert.equal((await fetch(`${url.origin}/`)).status, 403);
  assert.equal((await fetch(`${url.origin}/?token=wrong`)).status, 403);
  assert.equal((await fetch(`${url.origin}/events`)).status, 403);
  assert.equal((await answer(ui, 1, true, { token: "wrong" })).status, 403);
  assert.equal((await answer(ui, 1, true, { contentType: "text/plain" })).status, 415);

  // A site that rebinds a name to 127.0.0.1 still sends that name as the Host.
  // Only the IP address is accepted, not even `localhost`.
  const statusFor = (host) =>
    new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: url.port, path: `/${url.search}`, headers: { Host: host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", reject);
      req.end();
    });
  assert.equal(await statusFor(`attacker.example:${url.port}`), 403);
  assert.equal(await statusFor(`localhost:${url.port}`), 403);
  assert.equal(await statusFor(`127.0.0.1:${url.port}`), 200);
});

test("the page hears when the setup finishes or fails, and the server then stops", async (t) => {
  const ui = await startSetupServer({ openUrl: () => {} });
  const page = connect(ui);
  t.after(page.close);
  ui.prompter.write("All done.\n");
  ui.finish();
  await page.waitFor((e) => e.type === "done");
  await ui.close({ delayMs: 0 });
  await assert.rejects(fetch(ui.url));
});

test("opened links also show in the page, in case the browser blocked the tab", async (t) => {
  const opened = [];
  const ui = await withServer(t, { openUrl: (link) => opened.push(link) });
  const page = connect(ui);
  t.after(page.close);
  ui.openUrl("https://github.com/apps/ako-acme/installations/new");
  const event = await page.waitFor((e) => e.type === "log" && e.kind === "link");
  assert.equal(event.text, "https://github.com/apps/ako-acme/installations/new");
  assert.deepEqual(opened, [event.text]);
});

test("the Slack step runs in the browser and writes the same files", async (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, "release-flow.yaml"), readFileSync(new URL("../../examples/direct-release.yaml", import.meta.url), "utf8"));
  const ui = await withServer(t);
  const run = runChatAdd("slack", { cwd: dir, prompter: ui.prompter, openUrl: ui.openUrl, env: {}, services: fakeSetupServices() });

  const page = connect(ui);
  t.after(page.close);
  const replies = [
    ["choose", 0], // install as a Slack app
    ["secret", "xoxb-test"],
    ["secret", "xapp-1-test"],
    ["confirm", true], // set up Slack for "api"
    ["text", "#releases"],
    ["text", ""], // release managers
    ["text", ""], // QA
  ];
  for (const [kind, value] of replies) {
    const q = await page.nextQuestion();
    assert.equal(q.kind, kind, q.label);
    await answer(ui, q.id, value);
  }
  const result = await run;
  assert.deepEqual(result.errors, []);
  assert.deepEqual(parseFlow(readFileSync(join(dir, "release-flow.yaml"), "utf8")).flow.projects[0].slack.channels, ["C000000001"]);
  assert.equal(parseEnv(readFileSync(join(dir, ".env"), "utf8")).SLACK_APP_TOKEN, "xapp-1-test");
  assert.ok(page.events.some((e) => e.kind === "link" && e.text.startsWith("https://api.slack.com/apps?new_app=1")));
  assert.ok(!JSON.stringify(page.events).includes("xapp-1-test"), "tokens never go back to the page");

  // The page shows release-flow.yaml as it was, then as AKO saved it
  const saved = readFileSync(join(dir, "release-flow.yaml"), "utf8");
  await page.waitFor((e) => e.type === "file" && e.text === saved);
  const files = page.events.filter((e) => e.type === "file");
  assert.ok(files.every((e) => e.name === "release-flow.yaml"));
  assert.match(files[0].text, /key: api/);
  assert.doesNotMatch(files[0].text, /C000000001/, "first as it was before the setup");
});

test("the page is shown the flow file and nothing else", async (t) => {
  const ui = await withServer(t);
  ui.prompter.file(".env", "GITHUB_APP_PRIVATE_KEY_BASE64=secret");
  ui.prompter.file("release-flow.yaml", "version: 1\n");
  const asked = ui.prompter.confirm("Go?");
  const page = connect(ui);
  t.after(page.close);
  const q = await page.nextQuestion();
  assert.deepEqual(page.events.filter((e) => e.type === "file").map((e) => e.name), ["release-flow.yaml"]);
  assert.ok(!JSON.stringify(page.events).includes("secret"));
  await answer(ui, q.id, true);
  await asked;
});

test("a page that reloads hears which questions were answered, so it knows what came after", async (t) => {
  const ui = await withServer(t);
  const first = ui.prompter.confirm("First?");
  const early = connect(ui);
  t.after(early.close);
  await answer(ui, (await early.nextQuestion()).id, true);
  await first;
  ui.prompter.write("Connected to the GitHub App.\n");
  const second = ui.prompter.confirm("Second?");
  const page = connect(ui);
  t.after(page.close);
  const q = await page.nextQuestion();
  assert.deepEqual(page.events.map((e) => e.type), ["answered", "log", "question"]);
  await answer(ui, q.id, true);
  await second;
});

test("the page's Back button re-asks the previous question", async (t) => {
  const ui = await withServer(t);
  const result = {};
  const run = runSteps(ui.prompter, [
    {
      run: async (p) => {
        result.org = await p.ask("Organization name");
        result.boards = await p.chooseMany("Boards", [
          { label: "GitHub Projects", value: "gp" },
          { label: "ClickUp", value: "cu" },
        ]);
      },
    },
  ]);
  const page = connect(ui);
  t.after(page.close);

  let q = await page.nextQuestion();
  assert.equal(q.canGoBack, false, "nothing to go back to yet");
  await answer(ui, q.id, "acme");

  q = await page.nextQuestion();
  assert.equal(q.canGoBack, true);
  await answer(ui, q.id, null, { back: true });

  q = await page.nextQuestion();
  assert.equal(q.label, "Organization name");
  await answer(ui, q.id, "acme-2");
  q = await page.nextQuestion();
  await answer(ui, q.id, [1]);

  await run;
  assert.deepEqual(result, { org: "acme-2", boards: ["cu"] });
});
