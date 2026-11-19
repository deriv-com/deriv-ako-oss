// A small GitHub REST and GraphQL client.
//
// `token` may be a string or an async function that returns one, so a GitHub
// App installation token can refresh itself between requests. A request that
// hits a rate limit is retried after the wait GitHub asks for (net/rateLimit.js).

import { fetchWithRateLimit } from "../net/rateLimit.js";

export const DEFAULT_API_URL = "https://api.github.com";

export class GitHubError extends Error {
  constructor(message, { status, data } = {}) {
    super(message);
    this.name = "GitHubError";
    this.status = status;
    this.data = data;
  }
}

export function createGitHubClient({ token, apiUrl = DEFAULT_API_URL, fetch = globalThis.fetch, userAgent = "deriv-ako", sleep } = {}) {
  async function headers(extra = {}) {
    const value = typeof token === "function" ? await token() : token;
    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": userAgent,
      ...(value ? { Authorization: `Bearer ${value}` } : {}),
      ...extra,
    };
  }

  async function request(method, path, body) {
    const url = path.startsWith("http") ? path : `${apiUrl}${path}`;
    const init = {
      method,
      headers: await headers(body === undefined ? {} : { "Content-Type": "application/json" }),
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    const response = await fetchWithRateLimit(fetch, url, init, { sleep });
    const data = await readBody(response);
    if (!response.ok) {
      const reason = data?.message ? `: ${data.message}` : "";
      throw new GitHubError(`GitHub ${method} ${path} failed with ${response.status}${reason}`, {
        status: response.status,
        data,
      });
    }
    if (data?.nonJsonBody) {
      throw new GitHubError(`GitHub ${method} ${path} returned a page that is not an API response`, {
        status: response.status,
        data,
      });
    }
    return data;
  }

  async function graphql(query, variables = {}) {
    const data = await request("POST", graphqlPath(apiUrl), { query, variables });
    if (data?.errors?.length) {
      throw new GitHubError(`GitHub GraphQL: ${data.errors.map((e) => e.message).join("; ")}`, { data });
    }
    return data.data;
  }

  /** Follows `page=` until a short page, up to `maxPages`. */
  async function paginate(path, { key, perPage = 100, maxPages = 10 } = {}) {
    const items = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const sep = path.includes("?") ? "&" : "?";
      const data = await request("GET", `${path}${sep}per_page=${perPage}&page=${page}`);
      const list = key ? data[key] : data;
      items.push(...list);
      if (list.length < perPage) break;
    }
    return items;
  }

  return { request, graphql, paginate };
}

// GitHub Enterprise Server serves REST at /api/v3 and GraphQL at /api/graphql.
function graphqlPath(apiUrl) {
  return apiUrl.endsWith("/api/v3") ? `${apiUrl.slice(0, -3)}/graphql` : `${apiUrl}/graphql`;
}

// Gateway errors and proxy pages come back as HTML, so the status decides
// what happened and a non-JSON body is never parsed as data.
async function readBody(response) {
  const text = await response.text();
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    return { nonJsonBody: true, message: `not JSON (HTTP ${response.status})` };
  }
}
