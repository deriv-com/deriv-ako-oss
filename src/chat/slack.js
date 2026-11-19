// Slack: the app manifest, and the Web API calls setup and check need.
//
// AKO connects to Slack over Socket Mode, a WebSocket AKO opens itself, so
// Slack never needs to reach a public URL. That takes two tokens: the bot
// token (xoxb-) for API calls and an app-level token (xapp-) with the
// `connections:write` scope to open the socket.

import { fetchWithRateLimit } from "../net/rateLimit.js";

export const SLACK_API_URL = "https://slack.com/api";

// Only what the bot uses. A mention in a thread arrives as an app_mention
// event, so AKO never needs to read channel history, and it only replies to
// direct messages, never opens one.
export const BOT_SCOPES = [
  "app_mentions:read", // hear @ako
  "channels:read", // look up channels during setup
  "chat:write", // post release messages
  "groups:read",
  "im:history", // direct messages to AKO
  "usergroups:read", // expand a release-manager user group into its members
  "users:read", // pick people by name during setup
];

/**
 * Builds the Slack app manifest. `agent: true` adds Slack's agent view, so
 * AKO also opens in Slack's side panel for AI apps.
 */
export function buildSlackManifest({ name = "AKO", agent = false } = {}) {
  const scopes = [...BOT_SCOPES];
  const events = ["app_mention", "message.im"];
  const features = {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: name.toLowerCase(), always_online: true },
  };
  if (agent) {
    scopes.push("assistant:write");
    events.push("assistant_thread_started", "assistant_thread_context_changed");
    features.assistant_view = {
      assistant_description: "Ask AKO to start a release, check what's ready, or approve one.",
      suggested_prompts: [
        { title: "What's ready?", message: "what's ready to release?" },
        { title: "Start a release", message: "create a release" },
      ],
    };
  }
  return {
    display_information: {
      name,
      description: "Release manager: picks up ready work, opens releases and asks for approval.",
      background_color: "#1d2a44",
    },
    features,
    oauth_config: { scopes: { bot: scopes } },
    settings: {
      event_subscriptions: { bot_events: events },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

/** Opens Slack's "create app" page with the manifest filled in. */
export function createSlackAppUrl(manifest) {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

export class SlackError extends Error {
  constructor(method, code) {
    super(`Slack ${method} failed: ${code}`);
    this.name = "SlackError";
    this.code = code;
  }
}

export function createSlackClient({ token, apiUrl = SLACK_API_URL, fetch = globalThis.fetch, sleep }) {
  async function call(method, params = {}) {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) body.set(key, String(value));
    }
    // Slack answers a rate-limited call with 429 and Retry-After.
    const init = {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    };
    const response = await fetchWithRateLimit(fetch, `${apiUrl}/${method}`, init, { sleep });
    const data = await response.json().catch(() => ({ ok: false, error: `http_${response.status}` }));
    if (!data.ok) throw new SlackError(method, data.error ?? "unknown_error");
    return data;
  }

  async function paginate(method, key, params = {}, maxPages = 50) {
    const items = [];
    let cursor;
    for (let page = 0; page < maxPages; page += 1) {
      const data = await call(method, { limit: 200, ...params, cursor });
      items.push(...(data[key] ?? []));
      cursor = data.response_metadata?.next_cursor;
      if (!cursor) break;
    }
    return items;
  }

  return { call, paginate };
}

/** Checks a token is the kind the field expects before any API call. */
export function tokenKind(token = "") {
  if (token.startsWith("xoxb-")) return "bot";
  if (token.startsWith("xapp-")) return "app";
  return "unknown";
}

/** Finds workspace members whose name, display name or real name contains `query`. */
export function matchUsers(users, query) {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  return users.filter((u) => {
    if (u.deleted || u.is_bot || u.id === "USLACKBOT") return false;
    const names = [u.name, u.real_name, u.profile?.display_name, u.profile?.real_name];
    return names.some((n) => n && n.toLowerCase().includes(q));
  });
}

/** Finds user groups whose handle or name contains `query`. */
export function matchGroups(groups, query) {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  return groups.filter((g) => !g.date_delete && [g.handle, g.name].some((n) => n && n.toLowerCase().includes(q)));
}
