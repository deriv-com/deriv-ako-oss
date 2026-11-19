// The setup as it looks in a real terminal: arrow-key menus, hidden password
// input and grouped messages, drawn with @clack/prompts. It has the same
// methods as the plain prompter, so the setup steps don't know which one
// they're talking to. Piped input and the tests use the plain prompter.

import { styleText } from "node:util";
import * as clack from "@clack/prompts";
import { resolveAnswer, GoBack } from "./prompts.js";

/** Thrown when the person presses Ctrl+C or Esc at a question. */
export class SetupCancelled extends Error {
  constructor(message = "Setup cancelled. Anything already saved is kept.") {
    super(message);
    this.name = "SetupCancelled";
  }
}

const SUCCESS = /^(Connected|Created|Saved|Added|Signed in|Installed|Found|Wrote)\b/;
const LONG_LIST = 10;

/**
 * Splits text the setup steps write into blocks to draw: headings (`== X ==`),
 * success lines, warnings (`!`), errors (`✗`) and plain messages. Consecutive
 * lines of the same kind stay together as one block.
 */
export function toBlocks(text) {
  const blocks = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/^ {2}/, "");
    if (line.trim() === "") continue;
    const heading = line.trim().match(/^== (.+) ==$/);
    const kind = heading
      ? "heading"
      : /^\s*✗/.test(line)
        ? "error"
        : /^\s*!/.test(line)
          ? "warn"
          : SUCCESS.test(line.trim())
            ? "success"
            : "message";
    const value = heading ? heading[1] : line.replace(/^\s*[✗!]\s*/, "");
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind && kind !== "heading") last.lines.push(value);
    else blocks.push({ kind, lines: [value] });
  }
  return blocks;
}

const FRAMES = ["◒", "◐", "◓", "◑"];

/** Draws a spinner on one line until the returned function is called. */
function spin(output, label, color) {
  let frame = 0;
  const draw = () => output.write(`\r\x1b[2K${color("magenta", FRAMES[frame++ % FRAMES.length])}  ${label}…`);
  output.write("\x1b[?25l");
  draw();
  const timer = setInterval(draw, 120);
  return () => {
    clearInterval(timer);
    output.write("\r\x1b[2K\x1b[?25h");
  };
}

/** Takes keypresses away from the terminal until the returned function is called. */
function holdKeys(input, onCtrlC) {
  if (!input.isTTY || typeof input.setRawMode !== "function") return () => {};
  const wasRaw = input.isRaw;
  // Raw mode stops the terminal echoing keys and holding them for later, so
  // Ctrl+C arrives as a byte rather than a signal.
  const onData = (chunk) => {
    if (String(chunk).includes("\u0003")) onCtrlC();
  };
  input.setRawMode(true);
  input.on("data", onData);
  input.resume();
  return () => {
    input.off("data", onData);
    input.setRawMode(wasRaw);
    input.pause();
  };
}

export function prettyPrompter({ input = process.stdin, output = process.stdout, cancelMessage = "Setup cancelled. Anything already saved is kept.", backHint = true } = {}) {
  const io = { input, output };
  const color = (format, text) => (output.isTTY && !process.env.NO_COLOR ? styleText(format, text) : text);
  let introShown = false;

  // Esc and Ctrl+C both cancel a question. When there is a question to go back
  // to, ask which was meant; a second Esc or Ctrl+C quits.
  const settle = async (value) => {
    if (!clack.isCancel(value)) return value;
    if (self.canGoBack) {
      const choice = await clack.select({
        ...io,
        message: "Go back, or quit the setup?",
        options: [
          { value: "back", label: "Go back to the previous question" },
          { value: "quit", label: "Quit the setup" },
        ],
      });
      if (choice === "back") throw new GoBack();
    }
    clack.cancel(cancelMessage, io);
    throw new SetupCancelled(cancelMessage);
  };

  function write(text) {
    for (const block of toBlocks(text)) {
      const body = block.lines.join("\n");
      if (block.kind === "heading") clack.log.step(color(["bold", "cyan"], block.lines[0]), io);
      else if (block.kind === "error") clack.log.error(body, io);
      else if (block.kind === "warn") clack.log.warn(body, io);
      else if (block.kind === "success") clack.log.success(body, io);
      else clack.log.message(color("dim", body), io);
    }
  }

  async function ask(message, options = {}) {
    const { default: fallback, secret = false, optional = false } = options;
    let typed = null;
    for (;;) {
      const required = (value) => (!optional && !fallback && !value?.trim() ? "An answer is needed." : undefined);
      const raw = secret
        ? await clack.password({
            ...io,
            message: fallback ? `${message} ${color("dim", "(Enter keeps the current one)")}` : message,
            mask: "•",
            validate: required,
          })
        : await clack.text({
            ...io,
            message,
            // The default shows greyed out: Enter takes it, typing replaces it.
            // After a problem, what was typed comes back to be corrected.
            placeholder: fallback || (optional ? "Optional, press Enter to skip" : undefined),
            defaultValue: fallback || undefined,
            initialValue: typed ?? undefined,
            validate: required,
          });
      const result = await resolveAnswer((await settle(raw)) ?? "", options);
      if (!result.problem) return result.value;
      clack.log.error(result.problem, io);
      if (!secret) typed = typeof raw === "string" ? raw : null;
    }
  }

  async function confirm(message, fallback = true) {
    return settle(await clack.confirm({ ...io, message, initialValue: fallback }));
  }

  async function choose(message, options, { default: fallback } = {}) {
    const items = options.map((o, i) => ({ value: i, label: o.label }));
    const initial = options.findIndex((o) => o.value === fallback);
    const prompt = options.length > LONG_LIST ? clack.autocomplete : clack.select;
    const index = await settle(
      await prompt({
        ...io,
        message,
        options: items,
        initialValue: initial >= 0 ? initial : undefined,
        maxItems: LONG_LIST,
      }),
    );
    return options[index].value;
  }

  async function chooseMany(message, options, { defaults = [], min = 1 } = {}) {
    for (;;) {
      const picked = await settle(
        await clack.multiselect({
          ...io,
          message,
          options: options.map((o, i) => ({ value: i, label: o.label })),
          initialValues: options.map((o, i) => (defaults.includes(o.value) ? i : null)).filter((i) => i !== null),
          required: min > 0,
          maxItems: LONG_LIST,
        }),
      );
      if (picked.length >= min) return picked.sort((a, b) => a - b).map((i) => options[i].value);
      clack.log.error(`Pick at least ${min}.`, io);
    }
  }

  async function pause(message) {
    await settle(await clack.text({ ...io, message, placeholder: "Press Enter to continue" }));
  }

  /**
   * Shows a spinner while `fn` runs. Keys pressed meanwhile are thrown away:
   * the terminal would otherwise hold them and hand them to the next question,
   * where a stray Esc cancels it. Ctrl+C still stops AKO. `fn` gets
   * `note(text)` to print a line while the spinner keeps going.
   *
   * clack's own spinner isn't used because Esc during it ends the process,
   * which could stop AKO halfway through merging PRs.
   */
  async function working(label, fn) {
    if (!output.isTTY) return fn({ note: write });
    let stop = spin(output, label, color);
    const release = holdKeys(input, () => {
      stop();
      clack.cancel(cancelMessage, io);
      process.exit(130);
    });
    const note = (text) => {
      stop();
      write(text);
      stop = spin(output, label, color);
    };
    try {
      return await fn({ note });
    } finally {
      stop();
      release();
    }
  }

  const self = {
    ask,
    confirm,
    choose,
    chooseMany,
    pause,
    write,
    working,
    // Set by steps.js before each question.
    canGoBack: false,
    intro(title) {
      if (introShown) return;
      introShown = true;
      clack.intro(color(["bgCyan", "black"], ` ${title} `), io);
      if (backHint) clack.log.message(color("dim", "Press Esc to go back to the previous question."), io);
    },
    note(lines, title) {
      clack.note(lines.join("\n"), title, io);
    },
    outro(text) {
      clack.outro(text, io);
    },
    close: () => {},
  };
  return self;
}
