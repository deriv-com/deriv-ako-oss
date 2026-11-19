// Turns what someone typed ("create release for web", "approve
// production_v20261102_0") into `{ action, project, tag }`.
//
// Plain wording is read by the rules below, with no AI. Only when they can't
// tell, and an AI key is set, the request goes to the model, with the list of
// project names and nothing else: never issue or PR text, which outsiders can
// write. Whatever the model answers is checked here against the fixed list of
// actions and the projects in the flow file, and anything else is dropped. The
// model only picks an action; every rule about who may approve or what gets
// merged is enforced by the engine.

export const ACTIONS = ["help", "ready", "create", "status", "announce", "request", "approve", "hold", "watch", "archive"];

const TAG = /\b[A-Za-z0-9][A-Za-z0-9._/-]*\d{8}_\d+\b/;

const RULES = [
  // Only an instruction counts as approving: it starts the message and isn't a
  // question. "Don't approve yet", "who can approve this?" and "ask them to
  // approve" are not approvals.
  ["approve", /^(?!.*\?)\s*(?:(?:yes|ok|okay|please),?\s+)?(?:approve|approved|lgtm|ship it|go ahead and publish)\b/],
  ["hold", /^\s*(hold|reject|don'?t release|do not release)\b|\bput .* on hold\b/],
  ["announce", /\btell qa\b|\b(start|begin) (the )?regression\b|\bregression can start\b|\bannounce (the )?regression\b/],
  ["request", /\b(request|ask for)\b.*\bapproval\b|\bto approve\b|\bready (to|for) (release|publish)\b|\bregression (is )?(done|passed|complete)\b|\bpublish\b/],
  ["create", /\b(create|start|open|new|cut|begin)\b.*\brelease\b|\bpick (it|this|them) up\b/],
  ["archive", /\barchive\b/],
  ["watch", /\b(watch|deploy(ment)?|did it deploy)\b/],
  ["status", /\bstatus\b|\bongoing\b|\bin regression\b|\bwhere (is|are)\b|\bwhat'?s happening\b/],
  ["ready", /\bready\b|\bwhat can (we|i) release\b|\bwhat'?s (left|pending)\b/],
  ["help", /\bhelp\b|\bwhat can you do\b|\bcommands\b/],
];

/** The project a request names, by key, alias or display name; the longest match wins. */
export function projectIn(text, projects) {
  const lower = text.toLowerCase();
  const names = projects.flatMap((p) => [p.key, p.name, ...p.aliases].map((name) => ({ name: name.toLowerCase(), key: p.key })));
  const found = names
    .filter(({ name }) => new RegExp(`(^|[^a-z0-9-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9-])`).test(lower))
    .sort((a, b) => b.name.length - a.name.length);
  return found[0]?.key ?? null;
}

/** Reads a request with rules alone. Returns null when the action isn't clear. */
export function parseRequest(text, projects) {
  const lower = String(text).toLowerCase().trim();
  const rule = RULES.find(([, pattern]) => pattern.test(lower));
  if (!rule) return null;
  const tag = text.match(TAG)?.[0] ?? null;
  // A tag can start with a project's name (api_v…); the tag's prefix finds its project later.
  return { action: rule[0], project: projectIn(tag ? text.replace(tag, " ") : text, projects), tag };
}

/** Keeps only what the engine can act on. */
export function validateIntent(raw, projects) {
  if (!raw || typeof raw !== "object" || !ACTIONS.includes(raw.action)) return null;
  const project = projects.some((p) => p.key === raw.project) ? raw.project : null;
  const tag = typeof raw.tag === "string" && TAG.test(raw.tag) ? raw.tag.match(TAG)[0] : null;
  return { action: raw.action, project, tag };
}

/** Asks the AI provider to pick an action. Returns null on any failure. */
export async function aiRequest(text, projects, settings, { fetch = globalThis.fetch } = {}) {
  const projectList = projects.map((p) => `- ${p.key}: ${p.name}${p.aliases.length ? ` (also: ${p.aliases.join(", ")})` : ""}`).join("\n");
  const system = [
    "You route requests to a release bot. Reply with one JSON object and nothing else:",
    '{"action": ..., "project": ..., "tag": ...}',
    `action is one of: ${ACTIONS.join(", ")}.`,
    "help: what the bot can do. ready: list work ready to release. create: start a release. status: where releases stand.",
    "announce: tell QA regression can start.",
    "request: ask release managers to approve (regression is done). approve / hold: a release manager's answer.",
    "watch: follow the deploy. archive: close a shipped release.",
    "project is one of these keys, or null:",
    projectList,
    "tag is a release tag in the request, such as production_v20261102_0, or null.",
  ].join("\n");
  try {
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 100,
        messages: [
          { role: "system", content: system },
          { role: "user", content: String(text).slice(0, 500) },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content ?? "";
    const json = content.match(/\{[\s\S]*\}/)?.[0];
    return json ? validateIntent(JSON.parse(json), projects) : null;
  } catch {
    return null;
  }
}

/** What someone asked for: rules first, then the AI when set, else help. */
export async function understand(text, projects, { ai = null, fetch } = {}) {
  const plain = parseRequest(text, projects);
  if (plain) return { ...plain, by: "rules" };
  if (ai) {
    const guessed = await aiRequest(text, projects, ai, { fetch });
    if (guessed) return { ...guessed, by: "ai" };
  }
  return { action: "help", project: null, tag: null, by: "fallback" };
}
