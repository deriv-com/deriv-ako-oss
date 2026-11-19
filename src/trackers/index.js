// One entry point for the trackers a project can use.
//
// `createTracker` gives the release engine one interface whatever the board:
//   readyItems({ exclude })        work ready to go into a release
//   openRelease(tag, items)        the release in the tracker (a milestone, or a ClickUp task)
//   addItems(release, items)       more work into a release already open
//   itemStatuses(items)            each item's current status
//   moveItems(items, status)       move work between columns or labels
//   pullRequests(item)             the item's PRs in the project's repo
//   closeRelease(release)          close the milestone when the release is archived
//   notify(release, text)          a comment where the tracker's people will see it
// Items are `{ id, ref, number?, title, url, status, closed }`.

import { getProjectStatuses, readBoard, setBoardStatus } from "./githubProjects.js";
import { getIssueStatuses, issueStatus, setIssueStatus, CLOSED } from "./githubIssues.js";
import { getListStatuses, listTasks, getTask, pullRequestLinks } from "./clickup.js";
import * as g from "../engine/github.js";

export const TRACKER_LABELS = {
  "github-projects": "GitHub Projects board",
  "github-issues": "GitHub issues with labels",
  clickup: "ClickUp list",
};

/**
 * The statuses (columns or labels) a project's tracker offers.
 * `github` is an installation client for the repo owner; `clickup` is only
 * needed for ClickUp trackers.
 */
export async function trackerStatuses(project, { github, clickup }) {
  const { tracker } = project;
  if (tracker.type === "github-projects") return getProjectStatuses(github, tracker);
  if (tracker.type === "github-issues") return getIssueStatuses(github, { repo: project.repo });
  if (tracker.type === "clickup") {
    if (!clickup) throw new Error("CLICKUP_API_TOKEN is not set.");
    return getListStatuses(clickup, tracker);
  }
  throw new Error(`Unknown tracker type "${tracker.type}".`);
}

/** Every status name a project's flow file uses. */
export function configuredStatuses(tracker) {
  const { ready, staged, ready_for_release, done, catch_up } = tracker.statuses;
  return [...ready, staged, ready_for_release, done, ...catch_up].filter(Boolean);
}

/** Status names in the flow file that the tracker doesn't have. ClickUp ignores case. */
export function unknownStatuses(tracker, available) {
  const fold = tracker.type === "clickup" ? (s) => s.toLowerCase() : (s) => s;
  const known = new Set(available.map(fold));
  return [...new Set(configuredStatuses(tracker))].filter((s) => !known.has(fold(s)));
}

const fold = (s) => String(s ?? "").toLowerCase();

/** Releases on GitHub trackers are milestones; their PRs come from each issue's Development section. */
function githubMilestones(project, gh) {
  const repo = project.repo;
  return {
    async openRelease(tag, items) {
      const milestone = await g.createMilestone(gh, repo, {
        title: tag,
        description: `Release ${tag} of ${project.name}, opened by Deriv AKO.`,
      });
      for (const item of items) await g.setIssueMilestone(gh, repo, item.number, milestone.number);
      return { milestone: milestone.number, url: milestone.html_url };
    },
    async addItems(release, items) {
      for (const item of items) await g.setIssueMilestone(gh, repo, item.number, release.milestone);
    },
    async pullRequests(item) {
      return (await g.issuePullRequests(gh, repo, item.number)).filter((pr) => fold(pr.repo) === fold(repo));
    },
    async closeRelease(release) {
      if (release?.milestone) await g.closeMilestone(gh, repo, release.milestone);
    },
    async notify() {
      // GitHub trackers are notified on the release's tracking issue already.
    },
  };
}

/** Closed issues left in an earlier column, whose PRs all reached the release branch. */
async function caughtUp(candidates, pullRequests) {
  const picked = [];
  for (const item of candidates.filter((i) => i.closed)) {
    const prs = await pullRequests(item);
    if (prs.length && prs.every((pr) => pr.state === "merged" || pr.state === "closed") && prs.some((pr) => pr.state === "merged")) {
      picked.push({ ...item, caughtUp: true });
    }
  }
  return picked;
}

// `boardGh` reads the board: a board in another org than the repo needs that org's token.
function githubProjectsTracker(project, gh, boardGh = gh) {
  const { statuses } = project.tracker;
  const base = githubMilestones(project, gh);
  let board = null;
  const load = async (fresh = false) => {
    if (fresh || !board) board = await readBoard(boardGh, project.tracker);
    return board;
  };
  const inRepo = (b) => b.items.filter((i) => fold(i.repo) === fold(project.repo));
  const asItem = (i) => ({ id: String(i.number), ref: `#${i.number}`, number: i.number, title: i.title, url: i.url, status: i.status, closed: i.closed, projectItemId: i.projectItemId });

  return {
    ...base,
    async readyItems() {
      const items = inRepo(await load(true)).filter((i) => !i.milestone);
      const ready = items.filter((i) => statuses.ready.includes(i.status)).map(asItem);
      const catchUp = await caughtUp(items.filter((i) => statuses.catch_up.includes(i.status)).map(asItem), base.pullRequests);
      return [...ready, ...catchUp];
    },
    async itemStatuses(items) {
      const byNumber = new Map(inRepo(await load(true)).map((i) => [String(i.number), i]));
      return new Map(items.map((item) => [item.id, { status: byNumber.get(item.id)?.status ?? null, closed: byNumber.get(item.id)?.closed ?? false }]));
    },
    async moveItems(items, status) {
      const b = await load();
      const byNumber = new Map(inRepo(b).map((i) => [String(i.number), i]));
      const failed = [];
      for (const item of items) {
        const onBoard = byNumber.get(item.id);
        try {
          if (!onBoard) throw new Error("not on the board");
          await setBoardStatus(boardGh, b, onBoard.projectItemId, status);
        } catch (error) {
          failed.push({ ref: item.ref, reason: error.message });
        }
      }
      return { moved: items.length - failed.length, failed };
    },
  };
}

function githubIssuesTracker(project, gh) {
  const { statuses } = project.tracker;
  const repo = project.repo;
  const base = githubMilestones(project, gh);
  const asItem = (issue) => ({
    id: String(issue.number),
    ref: `#${issue.number}`,
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    status: issueStatus(issue, statuses),
    closed: issue.state === "closed",
    labels: issue.labels,
  });
  const issuesLabelled = async (label) =>
    (await gh.paginate(`/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=all&milestone=none`, { maxPages: 5 }))
      .filter((i) => !i.pull_request)
      .map(asItem);

  return {
    ...base,
    async readyItems() {
      const ready = new Map();
      for (const label of statuses.ready.filter((s) => s !== CLOSED)) {
        for (const item of await issuesLabelled(label)) ready.set(item.id, item);
      }
      const candidates = [];
      for (const label of statuses.catch_up.filter((s) => s !== CLOSED)) candidates.push(...(await issuesLabelled(label)));
      for (const item of await caughtUp(candidates.filter((i) => !ready.has(i.id)), base.pullRequests)) ready.set(item.id, item);
      return [...ready.values()];
    },
    async itemStatuses(items) {
      const result = new Map();
      for (const item of items) {
        const issue = await gh.request("GET", `/repos/${repo}/issues/${item.number}`);
        result.set(item.id, { status: issueStatus(issue, statuses), closed: issue.state === "closed" });
      }
      return result;
    },
    async moveItems(items, status) {
      const failed = [];
      for (const item of items) {
        try {
          const issue = await gh.request("GET", `/repos/${repo}/issues/${item.number}`);
          await setIssueStatus(gh, repo, issue, status, statuses);
        } catch (error) {
          failed.push({ ref: item.ref, reason: error.message });
        }
      }
      return { moved: items.length - failed.length, failed };
    },
  };
}

function clickupTracker(project, gh, clickup) {
  if (!clickup) throw new Error("This project's work is on ClickUp, but CLICKUP_API_TOKEN is not set.");
  const { statuses, list, release_list: releaseList, release_template: template, pr_field: field } = project.tracker;
  const asItem = (task) => ({
    id: task.id,
    ref: task.custom_id ?? task.id,
    title: task.name,
    url: task.url,
    status: task.status?.status ?? null,
    closed: task.status?.type === "closed" || task.status?.type === "done",
  });

  return {
    async readyItems({ exclude = new Set() } = {}) {
      const tasks = await listTasks(clickup, list, statuses.ready);
      return tasks.map(asItem).filter((item) => !exclude.has(item.id));
    },
    async openRelease(tag, items) {
      const target = releaseList ?? list;
      const task = template
        ? await clickup.request("POST", `/list/${target}/taskTemplate/${template}`, { name: tag })
        : await clickup.request("POST", `/list/${target}/task`, {
            name: tag,
            description: `Release ${tag} of ${project.name}, opened by Deriv AKO.`,
          });
      const id = task.id ?? task.task?.id;
      await this.addItems({ task: id }, items);
      return { task: id, url: task.url ?? task.task?.url ?? null };
    },
    async addItems(release, items) {
      for (const item of items) await clickup.request("POST", `/task/${item.id}/link/${release.task}`);
    },
    async itemStatuses(items) {
      const result = new Map();
      for (const item of items) {
        const task = await getTask(clickup, item.id);
        result.set(item.id, { status: task.status?.status ?? null, closed: task.status?.type === "closed" });
      }
      return result;
    },
    async moveItems(items, status) {
      const failed = [];
      for (const item of items) {
        try {
          await clickup.request("PUT", `/task/${item.id}`, { status });
        } catch (error) {
          failed.push({ ref: item.ref, reason: error.message });
        }
      }
      return { moved: items.length - failed.length, failed };
    },
    async pullRequests(item) {
      const task = await getTask(clickup, item.id);
      const prs = [];
      for (const link of pullRequestLinks(task, { field, repo: project.repo })) prs.push(await g.getPull(gh, link.repo, link.number));
      return prs;
    },
    async closeRelease() {
      // The release task's own statuses belong to the team, so AKO leaves it as it is.
    },
    async notify(release, text) {
      if (release?.task) await clickup.request("POST", `/task/${release.task}/comment`, { comment_text: text, notify_all: true });
    },
  };
}

/** The release engine's view of a project's tracker. */
export function createTracker(project, { gh, boardGh, clickup }) {
  const { type } = project.tracker;
  if (type === "github-projects") return githubProjectsTracker(project, gh, boardGh);
  if (type === "github-issues") return githubIssuesTracker(project, gh);
  if (type === "clickup") return clickupTracker(project, gh, clickup);
  throw new Error(`Unknown tracker type "${type}".`);
}

/** Whether an item has reached `status`. ClickUp ignores case; `closed` also counts closed issues. */
export function atStatus(tracker, current, status) {
  if (!current) return false;
  // Merging a PR closes the issues it names, so a plain issue still labelled
  // Staged is closed without QA having passed it. Only a closed issue with no
  // status label counts as closed.
  if (status === CLOSED && tracker.type === "github-issues") return current.closed && current.status === CLOSED;
  if (status === CLOSED) return current.closed;
  return tracker.type === "clickup" ? fold(current.status) === fold(status) : current.status === status;
}
