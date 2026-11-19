// Loads and validates `release-flow.yaml`, the file that describes each
// project's release process.
//
// The file is steps plus adapters: a project picks a tracker (where the work
// lives), a release type (what gets tagged), a deploy watcher (how the deploy
// reports back) and an ordered list of steps. Nothing in the engine branches
// on a project's name, so a new team writes a flow file instead of code.

import { existsSync, readFileSync } from "node:fs";
import { parseDocument } from "yaml";

export const FLOW_FILE = "release-flow.yaml";
export const FLOW_VERSION = 1;

export const TRACKER_TYPES = ["github-projects", "github-issues", "clickup"];
export const RELEASE_TYPES = ["tag", "release-branch"];
export const DEPLOY_TYPES = ["actions", "commit-status", "check-run", "none"];
export const APPROVAL_MODES = ["others", "self"];
export const MERGE_METHODS = ["squash", "merge", "rebase"];
export const CHAT_TOOLS = ["github", "slack"];

/** Every step in the order it runs. A project lists a subset, in this order. */
export const STEPS = [
  "pick_issues",
  "open_release",
  "merge_prs",
  "announce_regression",
  "approval",
  "publish",
  "watch_deploy",
  "archive",
];

const REQUIRED_STEPS = ["pick_issues", "open_release", "approval", "publish"];

/** Named step lists the setup wizard offers. */
export const STEP_PRESETS = {
  "qa-regression": STEPS,
  "direct-release": ["pick_issues", "open_release", "approval", "publish", "watch_deploy", "archive"],
};

export const DEFAULT_TAG_PREFIX = "production_v";

const KEY = /^[a-z0-9][a-z0-9-]*$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_TEAM = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
const SLACK_USER = /^[UW][A-Z0-9]{6,}$/;
const SLACK_GROUP = /^S[A-Z0-9]{6,}$/;
const SLACK_CHANNEL = /^[CG][A-Z0-9]{6,}$/;
const TAG_PREFIX = /^[A-Za-z0-9._/-]+$/;

export class FlowError extends Error {
  constructor(errors, path) {
    super(`${path ?? FLOW_FILE} is not valid:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    this.name = "FlowError";
    this.errors = errors;
  }
}

/** Reads, parses and validates the flow file. Throws FlowError when invalid. */
export function loadFlow(path) {
  if (!existsSync(path)) {
    throw new FlowError([`file not found. Run \`npx ako setup\` to create it.`], path);
  }
  const result = parseFlow(readFileSync(path, "utf8"));
  if (result.errors.length) throw new FlowError(result.errors, path);
  return result;
}

/** Parses flow-file text. Returns `{ flow, errors, warnings }`; never throws. */
export function parseFlow(text) {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) {
    return { flow: null, errors: doc.errors.map((e) => `YAML: ${e.message.split("\n")[0]}`), warnings: [] };
  }
  // toJS() throws, rather than reporting, on too many aliases (a "billion
  // laughs" file). Report that like any other YAML problem.
  let raw;
  try {
    raw = doc.toJS();
  } catch (error) {
    return { flow: null, errors: [`YAML: ${error.message}`], warnings: [] };
  }
  return validateFlow(raw);
}

/**
 * Validates a parsed flow file and fills in defaults.
 * Returns `{ flow, errors, warnings }`: `flow` is the normalized config, and is
 * only safe to use when `errors` is empty.
 */
export function validateFlow(raw) {
  const errors = [];
  const warnings = [];

  if (!isObject(raw)) {
    return { flow: null, errors: ["the file must be a YAML mapping with `version` and `projects`"], warnings };
  }

  if (raw.version !== FLOW_VERSION) {
    errors.push(
      raw.version === undefined
        ? `\`version\` is missing. Add \`version: ${FLOW_VERSION}\` at the top.`
        : `\`version: ${raw.version}\` is not supported. This copy of AKO reads version ${FLOW_VERSION}.`,
    );
  }

  const defaults = isObject(raw.defaults) ? raw.defaults : {};
  if (raw.defaults !== undefined && !isObject(raw.defaults)) errors.push("`defaults` must be a mapping");

  if (!Array.isArray(raw.projects) || raw.projects.length === 0) {
    errors.push("`projects` must list at least one project");
    return { flow: null, errors, warnings };
  }

  const projects = raw.projects.map((project, index) =>
    normalizeProject(project, defaults, `projects[${index}]`, errors, warnings),
  );

  checkUniqueNames(projects, errors, warnings);

  return {
    flow: { version: FLOW_VERSION, projects },
    errors,
    warnings,
  };
}

function normalizeProject(raw, defaults, at, errors, warnings) {
  if (!isObject(raw)) {
    errors.push(`${at} must be a mapping`);
    return {};
  }
  const project = mergeDefaults(defaults, raw);
  const where = typeof project.key === "string" ? `project "${project.key}"` : at;

  if (typeof project.key !== "string" || !KEY.test(project.key)) {
    errors.push(`${where}: \`key\` is required: lowercase letters, numbers and dashes, such as \`web-app\``);
  }
  if (typeof project.repo !== "string" || !REPO.test(project.repo)) {
    errors.push(`${where}: \`repo\` must be \`owner/name\``);
  }

  const aliases = project.aliases ?? [];
  if (!Array.isArray(aliases) || aliases.some((a) => typeof a !== "string" || a.trim() === "")) {
    errors.push(`${where}: \`aliases\` must be a list of names`);
  }

  const steps = normalizeSteps(project.steps, where, errors);
  const tracker = normalizeTracker(project.tracker, project.repo, steps, where, errors, warnings);
  const release = normalizeRelease(project.release, where, errors);
  const deploy = normalizeDeploy(project.deploy, steps, where, errors, warnings);
  const people = normalizePeople(project.people, where, errors);
  const slack = normalizeSlack(project.slack, where, errors);

  const approval = project.approval ?? "others";
  if (!APPROVAL_MODES.includes(approval)) {
    errors.push(`${where}: \`approval\` must be one of ${APPROVAL_MODES.join(", ")}`);
  }
  if (approval === "others" && countPeople(people.release_managers) === 0) {
    errors.push(
      `${where}: list at least one release manager under \`people.release_managers\`, or set \`approval: self\``,
    );
  }

  return {
    key: project.key,
    name: typeof project.name === "string" && project.name.trim() ? project.name.trim() : project.key,
    aliases: Array.isArray(aliases) ? aliases.map((a) => String(a).trim()) : [],
    repo: project.repo,
    tracker,
    release,
    deploy,
    steps,
    approval,
    people,
    slack,
  };
}

function normalizeSteps(raw, where, errors) {
  if (raw === undefined) return [...STEPS];
  if (typeof raw === "string") {
    if (STEP_PRESETS[raw]) return [...STEP_PRESETS[raw]];
    errors.push(`${where}: unknown step preset "${raw}". Use one of ${Object.keys(STEP_PRESETS).join(", ")}, or a list`);
    return [...STEPS];
  }
  if (!Array.isArray(raw)) {
    errors.push(`${where}: \`steps\` must be a list or a preset name`);
    return [...STEPS];
  }

  const unknown = raw.filter((s) => !STEPS.includes(s));
  for (const step of unknown) errors.push(`${where}: unknown step "${step}". Known steps: ${STEPS.join(", ")}`);

  const known = raw.filter((s) => STEPS.includes(s));
  if (new Set(known).size !== known.length) errors.push(`${where}: a step is listed twice`);

  const positions = known.map((s) => STEPS.indexOf(s));
  if (positions.some((p, i) => i > 0 && p < positions[i - 1])) {
    errors.push(`${where}: steps must keep this order: ${STEPS.join(" → ")}`);
  }

  for (const step of REQUIRED_STEPS) {
    if (!known.includes(step)) errors.push(`${where}: the \`${step}\` step is required`);
  }
  return known;
}

function normalizeTracker(raw, repo, steps, where, errors, warnings) {
  if (!isObject(raw)) {
    errors.push(`${where}: \`tracker\` is required, with a \`type\` of ${TRACKER_TYPES.join(", ")}`);
    return { type: null, statuses: {} };
  }
  const type = raw.type;
  if (!TRACKER_TYPES.includes(type)) {
    errors.push(`${where}: \`tracker.type\` must be one of ${TRACKER_TYPES.join(", ")}`);
  }

  const tracker = { type };
  if (type === "github-projects") {
    tracker.owner = raw.owner ?? (typeof repo === "string" ? repo.split("/")[0] : undefined);
    tracker.number = raw.number;
    tracker.status_field = raw.status_field ?? "Status";
    if (!Number.isInteger(raw.number) || raw.number < 1) {
      errors.push(`${where}: \`tracker.number\` is the board's number, from its URL (.../projects/<number>)`);
    }
  } else if (type === "clickup") {
    tracker.list = raw.list === undefined ? undefined : String(raw.list);
    tracker.release_list = raw.release_list === undefined ? tracker.list : String(raw.release_list);
    tracker.release_template = raw.release_template === undefined ? null : String(raw.release_template);
    tracker.pr_field = raw.pr_field ?? null;
    if (!tracker.list || !/^\d+$/.test(tracker.list)) {
      errors.push(`${where}: \`tracker.list\` is the ClickUp list ID, the number after /li/ in the list's URL`);
    }
  }

  const statuses = isObject(raw.statuses) ? raw.statuses : {};
  if (!isObject(raw.statuses)) errors.push(`${where}: \`tracker.statuses\` is required`);

  tracker.statuses = {
    ready: toList(statuses.ready),
    staged: optionalString(statuses.staged),
    ready_for_release: optionalString(statuses.ready_for_release),
    done: optionalString(statuses.done),
    catch_up: toList(statuses.catch_up),
  };

  if (tracker.statuses.ready.length === 0) {
    errors.push(`${where}: \`tracker.statuses.ready\` names the column(s) AKO picks work from`);
  }
  if (!tracker.statuses.ready_for_release) {
    errors.push(`${where}: \`tracker.statuses.ready_for_release\` names the column QA moves tested work to`);
  }
  if (steps.includes("archive") && !tracker.statuses.done) {
    errors.push(`${where}: the \`archive\` step needs \`tracker.statuses.done\``);
  }
  if (steps.includes("merge_prs") && !tracker.statuses.staged) {
    warnings.push(`${where}: no \`tracker.statuses.staged\`, so issues stay where they are after their PRs merge`);
  }
  return tracker;
}

function normalizeRelease(raw = {}, where, errors) {
  if (!isObject(raw)) {
    errors.push(`${where}: \`release\` must be a mapping`);
    return { type: "tag", tag_prefix: DEFAULT_TAG_PREFIX, branch: null, merge_method: "squash" };
  }
  const type = raw.type ?? "tag";
  if (!RELEASE_TYPES.includes(type)) errors.push(`${where}: \`release.type\` must be one of ${RELEASE_TYPES.join(", ")}`);

  const tagPrefix = raw.tag_prefix ?? DEFAULT_TAG_PREFIX;
  if (typeof tagPrefix !== "string" || !TAG_PREFIX.test(tagPrefix)) {
    errors.push(`${where}: \`release.tag_prefix\` may use letters, numbers, dots, dashes, underscores and slashes`);
  }

  const mergeMethod = raw.merge_method ?? "squash";
  if (!MERGE_METHODS.includes(mergeMethod)) errors.push(`${where}: \`release.merge_method\` must be one of ${MERGE_METHODS.join(", ")}`);

  const release = { type, tag_prefix: tagPrefix, branch: optionalString(raw.branch), merge_method: mergeMethod };
  if (type === "release-branch") {
    release.from = optionalString(raw.from);
    release.to = optionalString(raw.to);
    if (!release.from || !release.to) {
      errors.push(`${where}: a \`release-branch\` release needs \`release.from\` (where PRs merge) and \`release.to\` (what ships)`);
    } else if (release.from === release.to) {
      errors.push(`${where}: \`release.from\` and \`release.to\` must be different branches`);
    }
    release.branch = release.from;
  }
  return release;
}

function normalizeDeploy(raw = {}, steps, where, errors, warnings) {
  if (!isObject(raw)) {
    errors.push(`${where}: \`deploy\` must be a mapping`);
    return { type: "none" };
  }
  const type = raw.type ?? "none";
  if (!DEPLOY_TYPES.includes(type)) errors.push(`${where}: \`deploy.type\` must be one of ${DEPLOY_TYPES.join(", ")}`);

  const deploy = { type };
  if (type === "actions") {
    deploy.workflow = optionalString(raw.workflow);
    if (!deploy.workflow) errors.push(`${where}: \`deploy.workflow\` is the workflow file the tag starts, such as \`deploy.yml\``);
  } else if (type === "commit-status") {
    deploy.context = optionalString(raw.context);
    if (!deploy.context) errors.push(`${where}: \`deploy.context\` is the start of the commit status name to watch`);
  } else if (type === "check-run") {
    deploy.check = optionalString(raw.check);
    if (!deploy.check) errors.push(`${where}: \`deploy.check\` is the start of the check run name to watch`);
  }
  if (type === "none" && steps.includes("watch_deploy")) {
    warnings.push(`${where}: the \`watch_deploy\` step does nothing while \`deploy.type\` is none`);
  }
  return deploy;
}

function normalizePeople(raw = {}, where, errors) {
  if (!isObject(raw)) {
    errors.push(`${where}: \`people\` must be a mapping`);
    return { release_managers: {}, qa: {} };
  }
  return {
    release_managers: normalizeIdentities(raw.release_managers, `${where}: people.release_managers`, errors),
    qa: normalizeIdentities(raw.qa, `${where}: people.qa`, errors),
  };
}

function normalizeIdentities(raw = {}, at, errors) {
  if (!isObject(raw)) {
    errors.push(`${at} must be a mapping of ${CHAT_TOOLS.join(" / ")} to lists`);
    return {};
  }
  const out = {};
  for (const [tool, list] of Object.entries(raw)) {
    if (!CHAT_TOOLS.includes(tool)) {
      errors.push(`${at}.${tool}: unknown. Use ${CHAT_TOOLS.join(" or ")}`);
      continue;
    }
    const entries = toList(list);
    for (const entry of entries) {
      if (tool === "github" && !GITHUB_LOGIN.test(entry) && !GITHUB_TEAM.test(entry)) {
        errors.push(`${at}.github: "${entry}" is not a GitHub username or org/team`);
      }
      if (tool === "slack" && !SLACK_USER.test(entry) && !SLACK_GROUP.test(entry)) {
        errors.push(`${at}.slack: "${entry}" is not a Slack user ID (U…) or user group ID (S…). Store IDs, not names`);
      }
    }
    out[tool] = entries;
  }
  return out;
}

function normalizeSlack(raw = {}, where, errors) {
  if (!isObject(raw)) {
    errors.push(`${where}: \`slack\` must be a mapping`);
    return { channels: [] };
  }
  const channels = toList(raw.channels);
  for (const channel of channels) {
    if (!SLACK_CHANNEL.test(channel)) errors.push(`${where}: slack.channels: "${channel}" is not a Slack channel ID (C…)`);
  }
  const announce = optionalString(raw.announce_channel);
  if (announce && !SLACK_CHANNEL.test(announce)) {
    errors.push(`${where}: slack.announce_channel: "${announce}" is not a Slack channel ID (C…)`);
  }
  return { channels, announce_channel: announce ?? channels[0] ?? null };
}

function checkUniqueNames(projects, errors, warnings) {
  const keys = new Map();
  const names = new Map();
  for (const project of projects) {
    if (!project.key) continue;
    if (keys.has(project.key)) errors.push(`project "${project.key}" is listed twice`);
    keys.set(project.key, true);
    for (const name of [project.key, ...(project.aliases ?? [])]) {
      const folded = name.toLowerCase();
      const owner = names.get(folded);
      if (owner && owner !== project.key) {
        warnings.push(`"${name}" names both "${owner}" and "${project.key}", so AKO will ask which one is meant`);
      }
      names.set(folded, project.key);
    }
  }
}

/** Shallow per-section merge: a project's own section replaces the default's keys. */
function mergeDefaults(defaults, project) {
  const merged = { ...defaults, ...project };
  for (const section of ["release", "deploy", "people", "slack"]) {
    if (isObject(defaults[section]) && isObject(project[section])) {
      merged[section] = { ...defaults[section], ...project[section] };
    }
  }
  return merged;
}

function countPeople(identities) {
  return Object.values(identities ?? {}).reduce((sum, list) => sum + list.length, 0);
}

function toList(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => String(v).trim()).filter(Boolean);
}

function optionalString(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

