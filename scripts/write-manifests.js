// Regenerates the files in manifests/ from the code that builds them, so the
// setup wizard and the files people paste by hand never drift apart.
// Run with `node scripts/write-manifests.js`; a test fails if they differ.

import { writeFileSync } from "node:fs";
import { stringify } from "yaml";
import { buildGitHubAppManifest } from "../src/github/manifest.js";
import { buildSlackManifest } from "../src/chat/slack.js";

export function manifestFiles() {
  return {
    "manifests/github-app.json": `${JSON.stringify(buildGitHubAppManifest(), null, 2)}\n`,
    "manifests/slack-app.yaml": stringify(buildSlackManifest()),
    "manifests/slack-agent.yaml": stringify(buildSlackManifest({ agent: true })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [path, text] of Object.entries(manifestFiles())) {
    writeFileSync(new URL(`../${path}`, import.meta.url), text);
    process.stdout.write(`wrote ${path}\n`);
  }
}
