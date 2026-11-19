// The GitHub calls the release engine makes. Each takes a client from
// github/client.js (an installation token for the app, or a person's own token
// in the terminal) and a repo as `owner/name`.

import { GitHubError } from "../github/client.js";

const encodeRef = (ref) => encodeURIComponent(ref).replace(/%2F/g, "/");

export async function getRepo(gh, repo) {
  return gh.request("GET", `/repos/${repo}`);
}

/** The commit a branch points at now. */
export async function branchHead(gh, repo, branch) {
  const data = await gh.request("GET", `/repos/${repo}/branches/${encodeRef(branch)}`);
  return data.commit.sha;
}

export async function listTags(gh, repo) {
  return (await gh.paginate(`/repos/${repo}/tags`, { maxPages: 5 })).map((t) => t.name);
}

export async function listMilestones(gh, repo, state = "all") {
  return gh.paginate(`/repos/${repo}/milestones?state=${state}`, { maxPages: 5 });
}

export async function createMilestone(gh, repo, { title, description }) {
  return gh.request("POST", `/repos/${repo}/milestones`, { title, description });
}

export async function closeMilestone(gh, repo, number) {
  return gh.request("PATCH", `/repos/${repo}/milestones/${number}`, { state: "closed" });
}

export async function setIssueMilestone(gh, repo, issue, milestone) {
  return gh.request("PATCH", `/repos/${repo}/issues/${issue}`, { milestone });
}

/** A milestone's issues, open and closed, without pull requests. */
export async function listMilestoneIssues(gh, repo, milestone) {
  const issues = await gh.paginate(`/repos/${repo}/issues?milestone=${milestone}&state=all`, { maxPages: 5 });
  return issues.filter((i) => !i.pull_request);
}

const ISSUE_PRS = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 25, includeClosedPrs: true) {
        nodes { number url state merged isDraft baseRefName repository { nameWithOwner } }
      }
    }
  }
}`;

/** The pull requests in an issue's Development section. */
export async function issuePullRequests(gh, repo, number) {
  const [owner, name] = repo.split("/");
  const data = await gh.graphql(ISSUE_PRS, { owner, name, number: Number(number) });
  return (data.repository?.issue?.closedByPullRequestsReferences?.nodes ?? []).map((pr) => ({
    number: pr.number,
    url: pr.url,
    repo: pr.repository.nameWithOwner,
    state: pr.merged ? "merged" : pr.state.toLowerCase(),
    draft: pr.isDraft,
    base: pr.baseRefName,
  }));
}

export async function getPull(gh, repo, number) {
  const pr = await gh.request("GET", `/repos/${repo}/pulls/${number}`);
  return {
    number: pr.number,
    url: pr.html_url,
    repo,
    state: pr.merged ? "merged" : pr.state,
    draft: pr.draft,
    base: pr.base.ref,
  };
}

/** Merges a PR. Returns `{ merged: true, sha }` or `{ merged: false, reason }`; never throws for GitHub's refusals. */
export async function mergePull(gh, repo, number, method) {
  try {
    const result = await gh.request("PUT", `/repos/${repo}/pulls/${number}/merge`, { merge_method: method });
    return { merged: true, sha: result.sha };
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    // GitHub's reason ("At least 1 approving review is required") is on data.message.
    return { merged: false, reason: error.data?.message ?? error.message };
  }
}

export async function compare(gh, repo, base, head) {
  return gh.request("GET", `/repos/${repo}/compare/${encodeRef(base)}...${encodeRef(head)}`);
}

export async function createBranch(gh, repo, branch, sha) {
  return gh.request("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
}

export async function deleteBranch(gh, repo, branch) {
  try {
    await gh.request("DELETE", `/repos/${repo}/git/refs/heads/${encodeRef(branch)}`);
  } catch (error) {
    if (error.status !== 404 && error.status !== 422) throw error;
  }
}

export async function createPull(gh, repo, { title, head, base, body }) {
  return gh.request("POST", `/repos/${repo}/pulls`, { title, head, base, body });
}

export async function getReleaseByTag(gh, repo, tag) {
  try {
    return await gh.request("GET", `/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

/** Creates the tag and its GitHub Release, with notes since `previousTag`. */
export async function createRelease(gh, repo, { tag, sha, previousTag }) {
  let body;
  try {
    const notes = await gh.request("POST", `/repos/${repo}/releases/generate-notes`, {
      tag_name: tag,
      target_commitish: sha,
      ...(previousTag ? { previous_tag_name: previousTag } : {}),
    });
    body = notes.body;
  } catch {
    body = undefined; // Notes are a nicety; the release still goes out without them.
  }
  return gh.request("POST", `/repos/${repo}/releases`, {
    tag_name: tag,
    target_commitish: sha,
    name: tag,
    ...(body ? { body } : { generate_release_notes: true }),
  });
}

// --- Issues and comments (the release's tracking issue) ---

export async function createIssue(gh, repo, { title, body, labels }) {
  return gh.request("POST", `/repos/${repo}/issues`, { title, body, labels });
}

export async function updateIssue(gh, repo, number, fields) {
  return gh.request("PATCH", `/repos/${repo}/issues/${number}`, fields);
}

export async function listIssuesWithLabel(gh, repo, label, state = "all") {
  const issues = await gh.paginate(`/repos/${repo}/issues?labels=${encodeURIComponent(label)}&state=${state}`, { maxPages: 5 });
  return issues.filter((i) => !i.pull_request);
}

export async function ensureLabel(gh, repo, name, { color = "5319e7", description } = {}) {
  try {
    await gh.request("GET", `/repos/${repo}/labels/${encodeURIComponent(name)}`);
  } catch (error) {
    if (error.status !== 404) throw error;
    await gh.request("POST", `/repos/${repo}/labels`, { name, color, description });
  }
}

export async function comment(gh, repo, issue, body) {
  return gh.request("POST", `/repos/${repo}/issues/${issue}/comments`, { body });
}

export async function listComments(gh, repo, issue) {
  return gh.paginate(`/repos/${repo}/issues/${issue}/comments`, { maxPages: 5 });
}

export async function deleteComment(gh, repo, id) {
  try {
    await gh.request("DELETE", `/repos/${repo}/issues/comments/${id}`);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

// --- Deploy reporting ---

/** Runs of a workflow started by pushing `tag`, newest first. */
export async function workflowRunsForTag(gh, repo, workflow, tag) {
  const data = await gh.request(
    "GET",
    `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(tag)}&event=push&per_page=5`,
  );
  return data.workflow_runs ?? [];
}

export async function commitStatuses(gh, repo, ref) {
  return gh.request("GET", `/repos/${repo}/commits/${encodeRef(ref)}/statuses?per_page=100`);
}

export async function checkRuns(gh, repo, ref) {
  const data = await gh.request("GET", `/repos/${repo}/commits/${encodeRef(ref)}/check-runs?per_page=100`);
  return data.check_runs ?? [];
}

// --- People ---

/** Whether `login` is an active member of `org/team`. Needs the app's Members: read. */
export async function isTeamMember(gh, team, login) {
  const [org, slug] = team.split("/");
  try {
    const data = await gh.request("GET", `/orgs/${org}/teams/${slug}/memberships/${login}`);
    return data.state === "active";
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}
