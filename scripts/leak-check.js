// Fails when a file in the repo holds something that must never be public:
// secrets, real Slack IDs, internal links or work emails.
//
// The built-in rules are generic. Organization-specific terms (internal
// domains, repo names, people's names) can't be listed here without leaking
// them, so they come from outside the repo: the LEAK_DENYLIST environment
// variable (one regular expression per line, for example as a CI secret) or a file
// passed with --denylist <path>.
//
// Usage: node scripts/leak-check.js [--denylist <file>] [paths...]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

// Made-up IDs for examples and tests: a letter, then zeros, then a few digits.
const PLACEHOLDER_SLACK_ID = /^[A-Z]0{5,}\d{1,4}$/;

const ALLOWED_EMAILS = [/^security@deriv\.com$/i, /@users\.noreply\.github\.com$/i, /@example\.(com|org|net)$/i];

export const RULES = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "GitHub token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}|\bxapp-\d-[A-Za-z0-9-]{10,}/ },
  { name: "AI API key", pattern: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/ },
  { name: "ClickUp token", pattern: /\bpk_\d+_[A-Z0-9]{20,}/ },
  { name: "Slack archive link", pattern: /[a-z0-9-]+\.slack\.com\/archives\//i },
  {
    name: "Slack ID",
    pattern: /\b[UWCGS]0[A-Z0-9]{7,10}\b/g,
    allow: (match) => PLACEHOLDER_SLACK_ID.test(match),
  },
  {
    name: "email address",
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    allow: (match) => ALLOWED_EMAILS.some((re) => re.test(match)),
  },
];

// Files that may legitimately hold rule text or binary data.
const SKIP = [/^package-lock\.json$/, /^scripts\/leak-check\.js$/, /^tests\/scripts\/leakCheck\.test\.js$/, /\.(png|jpe?g|gif|ico|pdf)$/i];

// Rules a file is exempt from: license notices quote their authors' emails.
const EXEMPT = { "THIRD_PARTY_NOTICES.md": ["email address"] };

export function loadDenylist({ env = process.env, file } = {}) {
  const lines = [];
  if (env.LEAK_DENYLIST) lines.push(...env.LEAK_DENYLIST.split(/\r?\n/));
  if (file) lines.push(...readFileSync(file, "utf8").split(/\r?\n/));
  return lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((source) => ({ name: "denylist", pattern: new RegExp(source, "gi"), hidden: true }));
}

/** Findings for one file's text: `{ line, rule, match }`. */
export function scanText(text, rules) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const rule of rules) {
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`);
      for (const match of line.matchAll(pattern)) {
        if (rule.allow?.(match[0])) continue;
        findings.push({ line: index + 1, rule: rule.name, match: rule.hidden ? null : mask(match[0]) });
      }
    }
  });
  return findings;
}

function mask(value) {
  return value.length <= 8 ? value : `${value.slice(0, 4)}…${value.slice(-2)}`;
}

/** Tracked files plus new files git doesn't ignore. */
export function repoFiles(cwd = process.cwd()) {
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd, encoding: "utf8" });
  return out.split("\0").filter(Boolean);
}

export function scanFiles(files, rules, { cwd = process.cwd() } = {}) {
  const findings = [];
  for (const file of files) {
    if (SKIP.some((re) => re.test(file))) continue;
    const path = `${cwd}/${file}`;
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const fileRules = rules.filter((rule) => !(EXEMPT[file] ?? []).includes(rule.name));
    for (const finding of scanText(readFileSync(path, "utf8"), fileRules)) findings.push({ file, ...finding });
  }
  return findings;
}

function main(args) {
  const at = args.indexOf("--denylist");
  const file = at >= 0 ? args[at + 1] : undefined;
  const paths = args.filter((a, i) => a !== "--denylist" && i !== at + 1);
  const denylist = loadDenylist({ file });
  const rules = [...RULES, ...denylist];
  const files = paths.length ? paths : repoFiles();
  const findings = scanFiles(files, rules);

  for (const f of findings) {
    process.stdout.write(`${f.file}:${f.line}: ${f.rule}${f.match ? ` (${f.match})` : ""}\n`);
  }
  const extra = denylist.length ? ` and ${denylist.length} denylist pattern(s)` : " (no denylist set: LEAK_DENYLIST or --denylist)";
  process.stdout.write(
    findings.length
      ? `\n${findings.length} possible leak(s) in ${files.length} files. Remove them, or use made-up values.\n`
      : `No leaks found in ${files.length} files, checked with ${RULES.length} built-in rules${extra}.\n`,
  );
  return findings.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
