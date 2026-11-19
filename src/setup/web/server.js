// The browser setup: `ako setup --ui`.
//
// AKO serves the setup page from 127.0.0.1 for as long as the setup runs, then
// shuts it down, so nothing stays online holding tokens. The page asks the same
// questions as the terminal, through a prompter with the same methods, so every
// setup step and check is shared.
//
// Only the browser that opened the link can use it: every request needs the
// one-time token from the link, the Host header must be 127.0.0.1 and this port
// (which stops DNS rebinding: a name, even `localhost`, can be pointed
// elsewhere by whoever controls the resolver, an IP address can't), and answers
// are JSON with a custom header (which a page on another site can't send
// without a CORS preflight AKO never grants).

import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolveAnswer, GoBack } from "../prompts.js";
import { FLOW_FILE } from "../../config/flow.js";
import { setupPageHtml } from "./page.js";

const CLOSE_DELAY_MS = 1500;

/** What an answer becomes when the page's Back button is pressed. */
const BACK = Symbol("back");

export async function startSetupServer({ openUrl = () => {}, mirror = () => {}, title = "Deriv AKO setup" } = {}) {
  const token = randomBytes(24).toString("hex");
  const channel = createChannel(mirror);
  const server = createServer((req, res) => handle(req, res).catch(() => send(res, 500, "text/plain", "Error")));
  let port;

  async function handle(req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    // The server only listens on 127.0.0.1, and the link AKO opens uses it.
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 403, "text/plain", "Forbidden");

    if (req.method === "GET" && url.pathname === "/") {
      if (!tokenMatches(url.searchParams.get("token"))) return send(res, 403, "text/plain", "This setup link has expired or is wrong.");
      const nonce = randomBytes(16).toString("base64");
      return send(res, 200, "text/html; charset=utf-8", setupPageHtml({ nonce, title }), pageHeaders(nonce));
    }
    if (req.method === "GET" && url.pathname === "/events") {
      if (!tokenMatches(url.searchParams.get("token"))) return send(res, 403, "text/plain", "Forbidden");
      return channel.subscribe(res);
    }
    if (req.method === "POST" && url.pathname === "/answer") {
      if (!tokenMatches(req.headers["x-ako-token"])) return send(res, 403, "text/plain", "Forbidden");
      if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(res, 415, "text/plain", "JSON only");
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, "text/plain", "Bad JSON");
      }
      const accepted = channel.answer(body.id, body.back === true ? BACK : body.value);
      return send(res, accepted ? 204 : 409, "text/plain", accepted ? "" : "That question was already answered.");
    }
    return send(res, 404, "text/plain", "Not found");
  }

  function tokenMatches(candidate) {
    const given = Buffer.from(String(candidate ?? ""));
    const expected = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      port = server.address().port;
      resolve();
    });
  });
  const url = `http://127.0.0.1:${port}/?token=${token}`;

  return {
    url,
    prompter: createWebPrompter(channel),
    /** Opens a page for the person, and shows its link in the setup in case the tab is blocked. */
    openUrl(link) {
      channel.log({ kind: "link", text: link });
      openUrl(link);
    },
    finish() {
      channel.end({ type: "done" });
    },
    fail(error) {
      channel.end({ type: "error", message: error.message });
    },
    /** Lets the page receive the last event, then stops listening. */
    async close({ delayMs = CLOSE_DELAY_MS } = {}) {
      await new Promise((resolve) => setTimeout(resolve, delayMs).unref?.());
      channel.closeAll();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Holds what the page shows: the log so far, the question waiting for an
 * answer, and the final state. A page that reloads gets all of it again.
 */
function createChannel(mirror) {
  const clients = new Set();
  const history = [];
  let current = null;
  let pending = null;
  let final = null;
  let nextId = 1;

  const broadcast = (event) => {
    for (const res of clients) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  return {
    subscribe(res) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      for (const event of [...history, current, final].filter(Boolean)) res.write(`data: ${JSON.stringify(event)}\n\n`);
      clients.add(res);
      res.on("close", () => clients.delete(res));
    },
    log({ kind = "text", text }) {
      this.record({ type: "log", kind, text });
      mirror(kind === "heading" ? `\n== ${text} ==\n` : kind === "link" ? `  ${text}\n` : `${text}\n`);
    },
    /** Keeps an event for pages that connect later, in order with the log. */
    record(event) {
      history.push(event);
      broadcast(event);
    },
    ask(question) {
      const id = nextId++;
      current = { type: "question", id, ...question };
      broadcast(current);
      return new Promise((resolve) => {
        pending = { id, resolve };
      });
    },
    answer(id, value) {
      if (!pending || pending.id !== id) return false;
      const { resolve } = pending;
      pending = null;
      current = null;
      // Kept too, so a page that reloads knows which notes came after the last answer.
      const answered = { type: "answered", id };
      history.push(answered);
      broadcast(answered);
      resolve(value);
      return true;
    },
    end(event) {
      final = event;
      current = null;
      broadcast(event);
    },
    closeAll() {
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}

/**
 * A prompter with the terminal prompter's methods, asking through the page.
 * Answers come back as text, booleans or option indexes and are checked here,
 * never trusted from the page.
 */
export function createWebPrompter(channel) {
  // Every question offers Back when there is something to go back to.
  async function question(payload) {
    const raw = await channel.ask({ ...payload, canGoBack: self.canGoBack });
    if (raw === BACK) throw new GoBack();
    return raw;
  }

  async function ask(label, options = {}) {
    const { default: fallback, secret = false, optional = false } = options;
    let problem = null;
    let typed = null;
    for (;;) {
      const raw = await question({
        kind: secret ? "secret" : "text",
        label,
        // A secret's current value never goes to the page; it only learns one exists.
        // After a problem, the field keeps what was typed so it can be corrected.
        value: secret ? null : (typed ?? fallback ?? null),
        hasDefault: Boolean(fallback),
        optional,
        problem,
      });
      const text = typeof raw === "string" ? raw : "";
      const result = await resolveAnswer(text, options);
      if (!result.problem) return result.value;
      problem = result.problem;
      typed = text;
    }
  }

  async function confirm(label, fallback = true) {
    const raw = await question({ kind: "confirm", label, default: fallback });
    return typeof raw === "boolean" ? raw : fallback;
  }

  async function choose(label, options, { default: fallback } = {}) {
    const defaultIndex = options.findIndex((o) => o.value === fallback);
    let problem = null;
    for (;;) {
      const raw = await question({ kind: "choose", label, options: options.map((o) => o.label), default: defaultIndex, problem });
      if (Number.isInteger(raw) && options[raw]) return options[raw].value;
      problem = "Pick one of the options.";
    }
  }

  async function chooseMany(label, options, { defaults = [], min = 1 } = {}) {
    const defaultIndexes = options.map((o, i) => (defaults.includes(o.value) ? i : null)).filter((i) => i !== null);
    let problem = null;
    for (;;) {
      const raw = await question({ kind: "chooseMany", label, options: options.map((o) => o.label), default: defaultIndexes, min, problem });
      const picked = Array.isArray(raw) ? [...new Set(raw)] : [];
      if (picked.length >= min && picked.every((i) => Number.isInteger(i) && options[i])) {
        return picked.sort((a, b) => a - b).map((i) => options[i].value);
      }
      problem = `Pick at least ${min}.`;
    }
  }

  async function pause(label) {
    await question({ kind: "pause", label });
  }

  // The steps write whole or partial lines; the page shows one entry per line.
  function write(text) {
    for (const line of String(text).split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const heading = trimmed.match(/^== (.+) ==$/);
      if (heading) channel.log({ kind: "heading", text: heading[1] });
      else channel.log({ kind: /^✗/.test(trimmed) ? "error" : /^!/.test(trimmed) ? "warn" : "text", text: trimmed });
    }
  }

  const self = {
    ask,
    confirm,
    choose,
    chooseMany,
    pause,
    write,
    // Set by steps.js before each question.
    canGoBack: false,
    // Called by steps.js as the setup moves between its parts.
    progress: ({ steps, at }) => channel.record({ type: "progress", steps, at }),
    // Called by the setup each time it saves the flow file, which holds no
    // secrets. Nothing else is shown, so .env never reaches the page.
    file: (name, text) => {
      if (name === FLOW_FILE) channel.record({ type: "file", name, text: String(text) });
    },
    intro: () => {}, // the page has its own title
    note: (lines, title) => write([`${title}:`, ...lines.map((line) => `- ${line}`)].join("\n")),
    outro: write,
    close: () => {},
  };
  return self;
}

function pageHeaders(nonce) {
  return {
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function send(res, status, type, body, headers = {}) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
