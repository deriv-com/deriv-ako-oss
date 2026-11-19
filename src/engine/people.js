// Who is acting, and whether they may approve a release.
//
// An actor is whoever asked: a GitHub user (the terminal, signed in with
// `ako login`), a Slack user (the Slack bot), or the app itself. Release
// managers are listed per chat tool in the flow file, so a Slack approval is
// checked against the Slack list and a terminal approval against GitHub's.

import { isTeamMember } from "./github.js";

export const githubActor = (login) => ({ kind: "github", login });
export const slackActor = (id) => ({ kind: "slack", id });
export const APP_ACTOR = { kind: "app" };

/** A stable string for an actor, as stored on the release. */
export function actorId(actor) {
  if (actor.kind === "github") return `github:${actor.login}`;
  if (actor.kind === "slack") return `slack:${actor.id}`;
  return "app";
}

/** How an actor is shown in a GitHub comment. */
export function actorText(id) {
  const [kind, value] = String(id).split(":");
  if (kind === "github") return `@${value}`;
  if (kind === "slack") return `Slack user ${value}`;
  return "the AKO app";
}

/** `@login` and `@org/team` mentions for GitHub comments. */
export function githubMentions(list = []) {
  return list.map((entry) => `@${entry}`).join(" ");
}

/** `<@U…>` and `<!subteam^S…>` mentions for Slack messages. */
export function slackMentions(list = []) {
  return list.map((id) => (id.startsWith("S") ? `<!subteam^${id}>` : `<@${id}>`)).join(" ");
}

/**
 * Whether `actor` may approve `project`'s releases.
 * Returns `{ ok, reason }`; `reason` says what to do when `ok` is false.
 */
export async function isReleaseManager(project, actor, { gh, slack } = {}) {
  const managers = project.people.release_managers;
  if (actor.kind === "github") {
    const listed = managers.github ?? [];
    const login = actor.login.toLowerCase();
    if (listed.some((entry) => !entry.includes("/") && entry.toLowerCase() === login)) return { ok: true };
    for (const team of listed.filter((entry) => entry.includes("/"))) {
      if (gh && (await isTeamMember(gh, team, actor.login))) return { ok: true };
    }
    return {
      ok: false,
      reason: listed.length
        ? `@${actor.login} isn't a release manager for ${project.name}. They are: ${listed.join(", ")}.`
        : `${project.name} lists no GitHub release managers, so approve in Slack, or add GitHub usernames to the flow file.`,
    };
  }
  if (actor.kind === "slack") {
    const listed = managers.slack ?? [];
    if (listed.includes(actor.id)) return { ok: true };
    for (const group of listed.filter((id) => id.startsWith("S"))) {
      if (slack && (await groupMembers(slack, group)).includes(actor.id)) return { ok: true };
    }
    return {
      ok: false,
      reason: listed.length
        ? `<@${actor.id}> isn't a release manager for ${project.name}.`
        : `${project.name} lists no Slack release managers, so approve from the terminal with \`npx ako release approve ${project.key}\`.`,
    };
  }
  return { ok: false, reason: "Approving needs a person. In the terminal, sign in first with `npx ako login`." };
}

const GROUP_CACHE_MS = 10 * 60 * 1000;
const groupCache = new Map();

/** Drops the entries whose time is up, so the cache holds only live lookups. */
export function pruneExpired(cache, now = Date.now()) {
  for (const [key, entry] of cache) {
    if (entry.until <= now) cache.delete(key);
  }
}

/** A Slack user group's members, cached for 10 minutes. */
async function groupMembers(slack, group) {
  pruneExpired(groupCache);
  const cached = groupCache.get(group);
  if (cached) return cached.members;
  try {
    const data = await slack.call("usergroups.users.list", { usergroup: group });
    groupCache.set(group, { members: data.users ?? [], until: Date.now() + GROUP_CACHE_MS });
    return data.users ?? [];
  } catch {
    return [];
  }
}
