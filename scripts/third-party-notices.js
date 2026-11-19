// Regenerates THIRD_PARTY_NOTICES.md from the installed production
// dependencies and their own license files, so the notices always match
// package-lock.json. Run with `node scripts/third-party-notices.js` after
// adding or updating a dependency; a test fails if the file is stale.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);

export function noticesText() {
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
  const packages = Object.entries(lock.packages)
    .filter(([path, info]) => path.startsWith("node_modules/") && !info.dev)
    .map(([path]) => path.slice("node_modules/".length))
    .sort();

  const sections = packages.map((name) => {
    const dir = new URL(`node_modules/${name}/`, root);
    const pkg = JSON.parse(readFileSync(new URL("package.json", dir), "utf8"));
    const licenseFile = readdirSync(dir).find((f) => /^licen[cs]e(\.md|\.txt)?$/i.test(f));
    const text = licenseFile ? readFileSync(new URL(licenseFile, dir), "utf8").trim() : `${pkg.license} (no license file in the package)`;
    const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    return [
      `## ${name} ${pkg.version}`,
      "",
      `- License: ${pkg.license}`,
      ...(repo ? [`- Source: ${repo.replace(/^git\+/, "").replace(/\.git$/, "")}`] : []),
      "",
      "```",
      text,
      "```",
    ].join("\n");
  });

  return `# Third-party notices\n\nDeriv AKO includes the following open-source software.\n\n${sections.join("\n\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!existsSync(new URL("node_modules/", root))) throw new Error("Run npm install first.");
  writeFileSync(new URL("THIRD_PARTY_NOTICES.md", root), noticesText());
  process.stdout.write("wrote THIRD_PARTY_NOTICES.md\n");
}
