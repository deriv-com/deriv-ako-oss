// Where a release's state lives: a tracking issue in the project's repo.
//
// Keeping it on GitHub rather than inside a copy of AKO means the terminal,
// the Slack bot and a restarted server all read the same release, and nothing
// is lost when a process stops. The issue body ends with the state as JSON in
// an HTML comment; the rest of the body is a summary for people.
//
// Changes that act on GitHub (merging, tagging, archiving) take a lock first:
// a comment on the tracking issue naming who holds it and until when. Each
// copy posts its lock and reads the comments back; the earliest unexpired lock
// wins, so two copies can't both go ahead. A crashed copy's lock simply expires.
// Anyone who can read a repo may comment on its issues, so a lock counts only
// when AKO's app or someone with access to the repo posted it.

import * as g from "./github.js";

export const RELEASE_LABEL = "ako-release";
export const LOCK_MS = 10 * 60 * 1000;
const STATE = /<!-- ako-state\n([\s\S]*?)\n-->/;
const LOCK = /<!-- ako-lock (\{.*?\}) -->/;

export const STATUS_TEXT = {
  open: "Opened",
  in_regression: "In regression",
  awaiting_approval: "Waiting for approval",
  on_hold: "On hold",
  published: "Published",
  archived: "Archived",
};

/** Releases still being worked on: opened, not yet published. */
export const IN_FLIGHT = new Set(["open", "in_regression", "awaiting_approval", "on_hold"]);

export class LockedError extends Error {
  constructor(holder, until) {
    super(`Another copy of AKO (${holder}) is working on this release until ${until.slice(11, 16)} UTC. Try again then, or run \`npx ako release unlock\` with the release's tag.`);
    this.name = "LockedError";
    this.holder = holder;
  }
}

export function parseState(body) {
  const match = String(body ?? "").match(STATE);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

export function renderBody(project, state) {
  const items = state.items.map((i) => `- ${i.url ? `[${i.ref ?? i.title}](${i.url})` : i.ref ?? i.id} ${i.title}`).join("\n");
  const lines = [
    `AKO tracks release \`${state.tag}\` of **${project.name}** here. Please don't edit the block at the end of this description.`,
    "",
    `- **Status:** ${STATUS_TEXT[state.status] ?? state.status}`,
    `- **Opened by:** ${state.openedBy}`,
    state.testedSha ? `- **Tested commit:** ${state.testedSha.slice(0, 7)}` : null,
    state.approval?.requestedBy ? `- **Approval requested by:** ${state.approval.requestedBy}` : null,
    state.decision ? `- **${state.decision.verdict === "approved" ? "Approved" : "Held"} by:** ${state.decision.by}` : null,
    state.published?.url ? `- **Release:** ${state.published.url}` : null,
    "",
    "**Issues**",
    items || "- none yet",
    "",
    "<!-- ako-state",
    // "--" can't appear inside an HTML comment, and a title holding "-->" would
    // end it early. JSON reads \u002d back as "-".
    JSON.stringify(state, null, 2).replace(/--/g, "-\\u002d"),
    "-->",
  ];
  return lines.filter((line) => line !== null).join("\n");
}

// Comment authors GitHub reports as having access to the repo or its organisation.
const MEMBERS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** `botLogin` is the AKO app's own account, like `my-ako[bot]`, whose locks always count. */
export function createStore(gh, project, { now = () => Date.now(), botLogin = null } = {}) {
  const repo = project.repo;
  const titleFor = (tag) => `AKO release ${tag} (${project.key})`;

  async function list() {
    const issues = await g.listIssuesWithLabel(gh, repo, RELEASE_LABEL);
    return issues
      .map((issue) => ({ issue: issue.number, url: issue.html_url, state: parseState(issue.body) }))
      .filter((record) => record.state?.project === project.key)
      .sort((a, b) => b.issue - a.issue);
  }

  return {
    list,

    async inFlight() {
      return (await list()).filter((r) => IN_FLIGHT.has(r.state.status));
    },

    async findByTag(tag) {
      return (await list()).find((r) => r.state.tag === tag) ?? null;
    },

    async create(state) {
      await g.ensureLabel(gh, repo, RELEASE_LABEL, { description: "Release tracked by Deriv AKO" });
      const issue = await g.createIssue(gh, repo, { title: titleFor(state.tag), body: renderBody(project, state), labels: [RELEASE_LABEL] });
      return { issue: issue.number, url: issue.html_url, state };
    },

    async save(record) {
      await g.updateIssue(gh, repo, record.issue, {
        body: renderBody(project, record.state),
        ...(record.state.status === "archived" ? { state: "closed" } : {}),
      });
      return record;
    },

    async comment(record, text) {
      return g.comment(gh, repo, record.issue, text);
    },

    /** Runs `fn` holding the release's lock. Throws LockedError when another copy holds it. */
    async withLock(record, holder, fn) {
      const expires = new Date(now() + LOCK_MS).toISOString();
      const mine = await g.comment(
        gh,
        repo,
        record.issue,
        `<!-- ako-lock ${JSON.stringify({ holder, expires })} -->\nAKO is working on this release until ${expires.slice(11, 16)} UTC.`,
      );
      // This copy's own account counts too, so two copies running as the app
      // see each other even when the app's name isn't known here.
      const trusted = (c) => c.id === mine.id || [mine.user?.login, botLogin].filter(Boolean).includes(c.user?.login) || MEMBERS.has(c.author_association);
      try {
        const winner = activeLocks(await g.listComments(gh, repo, record.issue), now(), { trusted })[0];
        if (winner && winner.id !== mine.id) throw new LockedError(winner.holder, winner.expires);
        return await fn();
      } finally {
        await g.deleteComment(gh, repo, mine.id);
      }
    },

    /** Removes every lock on the release, for when a copy of AKO crashed mid-step. */
    async unlock(record) {
      const locks = activeLocks(await g.listComments(gh, repo, record.issue), Infinity, { includeExpired: true });
      for (const lock of locks) await g.deleteComment(gh, repo, lock.id);
      return locks.length;
    },
  };
}

/** Lock comments still in force, earliest first. `trusted` picks whose comments count. */
export function activeLocks(comments, at, { includeExpired = false, trusted = () => true } = {}) {
  return comments
    .filter(trusted)
    .map((c) => {
      const match = String(c.body ?? "").match(LOCK);
      if (!match) return null;
      try {
        const lock = JSON.parse(match[1]);
        return { id: c.id, createdAt: c.created_at, holder: lock.holder, expires: lock.expires };
      } catch {
        return null;
      }
    })
    .filter((lock) => lock && (includeExpired || Date.parse(lock.expires) > at))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id - b.id);
}
