// Setup step: describe each project's release process for the flow file.

import { DEFAULT_TAG_PREFIX } from "../config/flow.js";
import { listProjects, getProjectStatuses } from "../trackers/githubProjects.js";
import { getIssueStatuses, CLOSED } from "../trackers/githubIssues.js";
import { parseListId, getListStatuses, getUser } from "../trackers/clickup.js";
import { addProject, projectKeys } from "./flowFile.js";

const KEY = /^[a-z0-9][a-z0-9-]*$/;
const TAG_PREFIX = /^[A-Za-z0-9._/-]+$/;
const GITHUB_ENTRY = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})|[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+)$/;
const LIST_LIMIT = 30;

export async function setupProjects(ctx, doc) {
  const p = ctx.prompter;
  p.write("\n== Projects ==\n");
  p.write("A project is one repo and the board its work comes from.\n");
  const repos = await ctx.githubApp.listRepos();
  if (repos.length === 0) throw new Error("The GitHub App can't see any repos. Add repos to its installation and run setup again.");

  const taken = new Set(projectKeys(doc));
  do {
    const project = await setupProject(ctx, repos, taken);
    addProject(doc, project);
    taken.add(project.key);
    ctx.saveFlow(doc);
    p.write(`  Added "${project.key}" to release-flow.yaml.\n`);
  } while (await p.confirm("Add another project?", false));
}

async function setupProject(ctx, repos, taken) {
  const p = ctx.prompter;
  const repo = await pickRepo(p, repos);
  const github = await ctx.githubApp.clientForOwner(repo.owner);

  const key = await p.ask("Project key, as in `create release for <key>`", {
    default: toKey(repo.name),
    validate: (v) => {
      if (!KEY.test(v)) return "Use lowercase letters, numbers and dashes.";
      return taken.has(v) ? `"${v}" is already a project.` : null;
    },
  });
  const name = await p.ask("Display name", { default: toTitle(repo.name) });
  const aliases = splitList(await p.ask("Other names people call it, separated by commas", { optional: true }));

  const steps = await p.choose(
    "How does a release go?",
    [
      { label: "QA regression: PRs merge, QA tests on staging, then a release manager approves", value: "qa-regression" },
      { label: "Direct release: no QA step, a release manager approves straight away", value: "direct-release" },
    ],
    { default: "qa-regression" },
  );

  const tracker = await setupTracker(ctx, repo, github);
  const release = await setupRelease(p, repo, github);
  const deploy = await setupDeploy(p, repo, github);
  const people = await setupPeople(p, github);

  return {
    key,
    name,
    aliases,
    repo: repo.full_name,
    tracker,
    release,
    deploy,
    steps,
    approval: people.approval,
    people: {
      release_managers: { github: people.releaseManagers },
      qa: { github: people.qa },
    },
  };
}

async function pickRepo(p, repos) {
  if (repos.length <= LIST_LIMIT) {
    return p.choose("Which repo?", repos.map((r) => ({ label: r.full_name, value: r })));
  }
  const fullName = await p.ask("Which repo? Type owner/name", {
    validate: (v) => (repos.some((r) => r.full_name.toLowerCase() === v.toLowerCase()) ? null : "The app can't see that repo. Check it's added to the installation."),
  });
  return repos.find((r) => r.full_name.toLowerCase() === fullName.toLowerCase());
}

async function setupTracker(ctx, repo, github) {
  const p = ctx.prompter;
  for (;;) {
    const type = await p.choose(
      "Where does this project's work live?",
      [
        { label: "A GitHub Projects board", value: "github-projects" },
        { label: "GitHub issues, with a label for each status", value: "github-issues" },
        { label: "A ClickUp list", value: "clickup" },
      ],
      { default: "github-projects" },
    );

    if (type === "github-projects") {
      if (repo.ownerType !== "Organization") {
        p.write("  ! A GitHub App can't read boards on a personal account. Pick GitHub issues or ClickUp.\n");
        continue;
      }
      const boards = await listProjects(github, repo.owner);
      const number = boards.length
        ? await p.choose(`Which ${repo.owner} board?`, boards.map((b) => ({ label: `#${b.number} ${b.title}`, value: b.number })))
        : Number(
            await p.ask("Board number, from its URL (.../projects/<number>)", {
              validate: (v) => (/^\d+$/.test(v) ? null : "The board number is a number."),
            }),
          );
      const info = await getProjectStatuses(github, { owner: repo.owner, number });
      return { type, number, statuses: await mapStatuses(p, info.statuses) };
    }

    if (type === "github-issues") {
      const info = await getIssueStatuses(github, { repo: repo.full_name });
      if (info.statuses.length <= 1) {
        p.write(`  ! ${repo.full_name} has no labels yet. Create one per status (ready, staged, ready for release), then pick this again.\n`);
        continue;
      }
      return { type, statuses: await mapStatuses(p, info.statuses) };
    }

    const clickup = await clickupClient(ctx);
    const list = await p.ask("ClickUp list URL or ID", {
      validate: (v) => (parseListId(v) ? null : "Paste the list's URL, or the number after /li/ in it."),
    });
    const info = await getListStatuses(clickup, { list: parseListId(list) });
    p.write(`  Found the "${info.title}" list.\n`);
    const releaseList = await p.ask("List to create release tasks in, if different", { optional: true });
    const template = await p.ask("ID of a task to copy for each release, such as one holding your QA checklist", {
      optional: true,
    });
    const prField = await p.ask("Name of the custom field holding PR links (AKO also reads the description)", {
      optional: true,
    });
    return {
      type,
      list: parseListId(list),
      release_list: releaseList ? parseListId(releaseList) : null,
      release_template: template || null,
      pr_field: prField || null,
      statuses: await mapStatuses(p, info.statuses),
    };
  }
}

async function clickupClient(ctx) {
  const p = ctx.prompter;
  for (;;) {
    const token = ctx.env.CLICKUP_API_TOKEN || (await p.ask("ClickUp API token (Settings > Apps)", { secret: true }));
    const clickup = ctx.services.createClickUpClient({ token, fetch: ctx.fetch });
    try {
      const user = await getUser(clickup);
      if (ctx.env.CLICKUP_API_TOKEN !== token) ctx.saveEnv({ CLICKUP_API_TOKEN: token }, "ClickUp");
      p.write(`  Signed in to ClickUp as ${user.username ?? user.email}.\n`);
      return clickup;
    } catch (error) {
      p.write(`  ✗ ClickUp refused the token (${error.message}).\n`);
      ctx.env.CLICKUP_API_TOKEN = "";
    }
  }
}

/** Asks which tracker status plays each part, guessing from the names. */
export async function mapStatuses(p, available) {
  const options = available.map((s) => ({ label: s, value: s }));
  const none = { label: "None", value: null };
  const guess = (pattern) => available.find((s) => pattern.test(s)) ?? null;

  const ready = await p.chooseMany("Which status means the work is ready to go into a release?", options, {
    defaults: [guess(/ready for staging|ready to release|^ready$/i)].filter(Boolean),
  });
  const staged = await p.choose("Which status do issues move to once their PRs merge?", [none, ...options], {
    default: guess(/staged|on staging|merged/i),
  });
  const readyForRelease = await p.choose("Which status does QA move tested work to?", options, {
    default: guess(/ready for release|ready release|tested|qa passed/i),
  });
  const done = await p.choose("Which status means released?", options, {
    default: guess(/^done$|released|^closed$/i) ?? (available.includes(CLOSED) ? CLOSED : undefined),
  });
  return { ready, staged, ready_for_release: readyForRelease, done };
}

async function setupRelease(p, repo, github) {
  const type = await p.choose(
    "What gets released?",
    [
      { label: "A tag on one branch: PRs merge into it and the tested commit is tagged", value: "tag" },
      { label: "A release branch: PRs merge into staging, which is promoted to production", value: "release-branch" },
    ],
    { default: "tag" },
  );
  const exists = (branch) => branchExists(github, repo.full_name, branch);

  if (type === "tag") {
    const branch = await p.ask("Branch PRs merge into and releases are tagged from", {
      default: repo.default_branch,
      validate: async (v) => ((await exists(v)) ? null : `${repo.full_name} has no branch "${v}".`),
    });
    const tagPrefix = await askTagPrefix(p);
    return { type, branch, tag_prefix: tagPrefix };
  }

  const from = await p.ask("Branch PRs merge into (it deploys to staging)", {
    default: "staging",
    validate: async (v) => ((await exists(v)) ? null : `${repo.full_name} has no branch "${v}".`),
  });
  const to = await p.ask("Branch that ships to production", {
    default: repo.default_branch,
    validate: async (v) => {
      if (v === from) return "Pick a different branch from the staging one.";
      return (await exists(v)) ? null : `${repo.full_name} has no branch "${v}".`;
    },
  });
  return { type, from, to, tag_prefix: await askTagPrefix(p) };
}

function askTagPrefix(p) {
  return p.ask(`Tag prefix. Tags look like <prefix>20261102_0`, {
    default: DEFAULT_TAG_PREFIX,
    validate: (v) => (TAG_PREFIX.test(v) ? null : "Use letters, numbers, dots, dashes, underscores or slashes."),
  });
}

async function branchExists(github, repo, branch) {
  try {
    await github.request("GET", `/repos/${repo}/branches/${encodeURIComponent(branch).replace(/%2F/g, "/")}`);
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

async function setupDeploy(p, repo, github) {
  const type = await p.choose(
    "What does the release tag start, so AKO can report how the deploy went?",
    [
      { label: "A GitHub Actions workflow", value: "actions" },
      { label: "A commit status (CircleCI, Jenkins, Bitrise...)", value: "commit-status" },
      { label: "A check run (Google Cloud Build...)", value: "check-run" },
      { label: "Nothing to watch", value: "none" },
    ],
    { default: "actions" },
  );
  if (type === "actions") {
    const data = await github.request("GET", `/repos/${repo.full_name}/actions/workflows?per_page=100`);
    const files = (data.workflows ?? []).map((w) => w.path.split("/").pop());
    const workflow = files.length
      ? await p.choose("Which workflow deploys a release tag?", files.map((f) => ({ label: f, value: f })))
      : await p.ask("Workflow file that deploys a release tag, such as deploy.yml");
    return { type, workflow };
  }
  if (type === "commit-status") {
    return { type, context: await p.ask("Start of the commit status name to watch, such as ci/circleci: deploy") };
  }
  if (type === "check-run") {
    return { type, check: await p.ask("Start of the check run name to watch") };
  }
  return { type };
}

async function setupPeople(p, github) {
  const approval = await p.choose(
    "Who approves a release?",
    [
      { label: "A release manager, who can't approve their own request", value: "others" },
      { label: "Whoever asked for it (for solo developers)", value: "self" },
    ],
    { default: "others" },
  );
  const validate = (list) => validateGitHubPeople(github, list);
  const releaseManagers = splitList(
    await p.ask("Release managers' GitHub usernames or org/team, separated by commas", { optional: true, validate }),
  );
  if (approval === "others" && releaseManagers.length === 0) {
    p.write("  ! No GitHub release managers yet. Add Slack ones in the Slack step; if there are none by the end, the setup asks again.\n");
  }
  const qa = splitList(await p.ask("QA's GitHub usernames or org/team, separated by commas", { optional: true, validate }));
  return { approval, releaseManagers, qa };
}

/** Checks each entry looks right and, with a client, that each user exists. */
export async function validateGitHubPeople(github, value) {
  for (const entry of splitList(value)) {
    if (!GITHUB_ENTRY.test(entry)) return `"${entry}" isn't a GitHub username or org/team.`;
    // Teams need the app's Members permission to read, so `npx ako check` covers them.
    if (entry.includes("/") || !github) continue;
    try {
      await github.request("GET", `/users/${entry}`);
    } catch (error) {
      if (error.status === 404) return `There's no GitHub user "${entry}".`;
      throw error;
    }
  }
  return null;
}

export function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function toKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function toTitle(name) {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}
