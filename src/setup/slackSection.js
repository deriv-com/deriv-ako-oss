// Setup step: connect Slack, then pick each project's channel and people.
// Also what `ako chat add slack` runs.

import { buildSlackManifest, createSlackAppUrl, createSlackClient, tokenKind, matchUsers, matchGroups } from "../chat/slack.js";
import { projectKeys, setProjectValues } from "./flowFile.js";
import { splitList } from "./projectSection.js";

/**
 * `only` limits it to some projects, such as ones just added; `reuse` uses the
 * Slack app already in .env when it still works, instead of connecting again.
 */
export async function setupSlack(ctx, doc, { only = null, reuse = false } = {}) {
  const p = ctx.prompter;
  p.write("\n== Slack ==\n");
  const bot = (reuse && (await connectedSlack(ctx))) || (await connectSlack(ctx));
  const directory = createDirectory(bot);

  for (const key of only ?? projectKeys(doc)) {
    if (!(await p.confirm(`Set up Slack for "${key}"?`, true))) continue;
    const channel = await askChannel(p, directory);
    const releaseManagers = await askPeople(p, `Release managers for "${key}" in Slack: names or @user-groups`, directory);
    const qa = await askPeople(p, `QA for "${key}" in Slack: names or @user-groups`, directory);
    setProjectValues(doc, key, [
      [["slack", "channels"], channel ? [channel.id] : []],
      [["people", "release_managers", "slack"], releaseManagers],
      [["people", "qa", "slack"], qa],
    ]);
    if (channel && !channel.is_member) ctx.todo.push(`Invite @ako to #${channel.name} with /invite @ako.`);
  }
  ctx.saveFlow(doc);
}

/** The Slack app already in .env, or null when there is none or Slack refuses it. */
async function connectedSlack(ctx) {
  if (!ctx.env.SLACK_BOT_TOKEN || !ctx.env.SLACK_APP_TOKEN) return null;
  const bot = ctx.services.createSlackClient({ token: ctx.env.SLACK_BOT_TOKEN, fetch: ctx.fetch });
  try {
    const auth = await bot.call("auth.test");
    ctx.prompter.write(`  Connected to the ${auth.team} workspace as @${auth.user}.\n`);
    return bot;
  } catch {
    return null;
  }
}

async function connectSlack(ctx) {
  const p = ctx.prompter;
  p.write("AKO connects to Slack over a WebSocket it opens itself (Socket Mode), so Slack never needs a public URL.\n");
  const agent = await p.choose(
    "Install AKO as:",
    [
      { label: "A Slack app: people @mention it in channels and threads", value: false },
      { label: "A Slack agent: the same, plus Slack's side panel for AI apps", value: true },
    ],
    { default: false },
  );
  const url = createSlackAppUrl(buildSlackManifest({ agent }));
  p.write(
    [
      "Do this in the page that opens:",
      "  1. Pick your workspace and create the app. Its settings come from AKO's manifest.",
      "  2. Install it to the workspace (Install App), then copy the Bot User OAuth Token (xoxb-...).",
      "  3. Basic Information > App-Level Tokens: generate one with the connections:write scope (xapp-...).",
      `If no page opens, create an app "From a manifest" and paste manifests/${agent ? "slack-agent" : "slack-app"}.yaml.`,
      "",
    ].join("\n"),
  );
  ctx.openUrl(url);

  let bot;
  for (;;) {
    const token = await p.ask("Bot token (xoxb-...)", {
      secret: true,
      default: ctx.env.SLACK_BOT_TOKEN || undefined,
      validate: (v) => (tokenKind(v) === "bot" ? null : "A bot token starts with xoxb-."),
    });
    bot = ctx.services.createSlackClient({ token, fetch: ctx.fetch });
    try {
      const auth = await bot.call("auth.test");
      p.write(`  Connected to the ${auth.team} workspace as @${auth.user}.\n`);
      ctx.saveEnv({ SLACK_BOT_TOKEN: token }, "Slack");
      break;
    } catch (error) {
      p.write(`  ✗ Slack refused the token (${error.code ?? error.message}).\n`);
      ctx.env.SLACK_BOT_TOKEN = "";
    }
  }

  for (;;) {
    const token = await p.ask("App-level token (xapp-...)", {
      secret: true,
      default: ctx.env.SLACK_APP_TOKEN || undefined,
      validate: (v) => (tokenKind(v) === "app" ? null : "An app-level token starts with xapp-."),
    });
    try {
      // Asks Slack for a socket URL without connecting: proves the token can open one.
      await ctx.services.createSlackClient({ token, fetch: ctx.fetch }).call("apps.connections.open");
      ctx.saveEnv({ SLACK_APP_TOKEN: token }, "Slack");
      break;
    } catch (error) {
      p.write(`  ✗ Slack refused the app-level token (${error.code ?? error.message}). It needs the connections:write scope.\n`);
      ctx.env.SLACK_APP_TOKEN = "";
    }
  }
  return bot;
}

function createDirectory(bot) {
  const cache = {};
  const load = (name, method, key, params) => (cache[name] ??= bot.paginate(method, key, params));
  return {
    channels: () =>
      load("channels", "conversations.list", "channels", { types: "public_channel,private_channel", exclude_archived: true }),
    users: () => load("users", "users.list", "members"),
    groups: async () => {
      try {
        const data = await (cache.groups ??= bot.call("usergroups.list"));
        return data.usergroups ?? [];
      } catch {
        // Free workspaces have no user groups.
        return [];
      }
    },
  };
}

async function askChannel(p, directory) {
  const channels = await directory.channels();
  const value = await p.ask("Channel for its release messages, such as #web-releases", {
    optional: true,
    validate: (v) =>
      findChannel(channels, v) ? null : `AKO can't see a channel "${v}". For a private channel, /invite @ako there first.`,
  });
  return value ? findChannel(channels, value) : null;
}

function findChannel(channels, input) {
  const name = input.trim().replace(/^#/, "").toLowerCase();
  return channels.find((c) => c.id === input.trim() || c.name?.toLowerCase() === name) ?? null;
}

async function askPeople(p, question, directory) {
  for (;;) {
    const raw = await p.ask(`${question}, separated by commas`, { optional: true });
    if (!raw) return [];
    const ids = [];
    let problem = null;
    for (const term of splitList(raw)) {
      const id = await resolvePerson(p, term, directory);
      if (!id) {
        problem = `No one in Slack matches "${term}".`;
        break;
      }
      ids.push(id);
    }
    if (!problem) return [...new Set(ids)];
    p.write(`  ✗ ${problem}\n`);
  }
}

/** A user ID (U...) or user group ID (S...) for a typed name, asking when several match. */
async function resolvePerson(p, term, directory) {
  if (/^[UWS][A-Z0-9]{6,}$/.test(term)) return term;
  const groups = term.startsWith("@") ? matchGroups(await directory.groups(), term) : [];
  const exactGroup = groups.find((g) => g.handle?.toLowerCase() === term.slice(1).toLowerCase());
  if (exactGroup) return exactGroup.id;

  const users = matchUsers(await directory.users(), term);
  const matches = [
    ...groups.map((g) => ({ label: `@${g.handle} (user group: ${g.name})`, value: g.id })),
    ...users.map((u) => ({ label: `${u.real_name || u.name} (@${u.profile?.display_name || u.name})`, value: u.id })),
  ];
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].value;
  return p.choose(`Which "${term}"?`, matches.slice(0, 20));
}
