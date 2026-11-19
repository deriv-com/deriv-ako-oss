import { test } from "node:test";
import assert from "node:assert/strict";
import { runSteps } from "../../src/setup/steps.js";
import { scriptedPrompter, GoBack } from "../../src/setup/prompts.js";

// The question text, without the default shown as a hint (" [b1]").
const labelsAsked = (p) => p.asked.map((q) => q.replace(/( \[[^\]]*\])?[:\s]+$/, ""));

test("< re-asks the previous question, replaying earlier answers silently", async () => {
  const p = scriptedPrompter(["a1", "b1", "<", "b2", "c1"]);
  const result = {};
  await runSteps(p, [
    {
      run: async (q) => {
        result.a = await q.ask("A");
        result.b = await q.ask("B");
        result.c = await q.ask("C");
      },
    },
  ]);
  assert.deepEqual(result, { a: "a1", b: "b2", c: "c1" });
  // A was answered once; B was asked again; nothing was left over.
  assert.deepEqual(labelsAsked(p), ["A", "B", "C", "B", "C"]);
  assert.equal(p.remaining(), 0);
});

test("going back from a step's first question returns to the step before it", async () => {
  const p = scriptedPrompter(["x1", "y1", "<", "y2", "z1"]);
  const result = {};
  await runSteps(p, [
    {
      run: async (q) => {
        result.x = await q.ask("X");
        result.y = await q.ask("Y");
      },
    },
    { run: async (q) => (result.z = await q.ask("Z")) },
  ]);
  assert.deepEqual(result, { x: "x1", y: "y2", z: "z1" });
});

test("a step's changes are undone before it runs again", async () => {
  const added = [];
  const p = scriptedPrompter(["web", "n", "<", "n", ""]);
  await runSteps(
    p,
    [
      {
        run: async (q) => {
          added.push(await q.ask("Project key"));
          await q.confirm("Add another project?", false);
        },
      },
      { run: async (q) => q.ask("AI key", { optional: true }) },
    ],
    { capture: () => added.length, restore: (length) => (added.length = length) },
  );
  assert.deepEqual(added, ["web"], "the project is not added twice");
});

test("going back skips steps that asked nothing", async () => {
  const p = scriptedPrompter(["x1", "<", "x2", "z1"]);
  const result = {};
  await runSteps(p, [
    { run: async (q) => (result.x = await q.ask("X")) },
    { run: async () => {} },
    { run: async (q) => (result.z = await q.ask("Z")) },
  ]);
  assert.deepEqual(result, { x: "x2", z: "z1" });
});

test("with nothing before it, going back asks the same question again", async () => {
  const p = scriptedPrompter(["<", "first"]);
  let answer;
  await runSteps(p, [{ run: async (q) => (answer = await q.ask("Only question")) }]);
  assert.equal(answer, "first");
});

test("messages are not repeated while answers replay", async () => {
  const p = scriptedPrompter(["a1", "<", "a2", "b1"]);
  await runSteps(p, [
    {
      run: async (q) => {
        q.write("== Step ==\n");
        await q.ask("A");
        q.write("Saved A.\n");
        await q.ask("B");
      },
    },
  ]);
  // The heading is written once; "Saved A." again only because A was answered again.
  assert.equal(p.output.filter((line) => line.includes("== Step ==")).length, 1);
  assert.equal(p.output.filter((line) => line.includes("Saved A.")).length, 2);
});

test("when an earlier change alters a question, replay stops and asks it", async () => {
  let appExists = false;
  const p = scriptedPrompter(["1", "acme", "<", "y", "acme-2", "done"]);
  const result = {};
  await runSteps(p, [
    {
      run: async (q) => {
        // Like the GitHub step: once the app exists, the first question changes.
        if (appExists) result.reuse = await q.confirm("Use the app already in .env?");
        else result.mode = await q.choose("How do you want to connect?", [{ label: "Create", value: "create" }]);
        result.org = await q.ask("Organization");
        appExists = true;
        result.done = await q.ask("Next");
      },
    },
  ]);
  assert.equal(result.mode, "create");
  assert.equal(result.reuse, true, "the changed question was asked, not filled from the old answer");
  assert.equal(result.org, "acme-2");
});

test("other errors still stop the setup", async () => {
  const p = scriptedPrompter(["a1"]);
  await assert.rejects(
    runSteps(p, [{ run: async (q) => { await q.ask("A"); throw new Error("GitHub is down"); } }]),
    /GitHub is down/,
  );
  assert.ok(new GoBack() instanceof Error);
});

test("the question gone back to offers the earlier answer as its default", async () => {
  // Each question is answered, then the next one goes back, then "" takes the default.
  const twoSteps = (first) => [{ run: first }, { run: async (q) => q.ask("Next") }];

  let org;
  await runSteps(scriptedPrompter(["acme", "<", "", "x"]), twoSteps(async (q) => (org = await q.ask("Organization name"))));
  assert.equal(org, "acme");

  let ai;
  await runSteps(scriptedPrompter(["n", "<", "", "x"]), twoSteps(async (q) => (ai = await q.confirm("Use an AI provider?", true))));
  assert.equal(ai, false, "the earlier No is the default, not the question's own Yes");

  let board;
  const options = [
    { label: "GitHub Projects", value: { id: "gp" } },
    { label: "ClickUp", value: { id: "cu" } },
  ];
  // Fresh option objects on every run, as a re-run lookup would return.
  const fresh = () => options.map((o) => ({ ...o, value: { ...o.value } }));
  await runSteps(scriptedPrompter(["2", "<", "", "x"]), twoSteps(async (q) => (board = await q.choose("Which board?", fresh()))));
  assert.deepEqual(board, { id: "cu" }, "found again by its label");

  let boards;
  await runSteps(scriptedPrompter(["1,2", "<", "", "x"]), twoSteps(async (q) => (boards = await q.chooseMany("Which boards?", fresh()))));
  assert.deepEqual(boards, [{ id: "gp" }, { id: "cu" }]);
});

test("questions after the one gone back to also offer their earlier answers", async () => {
  const p = scriptedPrompter(["acme", "2", "<", "<", "", "", "x"]);
  const result = {};
  await runSteps(p, [
    {
      run: async (q) => {
        result.org = await q.ask("Organization name");
        result.board = await q.choose("Which board?", [
          { label: "GitHub Projects", value: "gp" },
          { label: "ClickUp", value: "cu" },
        ]);
      },
    },
    { run: async (q) => (result.next = await q.ask("Next")) },
  ]);
  // Back twice to the organization, then Enter twice: both earlier answers kept.
  assert.deepEqual(result, { org: "acme", board: "cu", next: "x" });
});

test("the setup reports which named step is running, also after going back", async () => {
  const p = scriptedPrompter(["s", "x1", "<", "x2", "y1"]);
  const seen = [];
  p.progress = ({ steps, at }) => seen.push([steps.join(","), at]);
  await runSteps(p, [
    { run: async (q) => q.ask("Start") },
    { name: "One", run: async (q) => q.ask("X") },
    { name: "Two", run: async (q) => q.ask("Y") },
  ]);
  // Before the first named step, One, Two, back to One, Two again, then past the end.
  assert.deepEqual(
    seen.map(([, at]) => at),
    [-1, 0, 1, 0, 1, 2],
  );
  assert.ok(seen.every(([steps]) => steps === "One,Two"));
});

test("steps without names report nothing", async () => {
  const p = scriptedPrompter(["a"]);
  let reported = false;
  p.progress = () => (reported = true);
  await runSteps(p, [{ run: async (q) => q.ask("A") }]);
  assert.equal(reported, false);
});
