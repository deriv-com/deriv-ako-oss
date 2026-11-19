// Plain GitHub issues, with no board. Each status is a label, and the special
// status `closed` means "close the issue" rather than "add a label".

export const CLOSED = "closed";

/** The repo's label names. */
export async function listLabels(github, repo) {
  const labels = await github.paginate(`/repos/${repo}/labels`);
  return labels.map((label) => label.name);
}

export async function getIssueStatuses(github, { repo }) {
  return { title: `${repo} issues`, url: `https://github.com/${repo}/issues`, statuses: [...(await listLabels(github, repo)), CLOSED] };
}

// --- The release engine's adapter helpers ---

/** The status an issue is in: its first configured status label, or `closed`. */
export function issueStatus(issue, statuses) {
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  const configured = [...statuses.ready, statuses.staged, statuses.ready_for_release, statuses.done, ...statuses.catch_up].filter(Boolean);
  return configured.find((s) => s !== CLOSED && labels.includes(s)) ?? (issue.state === "closed" ? CLOSED : null);
}

/** Moves an issue to `status`: swaps its status label, or closes it for `closed`. */
export async function setIssueStatus(github, repo, issue, status, statuses) {
  if (status === CLOSED) {
    await github.request("PATCH", `/repos/${repo}/issues/${issue.number}`, { state: "closed" });
    return;
  }
  const others = [...statuses.ready, statuses.staged, statuses.ready_for_release, statuses.done, ...statuses.catch_up]
    .filter((s) => s && s !== CLOSED && s !== status);
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  for (const label of others.filter((s) => labels.includes(s))) {
    await github.request("DELETE", `/repos/${repo}/issues/${issue.number}/labels/${encodeURIComponent(label)}`);
  }
  await github.request("POST", `/repos/${repo}/issues/${issue.number}/labels`, { labels: [status] });
}
