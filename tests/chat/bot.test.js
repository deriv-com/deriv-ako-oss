import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFlow } from "../../src/config/flow.js";
import { createStore } from "../../src/engine/store.js";
import { createTracker } from "../../src/trackers/index.js";
import { createBot } from "../../src/chat/bot.js";
import { fakeGitHub } from "../helpers/fakeGitHub.js";

const NOV_2 = Date.UTC(2026, 10, 2, 9, 0, 0);
const CHANNEL = "C000000001";
const QA = "S000000003";
const RM = "U000000002";
const DEV = "U000000005";

function setup() {
  const { flow } = validateFlow({
    version: 1,
    projects: [
      {
        key: "web-app",
        name: "Web App",
        repo: "acme/web-app",
        tracker: { type: "github-issues", statuses: { ready: "Ready for Staging", staged: "Staged", ready_for_release: "Ready for Release", done: "closed" } },
        deploy: { type: "none" },
        people: { release_managers: { slack: [RM] }, qa: { slack: [QA] } },
        slack: { channels: [CHANNEL] },
      },
    ],
  });
  const gh = fakeGitHub();
  const calls = [];
  let ts = 0;
  const slack = {
    async call(method, params) {
      calls.push({ method, ...params, blocks: params.blocks ? JSON.parse(params.blocks) : undefined });
      return { ts: `100.${++ts}` };
    },
  };
  const ws = {
    flow,
    slack,
    findProject: (name) => flow.projects.find((p) => p.key === name) ?? null,
    async envFor(project) {
      return { project, gh, slack, tracker: createTracker(project, { gh }), store: createStore(gh, project, { now: () => NOV_2 }), now: () => NOV_2 };
    },
  };
  return { gh, calls, bot: createBot({ ws }) };
}

const mention = (text, user = DEV, extra = {}) => ({
  type: "events_api",
  payload: { event: { type: "app_mention", text: `<@UAKO> ${text}`, user, channel: CHANNEL, ts: "1.0", ...extra } },
});

// A button click, as Slack sends it: the message's buttons and the checkbox state.
function click(message, actionId, user, ticked) {
  const button = message.blocks.flatMap((b) => b.elements ?? []).find((e) => e.action_id === actionId);
  assert.ok(button, `no ${actionId} button`);
  const values = {};
  for (const block of message.blocks.filter((b) => b.block_id?.startsWith("ako_items_"))) {
    const options = block.elements[0].options.filter((o) => !ticked || ticked.includes(o.value));
    values[block.block_id] = { ako_items: { selected_options: options } };
  }
  return {
    type: "interactive",
    payload: { type: "block_actions", user: { id: user }, channel: { id: CHANNEL }, message: { ts: message.ts, thread_ts: message.thread_ts }, actions: [{ action_id: actionId, value: button.value }], state: { values } },
  };
}

const posted = (calls) => calls.filter((c) => c.method === "chat.postMessage");
// Every Slack call returns the next ts, so the last post's ts is the call count.
const last = (calls) => ({ ...posted(calls).at(-1), ts: `100.${calls.length}` });

test("a release from Slack: pick work, tell QA, ask, refuse a non-manager privately, approve", async () => {
  const { gh, calls, bot } = setup();
  const one = gh.addIssue({ title: "Fix the payout label", labels: ["Ready for Staging"] });
  const two = gh.addIssue({ title: "Landscape <message>", labels: ["Ready for Staging"] });
  gh.addPull({ issue: one });
  gh.addPull({ issue: two });

  await bot.handle(mention("create release"));
  const offer = last(calls);
  assert.equal(offer.thread_ts, "1.0");
  assert.equal(offer.blocks[1].elements[0].options.length, 2);
  assert.match(JSON.stringify(offer.blocks), /Landscape <message>/, "plain_text keeps the title as typed");

  // Untick the second issue and open
  await bot.handle(click(offer, "ako_open", DEV, [String(one.number)]));
  assert.deepEqual(calls.find((c) => c.method === "chat.update").text, `<@${DEV}> is opening a release with 1 issue(s)…`);
  const opened = last(calls);
  assert.match(opened.text, /Opened \*production_v20261102_0\* with 1 issue\(s\)/);
  assert.match(opened.text, /✓ Merged <https:\/\/github.com\/acme\/web-app\/pull\/\d+\|PR #\d+> \(for #1\)/);
  assert.equal(opened.thread_ts, "1.0");

  await bot.handle(click(opened, "ako_announce", DEV));
  const announced = last(calls);
  assert.match(announced.text, new RegExp(`^<!subteam\\^${QA}> Regression can start on staging for \\*production_v20261102_0\\*`));

  gh.world.issues.find((i) => i.number === one.number).labels = new Set(["Ready for Release"]);
  await bot.handle(click(announced, "ako_request", DEV));
  const ask = last(calls);
  assert.match(ask.text, new RegExp(`^<@${RM}> <@${DEV}> asks to publish`));

  // The developer can't approve; only they see why
  await bot.handle(click(ask, "ako_approve", DEV));
  const refusal = calls.at(-1);
  assert.equal(refusal.method, "chat.postEphemeral");
  assert.equal(refusal.user, DEV);
  assert.match(refusal.text, /isn't a release manager/);

  await bot.handle(click(ask, "ako_approve", RM));
  assert.equal(calls.filter((c) => c.method === "chat.update").at(-1).text, `Approved by <@${RM}>.`);
  assert.match(posted(calls).at(-1).text, /^Released \*production_v20261102_0\*: https:\/\/github.com\/acme\/web-app\/releases\/tag\/production_v20261102_0/);
  assert.equal(gh.world.releases.length, 1);

  // Pressing Approve again changes nothing on GitHub
  await bot.handle(click(ask, "ako_approve", RM));
  assert.match(calls.at(-1).text, /already published/);
  assert.equal(gh.world.releases.length, 1);
});

test("the bot ignores other bots and edits, answers help, and asks which project when it can't tell", async () => {
  const { calls, bot } = setup();
  await bot.handle({ type: "events_api", payload: { event: { type: "app_mention", text: "hi", bot_id: "B1", channel: CHANNEL, ts: "1" } } });
  await bot.handle({ type: "events_api", payload: { event: { type: "app_mention", text: "hi", subtype: "message_changed", channel: CHANNEL, ts: "1" } } });
  assert.equal(calls.length, 0);

  await bot.handle(mention("help"));
  assert.match(posted(calls).at(-1).text, /Here's what I can do/);

  // In a channel the project doesn't use, the bot points to the right one
  await bot.handle(mention("what's ready for web-app", DEV, { channel: "C000000099" }));
  assert.equal(posted(calls).at(-1).text, `Web App is handled in <#${CHANNEL}>.`);
});

test("a direct message works anywhere, and the engine's refusals are answered in the thread", async () => {
  const { calls, bot } = setup();
  await bot.handle({ type: "events_api", payload: { event: { type: "message", channel_type: "im", text: "status of web-app", user: DEV, channel: "D000000001", ts: "5.0" } } });
  assert.equal(posted(calls).at(-1).text, "Web App has no releases yet.");
  await bot.handle({ type: "events_api", payload: { event: { type: "message", channel_type: "im", text: "approve production_v20261102_0", user: RM, channel: "D000000001", ts: "6.0" } } });
  assert.equal(posted(calls).at(-1).text, "✗ There's no release `production_v20261102_0` for Web App.");
});

test("a typed approval only shows the buttons, and QA can be told by name", async () => {
  const { gh, calls, bot } = setup();
  const one = gh.addIssue({ title: "Fix the payout label", labels: ["Ready for Staging"] });
  gh.addPull({ issue: one });
  await bot.handle(mention("create release"));
  await bot.handle(click(last(calls), "ako_open", DEV));

  await bot.handle(mention("tell QA production_v20261102_0"));
  assert.match(posted(calls).at(-1).text, new RegExp(`^<!subteam\\^${QA}> Regression can start on staging for \\*production_v20261102_0\\*`));

  gh.world.issues.find((i) => i.number === one.number).labels = new Set(["Ready for Release"]);
  await bot.handle(mention("request approval for production_v20261102_0"));
  await bot.handle(mention("don't approve production_v20261102_0 yet", RM));
  assert.match(posted(calls).at(-1).text, /Here's what I can do/, "not read as an approval");

  await bot.handle(mention("approve production_v20261102_0", RM));
  const confirm = last(calls);
  assert.match(confirm.text, /^Publish \*production_v20261102_0\* \(Web App\) at tested commit \w{7}\? A release manager confirms with the button\./);
  assert.equal(gh.world.releases.length, 0, "typing alone publishes nothing");
  await bot.handle(click(confirm, "ako_approve", RM));
  assert.equal(gh.world.releases.length, 1);
});

test("new work joins the open release, and a request by project offers a button per release when several fit", async () => {
  const { gh, calls, bot } = setup();
  const ready = (title) => {
    const issue = gh.addIssue({ title, labels: ["Ready for Staging"] });
    gh.addPull({ issue });
    return issue;
  };
  const passQa = (issue) => {
    gh.world.issues.find((i) => i.number === issue.number).labels = new Set(["Ready for Release"]);
  };
  const buttonsOf = (message) => message.blocks.flatMap((b) => b.elements ?? []).filter((e) => e.type === "button").map((e) => e.text.text);

  const one = ready("First");
  await bot.handle(mention("create release for web-app"));
  await bot.handle(click(last(calls), "ako_open", DEV));
  await bot.handle(mention("tell QA for web-app"));
  assert.match(posted(calls).at(-1).text, /Regression can start on staging for \*production_v20261102_0\*/);

  // While a release is open, the only choice is to add to it
  ready("Second");
  await bot.handle(mention("create release for web-app"));
  assert.deepEqual(buttonsOf(last(calls)), ["Add to production_v20261102_0"]);

  // Once it waits for approval, new work goes in a new release, which says so
  passQa(one);
  await bot.handle(mention("request approval for web-app"));
  await bot.handle(mention("create release for web-app"));
  const offer = last(calls);
  assert.deepEqual(buttonsOf(offer), ["Open a new release"]);
  assert.match(JSON.stringify(offer.blocks), /production_v20261102_0 is waiting for approval and still ships only its tested commit/);
  await bot.handle(click(offer, "ako_open", DEV));
  assert.match(last(calls).text, /Opened \*production_v20261102_1\*[\s\S]*production_v20261102_0 is waiting for approval/);

  // Two releases now wait for approval, so a typed approval asks which
  await bot.handle(mention("tell QA for web-app"));
  for (const issue of gh.world.issues.filter((i) => i.title === "Second")) passQa(issue);
  await bot.handle(mention("request approval for web-app"));
  await bot.handle(mention("approve web-app", RM));
  const picker = last(calls);
  assert.match(picker.text, /^Which Web App release\?/);
  assert.deepEqual(buttonsOf(picker), ["production_v20261102_1", "production_v20261102_0"]);

  await bot.handle(click(picker, "ako_pick", RM));
  assert.match(calls.filter((c) => c.method === "chat.update").at(-1).text, /picked \*production_v20261102_1\*/);
  assert.match(posted(calls).at(-1).text, /^Publish \*production_v20261102_1\*/);
  assert.equal(gh.world.releases.length, 0, "picking only shows the Approve button");
});

test("a PR that didn't merge gets a Retry the merges button once nothing new is ready", async () => {
  const { gh, calls, bot } = setup();
  const one = gh.addIssue({ title: "Needs review", labels: ["Ready for Staging"] });
  const pr = gh.addPull({ issue: one });
  gh.world.pulls.find((x) => x.number === pr.number).blocked = "At least 1 approving review is required";
  await bot.handle(mention("create release for web-app"));
  await bot.handle(click(last(calls), "ako_open", DEV));
  assert.match(last(calls).text, /not merged: At least 1 approving review is required\nFix those PRs, then mention me with `create release for web-app` to retry them\./);

  delete gh.world.pulls.find((x) => x.number === pr.number).blocked;
  await bot.handle(mention("create release for web-app"));
  const offer = last(calls);
  assert.match(offer.text, /^Nothing new is ready in Web App\. #1 in \*production_v20261102_0\* still has PRs to merge\./);
  await bot.handle(click(offer, "ako_retry", DEV));
  const retried = last(calls);
  assert.match(retried.text, /^Retried the merges in \*production_v20261102_0\*[\s\S]*✓ Merged/);
  assert.equal(retried.blocks.at(-1).elements[0].action_id, "ako_announce", "QA hasn't been told yet, so that's next");
});
