// ClickUp boards. A ClickUp list holds the cards; its statuses are the
// columns. Requests use a personal API token (CLICKUP_API_TOKEN). A request
// that hits ClickUp's rate limit is retried once it resets (net/rateLimit.js).

import { fetchWithRateLimit } from "../net/rateLimit.js";

export const CLICKUP_API_URL = "https://api.clickup.com/api/v2";

export function createClickUpClient({ token, apiUrl = CLICKUP_API_URL, fetch = globalThis.fetch, sleep }) {
  async function request(method, path, body) {
    const init = {
      method,
      headers: { Authorization: token, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const response = await fetchWithRateLimit(fetch, `${apiUrl}${path}`, init, { sleep });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { err: `not JSON (HTTP ${response.status})` };
    }
    if (!response.ok) {
      const error = new Error(`ClickUp ${method} ${path} failed with ${response.status}${data.err ? `: ${data.err}` : ""}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }
  return { request };
}

/**
 * Takes a ClickUp list URL or ID and returns the ID. Handles list URLs
 * (`.../v/li/<id>`), view URLs (`.../v/l/6-<id>-1`) and bare IDs.
 */
export function parseListId(input) {
  const text = String(input ?? "").trim();
  if (/^\d+$/.test(text)) return text;
  const direct = text.match(/\/li\/(\d+)/);
  if (direct) return direct[1];
  const view = text.match(/\/v\/l\/\d+-(\d+)-\d+/);
  if (view) return view[1];
  return null;
}

export async function getUser(clickup) {
  const data = await clickup.request("GET", "/user");
  return data.user;
}

/** The list's name and its status names, in board order. */
export async function getListStatuses(clickup, { list }) {
  const data = await clickup.request("GET", `/list/${list}`);
  return {
    title: data.name,
    url: null,
    statuses: (data.statuses ?? []).sort((a, b) => a.orderindex - b.orderindex).map((s) => s.status),
  };
}

// --- The release engine's adapter helpers ---

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

/** Tasks in any of `statuses`, closed ones included. */
export async function listTasks(clickup, list, statuses) {
  const tasks = [];
  const query = statuses.map((s) => `statuses[]=${encodeURIComponent(s)}`).join("&");
  for (let page = 0; page < 20; page += 1) {
    const data = await clickup.request("GET", `/list/${list}/task?include_closed=true&subtasks=true&page=${page}&${query}`);
    tasks.push(...(data.tasks ?? []));
    if (data.last_page !== false || (data.tasks ?? []).length === 0) break;
  }
  return tasks;
}

export async function getTask(clickup, id) {
  return clickup.request("GET", `/task/${id}?include_markdown_description=true`);
}

/** Pull request links in a task: the PR custom field, any field named like "PR", and the description. */
export function pullRequestLinks(task, { field, repo }) {
  const texts = [];
  for (const custom of task.custom_fields ?? []) {
    const named = field ? custom.name === field : /\bpr\b|pull request/i.test(custom.name ?? "");
    if (named && custom.value) texts.push(typeof custom.value === "string" ? custom.value : JSON.stringify(custom.value));
  }
  texts.push(task.markdown_description ?? task.description ?? task.text_content ?? "");
  const links = new Map();
  for (const text of texts) {
    for (const [, linkRepo, number] of text.matchAll(PR_URL)) {
      if (!repo || linkRepo.toLowerCase() === repo.toLowerCase()) links.set(`${linkRepo}#${number}`, { repo: linkRepo, number: Number(number) });
    }
  }
  return [...links.values()];
}
