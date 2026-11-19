// Questions for the setup wizard, as plain lines of text.
//
// Every prompter has the same methods (ask, confirm, choose, chooseMany, pause,
// write, intro, note, outro), so the setup steps work unchanged with this one
// (piped input and tests), the styled terminal one (pretty.js) and the browser
// one (web/server.js). All three share `resolveAnswer`, so they accept the
// same answers.
//
// Any question can be answered with "go back": each prompter throws GoBack,
// and steps.js re-asks the previous question. Here that answer is "<".

import { createInterface } from "node:readline/promises";

/** Thrown by a prompter when the person asks to go back to the previous question. */
export class GoBack extends Error {
  constructor() {
    super("Go back to the previous question.");
    this.name = "GoBack";
  }
}

/** What to type, on the plain prompter, to go back. */
export const BACK_INPUT = "<";

/**
 * Applies the default and the validator to a typed answer.
 * Returns `{ value }`, or `{ problem }` when the question must be asked again.
 */
export async function resolveAnswer(raw, { default: fallback, validate, optional = false } = {}) {
  const text = String(raw ?? "").trim();
  const value = text === "" ? (fallback ?? "") : text;
  if (value === "" && !optional) return { problem: "An answer is needed." };
  const problem = validate && value !== "" ? await validate(value) : null;
  return problem ? { problem } : { value };
}

export function createPrompter({ readLine: readRaw, write = (text) => process.stdout.write(text), close = () => {} }) {
  async function readLine(question, options) {
    const raw = await readRaw(question, options);
    if (String(raw ?? "").trim() === BACK_INPUT) throw new GoBack();
    return raw;
  }

  async function ask(question, options = {}) {
    const { default: fallback, secret = false, optional = false } = options;
    for (;;) {
      const hint = fallback ? ` [${secret ? "keep current" : fallback}]` : optional ? " (optional, Enter to skip)" : "";
      const result = await resolveAnswer(await readLine(`${question}${hint}: `, { secret }), options);
      if (!result.problem) return result.value;
      write(`  ${result.problem}\n`);
    }
  }

  async function confirm(question, fallback = true) {
    for (;;) {
      const raw = (await readLine(`${question} ${fallback ? "(Y/n)" : "(y/N)"} `, {})).trim().toLowerCase();
      if (raw === "") return fallback;
      if (["y", "yes"].includes(raw)) return true;
      if (["n", "no"].includes(raw)) return false;
      write("  Answer y or n.\n");
    }
  }

  /** One option from a numbered list. `options` are `{ label, value }`. */
  async function choose(question, options, { default: fallback } = {}) {
    write(`${question}\n`);
    options.forEach((option, i) => write(`  ${i + 1}) ${option.label}\n`));
    const defaultIndex = options.findIndex((o) => o.value === fallback);
    for (;;) {
      const hint = defaultIndex >= 0 ? ` [${defaultIndex + 1}]` : "";
      const raw = (await readLine(`Pick a number${hint}: `, {})).trim();
      const index = raw === "" ? defaultIndex : Number(raw) - 1;
      if (Number.isInteger(index) && options[index]) return options[index].value;
      write(`  Pick a number from 1 to ${options.length}.\n`);
    }
  }

  /** Several options from a numbered list, typed as `1,3`. */
  async function chooseMany(question, options, { defaults = [], min = 1 } = {}) {
    write(`${question}\n`);
    options.forEach((option, i) => write(`  ${i + 1}) ${option.label}\n`));
    const defaultNumbers = options.map((o, i) => (defaults.includes(o.value) ? i + 1 : null)).filter(Boolean);
    for (;;) {
      const hint = defaultNumbers.length ? ` [${defaultNumbers.join(",")}]` : "";
      const raw = (await readLine(`Pick numbers, separated by commas${hint}: `, {})).trim();
      const numbers = raw === "" ? defaultNumbers : raw.split(/[\s,]+/).filter(Boolean).map(Number);
      const valid = numbers.every((n) => Number.isInteger(n) && options[n - 1]);
      const unique = [...new Set(numbers)];
      if (valid && unique.length >= min) return unique.map((n) => options[n - 1].value);
      write(`  Pick at least ${min}, using numbers from 1 to ${options.length}.\n`);
    }
  }

  async function pause(message) {
    await readLine(`${message} `, {});
  }

  const intro = (title) => write(`${title}\n`);
  const note = (lines, title) => write(`${title}:\n${lines.map((line) => `  - ${line}`).join("\n")}\n`);
  const outro = (text) => write(`${text}\n`);

  return { ask, confirm, choose, chooseMany, pause, write, intro, note, outro, close };
}

/**
 * A prompter for piped input, such as a script answering the setup. A real
 * terminal gets the styled prompter in pretty.js instead.
 */
export function plainPrompter({ input = process.stdin, output = process.stdout } = {}) {
  const write = (text) => output.write(text);
  // One reader for the whole run, so no line is lost between questions.
  const rl = createInterface({ input, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const readLine = async (question) => {
    write(question);
    const { value, done } = await lines.next();
    if (done) throw new Error("Input ended before the setup finished.");
    return value;
  };
  return createPrompter({ readLine, write, close: () => rl.close() });
}

/** A prompter that answers from a list, for tests. Records every question. */
export function scriptedPrompter(answers) {
  const queue = [...answers];
  const asked = [];
  const output = [];
  const prompter = createPrompter({
    readLine: async (question) => {
      asked.push(question);
      if (queue.length === 0) throw new Error(`No scripted answer left for: ${question}`);
      return queue.shift();
    },
    write: (text) => output.push(text),
  });
  return Object.assign(prompter, { asked, output, remaining: () => queue.length });
}
