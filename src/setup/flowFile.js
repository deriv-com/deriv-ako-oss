// Writes `release-flow.yaml` through the yaml Document API, so running setup
// again keeps the comments and projects a team added by hand.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Document, parseDocument } from "yaml";
import { FLOW_VERSION } from "../config/flow.js";

const HEADER = [
  " Deriv AKO release flow.",
  " One entry per project: where its work lives (tracker), what gets tagged",
  " (release), how the deploy reports back (deploy), the steps it runs and who",
  " approves. Secrets live in .env, never here.",
  " Reference: docs/flow-file.md",
].join("\n");

export function newFlowDocument() {
  const doc = new Document({ version: FLOW_VERSION, projects: [] });
  doc.commentBefore = HEADER;
  return doc;
}

/** The existing flow file as a Document, or null when there is none. */
export function readFlowDocument(path) {
  if (!existsSync(path)) return null;
  const doc = parseDocument(readFileSync(path, "utf8"));
  if (doc.errors.length) throw new Error(`${path}: ${doc.errors[0].message.split("\n")[0]}`);
  // Resolve it once here, so a file with too many aliases fails with its path
  // instead of later, inside whichever step first reads it.
  try {
    doc.toJS();
  } catch (error) {
    throw new Error(`${path}: ${error.message}`);
  }
  return doc;
}

export function projectKeys(doc) {
  return (doc.toJS()?.projects ?? []).map((p) => p?.key).filter(Boolean);
}

export function addProject(doc, project) {
  if (!doc.has("projects")) doc.set("projects", doc.createNode([]));
  doc.get("projects").add(doc.createNode(compact(project)));
}

/** Sets values under a project, by key, creating sections as needed. */
export function setProjectValues(doc, key, values) {
  const index = projectKeys(doc).indexOf(key);
  if (index < 0) throw new Error(`No project "${key}" in the flow file.`);
  for (const [path, value] of values) {
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) continue;
    doc.setIn(["projects", index, ...path], doc.createNode(value));
  }
}

/** Writes the file and returns what it wrote. */
export function writeFlowDocument(path, doc) {
  const text = doc.toString({ lineWidth: 100 });
  writeFileSync(path, text);
  return text;
}

/** Drops empty values so the written file only holds what was chosen. */
export function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    const cleaned = compact(inner);
    const empty =
      cleaned === undefined ||
      cleaned === null ||
      cleaned === "" ||
      (Array.isArray(cleaned) && cleaned.length === 0) ||
      (typeof cleaned === "object" && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0);
    if (!empty) out[key] = cleaned;
  }
  return out;
}
