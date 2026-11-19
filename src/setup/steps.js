// Going back in the setup.
//
// The setup steps are plain async code that asks questions as it goes, so
// "back" can't rewind them. Instead a step is re-run from its start, with the
// answers already given replayed silently up to the question being changed.
// Replaying repeats the step's lookups (GitHub, Slack, ClickUp) but not its
// saves: what a step changes in memory (the flow file, the to-do list) is put
// back before each re-run, and a save made again with the same answers writes
// the same thing.
//
// A replayed answer is only used while the step asks the same question (same
// kind and wording). When an earlier change makes it ask something else, such
// as "use the app already in .env?" once an app has been created, replay stops
// and the person is asked from there.

import { GoBack } from "./prompts.js";

const QUESTIONS = ["ask", "confirm", "choose", "chooseMany", "pause"];

/** Identifies a question, so a replayed answer only fills the question it came from. */
function questionKey(method, [label, second]) {
  const options = method === "choose" || method === "chooseMany" ? second.map((o) => o.label).join("\u0000") : "";
  return `${method}\u0000${label}\u0000${options}`;
}

/** Labels of the options an answer picked, so it can be found again in a fresh list. */
function pickedLabels(method, [, options], answer) {
  if (method === "choose") return options.filter((o) => o.value === answer).map((o) => o.label);
  if (method === "chooseMany") return options.filter((o) => answer.includes(o.value)).map((o) => o.label);
  return null;
}

/** The question's arguments with the earlier answer as its default. */
function withEarlierAnswer(method, args, earlier) {
  const [label, second, third = {}] = args;
  if (method === "ask") return [label, { ...second, default: earlier.answer }];
  if (method === "confirm") return [label, earlier.answer];
  if (method === "choose") {
    const option = second.find((o) => earlier.picked.includes(o.label));
    return option ? [label, second, { ...third, default: option.value }] : args;
  }
  if (method === "chooseMany") {
    return [label, second, { ...third, defaults: second.filter((o) => earlier.picked.includes(o.label)).map((o) => o.value) }];
  }
  return args;
}

/**
 * Wraps `base` for one run of a step: answers in `script` are returned without
 * asking, then questions go to `base` and are recorded. Writes are held back
 * while replaying, and on a run the person came back to, until the first
 * question is asked: they have already seen them. `remembered` holds the
 * answers from earlier runs of the step: a question asked again offers its
 * earlier answer as the default, while it is still the same question.
 */
export function replayPrompter(base, script, { canGoBackAtStart = false, cameBack = false, remembered = [] } = {}) {
  const answers = [];
  let replaying = script.length > 0 || cameBack;
  const prompter = { ...base };

  for (const method of QUESTIONS) {
    prompter[method] = async (...args) => {
      const key = questionKey(method, args);
      const recorded = script[answers.length];
      if (replaying && recorded?.key === key) {
        answers.push(recorded);
        return recorded.answer;
      }
      replaying = false;
      base.canGoBack = answers.length > 0 || canGoBackAtStart;
      const earlier = remembered[answers.length];
      const asked = earlier?.key === key ? withEarlierAnswer(method, args, earlier) : args;
      try {
        const answer = await base[method](...asked);
        answers.push({ key, answer, picked: pickedLabels(method, args, answer) });
        return answer;
      } catch (error) {
        if (error instanceof GoBack) error.answers = [...answers];
        throw error;
      }
    };
  }
  prompter.write = (text) => {
    if (!replaying) base.write(text);
  };
  prompter.note = (lines, title) => {
    if (!replaying) base.note(lines, title);
  };
  prompter.answers = () => [...answers];
  return prompter;
}

/**
 * Runs `steps` (each `{ run(prompter), name?, skip? }`) in order, letting the
 * person go back a question at a time, across steps too. `capture()` saves what
 * the steps change in memory when a step first starts, and `restore(saved)`
 * puts it back before that step runs again. A step whose `skip()` is true is
 * left out, so an earlier answer can choose which steps run.
 *
 * A prompter that shows where the setup is (the browser page) gets
 * `progress({ steps, at })`: the names of the named steps, and the index of the
 * one running, -1 before the first and `steps.length` after the last. A step
 * without a name counts as part of the named step before it. Going back reports
 * the step it returns to, which is why this can't be read from the headings the
 * steps write: a step re-run to replay its answers writes nothing.
 */
export async function runSteps(base, steps, { capture = () => null, restore = () => {} } = {}) {
  const scripts = steps.map(() => []);
  const saved = [];
  let i = 0;
  let cameBack = false;
  // Asked each time: an earlier answer may have changed which steps run.
  // Only a change is reported, so a step without a name adds nothing.
  const named = (upTo = steps.length) => steps.slice(0, upTo).filter((step) => step.name && !step.skip?.());
  let reported = null;
  const report = (upTo) => {
    const names = named().map((step) => step.name);
    const at = upTo >= steps.length ? names.length : named(upTo + 1).length - 1;
    const key = `${names.join("\n")}\n${at}`;
    if (!names.length || key === reported) return;
    reported = key;
    base.progress?.({ steps: names, at });
  };
  // Every answer given so far, per step, kept after going back so the
  // questions asked again can offer them.
  const remembered = steps.map(() => []);

  while (i < steps.length) {
    if (steps[i].skip?.()) {
      scripts[i] = [];
      saved[i] = undefined;
      i += 1;
      continue;
    }
    if (saved[i] === undefined) saved[i] = capture();
    else restore(saved[i]);
    report(i);

    const canGoBackAtStart = scripts.slice(0, i).some((script) => script.length > 0);
    const prompter = replayPrompter(base, scripts[i], { canGoBackAtStart, cameBack, remembered: remembered[i] });
    cameBack = false;
    try {
      await steps[i].run(prompter);
      scripts[i] = prompter.answers();
      remembered[i] = [...scripts[i], ...remembered[i].slice(scripts[i].length)];
      i += 1;
    } catch (error) {
      if (!(error instanceof GoBack)) throw error;
      cameBack = true;
      const answered = error.answers ?? [];
      remembered[i] = [...answered, ...remembered[i].slice(answered.length)];
      if (answered.length > 0) {
        // Back within this step: re-run it, replaying all but the last answer.
        scripts[i] = answered.slice(0, -1);
        continue;
      }
      if (!canGoBackAtStart) continue; // nothing before this question: ask it again

      // Back from a step's first question: to the last question of the step
      // before it that asked anything. Later steps start fresh when reached again.
      scripts[i] = [];
      saved[i] = undefined;
      do {
        i -= 1;
        if (scripts[i].length === 0) saved[i] = undefined;
      } while (scripts[i].length === 0);
      scripts[i] = scripts[i].slice(0, -1);
    }
  }
  report(steps.length);
}
