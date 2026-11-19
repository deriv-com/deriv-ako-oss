// Reads and writes the `.env` file that holds AKO's secrets.
//
// The writer edits keys in place and keeps every other line, so a team's own
// comments and extra variables survive running the setup wizard again.

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/;

/** Parses `.env` text into a plain object. Later keys win. */
export function parseEnv(text) {
  const values = {};
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.match(LINE);
    if (!match) continue;
    values[match[1]] = unquote(match[2] ?? "");
  }
  return values;
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, (_, char) => (char === "n" ? "\n" : char));
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  // An unquoted value ends at an inline comment.
  return trimmed.replace(/\s+#.*$/, "");
}

function quote(value) {
  const text = String(value);
  if (text === "") return "";
  if (/^[A-Za-z0-9_./:@+,=-]+$/.test(text)) return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

/** Reads `.env` if it exists. Returns `{}` when it does not. */
export function readEnvFile(path) {
  if (!existsSync(path)) return {};
  return parseEnv(readFileSync(path, "utf8"));
}

/**
 * Loads `.env` into `process.env` without overriding variables already set,
 * so a value from the shell or from Docker always wins over the file.
 */
export function loadEnv(path, env = process.env) {
  const values = readEnvFile(path);
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) env[key] = value;
  }
  return values;
}

/**
 * Returns new `.env` text with `updates` applied. Existing keys are replaced
 * where they stand; new keys are appended under `section` when given.
 * A value of `null` removes the key.
 */
export function updateEnvText(text, updates, { section } = {}) {
  const lines = text === "" ? [] : text.replace(/\n$/, "").split(/\r?\n/);
  const pending = new Map(Object.entries(updates));
  const out = [];

  for (const line of lines) {
    const match = line.match(LINE);
    if (match && pending.has(match[1])) {
      const value = pending.get(match[1]);
      pending.delete(match[1]);
      if (value !== null && value !== undefined) out.push(`${match[1]}=${quote(value)}`);
      continue;
    }
    out.push(line);
  }

  const additions = [...pending]
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${quote(value)}`);
  if (additions.length === 0) return `${out.join("\n")}\n`;

  // A section that already exists gets the new keys at its end, not a second heading.
  const heading = section ? out.indexOf(`# ${section}`) : -1;
  if (heading >= 0) {
    let end = heading + 1;
    while (end < out.length && out[end].trim() !== "") end += 1;
    out.splice(end, 0, ...additions);
  } else {
    if (out.length && out[out.length - 1].trim() !== "") out.push("");
    if (section) out.push(`# ${section}`);
    out.push(...additions);
  }
  return `${out.join("\n")}\n`;
}

/** Applies `updates` to the `.env` file and keeps it readable only by its owner. */
export function updateEnvFile(path, updates, options) {
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, updateEnvText(current, updates, options), { mode: 0o600 });
  chmodSync(path, 0o600);
}
