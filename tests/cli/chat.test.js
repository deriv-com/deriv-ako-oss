import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chat } from "../../src/cli/commands.js";
import { SetupCancelled } from "../../src/setup/pretty.js";
import { tempDir } from "../helpers/fakes.js";

const FLOW = `version: 1
projects:
  - key: web-app
    name: Web App
    repo: acme/web-app
    tracker:
      type: github-issues
      statuses: { ready: Ready, ready_for_release: Ready for Release, done: closed }
    people:
      release_managers: { github: [bob] }
  - key: api
    name: API
    repo: acme/api
    tracker:
      type: github-issues
      statuses: { ready: Ready, ready_for_release: Ready for Release, done: closed }
    people:
      release_managers: { github: [bob] }
`;

// Answers the main question from `answers`; Esc (a thrown SetupCancelled) at every other question.
function escPrompter(answers) {
  const asked = [];
  const output = [];
  const esc = async (question) => {
    asked.push(question);
    throw new SetupCancelled("Stopped.");
  };
  return {
    asked,
    output,
    intro() {},
    write: (text) => output.push(text),
    outro: (text) => output.push(text),
    async ask(question) {
      asked.push(question);
      const answer = answers.shift();
      if (answer === "ESC") throw new SetupCancelled("Stopped.");
      return answer;
    },
    choose: esc,
    chooseMany: esc,
    confirm: esc,
  };
}

test("Esc inside a request stops only that request; Esc at the main question leaves", async (t) => {
  const cwd = tempDir(t);
  writeFileSync(join(cwd, "release-flow.yaml"), FLOW);

  // "status" names no project, so AKO asks which one: Esc there, then the chat goes on
  let p = escPrompter(["status", "exit"]);
  assert.equal(await chat({ prompter: p, cwd, env: {} }), 0);
  assert.deepEqual(p.asked, ["What do you need?", "Which project?", "What do you need?"]);
  assert.equal(p.output.at(-1), "Bye.");

  p = escPrompter(["ESC"]);
  assert.equal(await chat({ prompter: p, cwd, env: {} }), 0);
  assert.equal(p.output.at(-1), "Bye.");
});
