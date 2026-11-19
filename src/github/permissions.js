// Which GitHub App permissions AKO asks for, and why. The base set covers
// every flow; the rest are added only when a project's flow file uses them.

export const BASE_PERMISSIONS = {
  metadata: "read", // required by GitHub for every app
  contents: "write", // merge PRs, create tags and releases
  pull_requests: "write", // merge PRs, open promotion PRs
  issues: "write", // create milestones, assign issues, comment on the release issue
  actions: "read", // find the deploy run a tag starts
};

const LEVEL = { read: 1, write: 2, admin: 3 };

/** The full permission set for a list of normalized projects. */
export function permissionsFor(projects = []) {
  const permissions = { ...BASE_PERMISSIONS };
  for (const project of projects) {
    if (project.tracker?.type === "github-projects") permissions.organization_projects = "write";
    if (project.deploy?.type === "commit-status") permissions.statuses = "read";
    if (project.deploy?.type === "check-run") permissions.checks = "read";
    const github = [
      ...(project.people?.release_managers?.github ?? []),
      ...(project.people?.qa?.github ?? []),
    ];
    // Release managers listed as org/team need team membership reads.
    if (github.some((entry) => entry.includes("/"))) permissions.members = "read";
  }
  return permissions;
}

/** Lists `needed` permissions that `granted` lacks or grants at a lower level. */
export function missingPermissions(granted = {}, needed = {}) {
  return Object.entries(needed)
    .filter(([name, level]) => (LEVEL[granted[name]] ?? 0) < LEVEL[level])
    .map(([name, level]) => ({ name, level, granted: granted[name] ?? "none" }));
}
