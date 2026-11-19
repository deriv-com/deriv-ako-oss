// An in-memory GitHub for engine tests: one repo with branches, issues,
// labels, milestones, PRs, comments, tags, releases and workflow runs, behind
// the same `request` / `graphql` / `paginate` client the engine uses.

import { GitHubError } from "../../src/github/client.js";

let shaCounter = 0;
export const newSha = () => (shaCounter += 1).toString(16).padStart(40, "a");

export function fakeGitHub({ repo = "acme/web-app", defaultBranch = "main", login = "ako-bot" } = {}) {
  const head0 = newSha();
  const world = {
    repo,
    defaultBranch,
    branches: { [defaultBranch]: [head0] }, // commit history, oldest first
    issues: [],
    labels: new Set(),
    milestones: [],
    pulls: [],
    comments: [],
    tags: [],
    releases: [],
    runs: [], // { workflow, tag, status, conclusion, html_url }
    statuses: [], // { ref, context, state, target_url }
    checkRuns: [], // { ref, name, status, conclusion, details_url }
    board: null, // { projectId, field: { id, options: [{ id, name }] }, items: [{ id, issue, status }] }
    teams: {}, // "org/team" -> [logins]
    calls: [],
  };
  let nextNumber = 1;
  let nextComment = 1;
  const now = () => new Date().toISOString();
  const head = (branch) => world.branches[branch].at(-1);
  const notFound = (path) => new GitHubError(`GitHub GET ${path} failed with 404: Not Found`, { status: 404, data: { message: "Not Found" } });
  const issueJson = (i) => ({
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    state: i.state,
    labels: [...i.labels].map((name) => ({ name })),
    milestone: i.milestone ? { number: i.milestone } : null,
    html_url: `https://github.com/${repo}/issues/${i.number}`,
  });

  function addIssue({ title, labels = [], state = "open", prs = [] }) {
    const issue = { number: nextNumber++, title, labels: new Set(labels), state, milestone: null, prs, body: "" };
    world.issues.push(issue);
    labels.forEach((l) => world.labels.add(l));
    return issue;
  }

  function addPull({ issue, base = defaultBranch, state = "open", draft = false }) {
    const pr = { number: nextNumber++, base, state, draft, merged: state === "merged" };
    world.pulls.push(pr);
    issue?.prs.push(pr.number);
    return pr;
  }

  /** A commit landing on a branch outside AKO. */
  function commit(branch = defaultBranch) {
    world.branches[branch].push(newSha());
    return head(branch);
  }

  const routes = [
    ["GET", /^\/repos\/[^/]+\/[^/]+$/, () => ({ default_branch: defaultBranch, full_name: repo })],
    ["GET", /\/branches\/(.+)$/, ([, b]) => {
      const branch = decodeURIComponent(b);
      if (!world.branches[branch]) throw notFound(b);
      return { name: branch, commit: { sha: head(branch) } };
    }],
    ["GET", /\/tags(\?|$)/, () => world.tags.map((name) => ({ name }))],
    ["GET", /\/milestones\?state=/, () => world.milestones.map((m) => ({ ...m }))],
    ["POST", /\/milestones$/, (_, body) => {
      const m = { number: world.milestones.length + 1, title: body.title, state: "open", html_url: `https://github.com/${repo}/milestone/${world.milestones.length + 1}` };
      world.milestones.push(m);
      return m;
    }],
    ["PATCH", /\/milestones\/(\d+)$/, ([, n], body) => Object.assign(world.milestones.find((m) => m.number === Number(n)), body)],
    ["GET", /\/issues\/(\d+)\/comments/, ([, n]) => world.comments.filter((c) => c.issue === Number(n)).map((c) => ({ ...c }))],
    ["POST", /\/issues\/(\d+)\/comments$/, ([, n], body) => {
      // Posted as `login`. GitHub reports an app's own comments with no repo access.
      const c = {
        id: nextComment++,
        issue: Number(n),
        body: body.body,
        user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
        author_association: login.endsWith("[bot]") ? "NONE" : "COLLABORATOR",
        created_at: new Date(Date.now() + nextComment).toISOString(),
      };
      world.comments.push(c);
      return { ...c };
    }],
    ["DELETE", /\/issues\/comments\/(\d+)$/, ([, id]) => {
      world.comments = world.comments.filter((c) => c.id !== Number(id));
      return {};
    }],
    ["POST", /\/issues\/(\d+)\/labels$/, ([, n], body) => {
      const issue = world.issues.find((i) => i.number === Number(n));
      body.labels.forEach((l) => issue.labels.add(l));
      return [];
    }],
    ["DELETE", /\/issues\/(\d+)\/labels\/(.+)$/, ([, n, l]) => {
      world.issues.find((i) => i.number === Number(n)).labels.delete(decodeURIComponent(l));
      return [];
    }],
    ["GET", /\/issues\/(\d+)$/, ([, n]) => issueJson(world.issues.find((i) => i.number === Number(n)))],
    ["PATCH", /\/issues\/(\d+)$/, ([, n], body) => {
      const issue = world.issues.find((i) => i.number === Number(n));
      if ("milestone" in body) issue.milestone = body.milestone;
      if (body.state) issue.state = body.state;
      if ("body" in body) issue.body = body.body;
      return issueJson(issue);
    }],
    ["GET", /\/issues\?(.*)$/, ([, query]) => {
      const q = new URLSearchParams(query);
      return world.issues
        .filter((i) => !q.get("labels") || i.labels.has(q.get("labels")))
        .filter((i) => q.get("state") === "all" || !q.get("state") || i.state === q.get("state"))
        .filter((i) => (q.get("milestone") === "none" ? !i.milestone : q.get("milestone") ? i.milestone === Number(q.get("milestone")) : true))
        .map(issueJson);
    }],
    ["POST", /\/issues$/, (_, body) => {
      const issue = addIssue({ title: body.title, labels: body.labels ?? [] });
      issue.body = body.body;
      return issueJson(issue);
    }],
    ["GET", /\/labels\/(.+)$/, ([, l]) => {
      if (!world.labels.has(decodeURIComponent(l))) throw notFound(l);
      return { name: decodeURIComponent(l) };
    }],
    ["POST", /\/labels$/, (_, body) => {
      world.labels.add(body.name);
      return { name: body.name };
    }],
    ["PUT", /\/pulls\/(\d+)\/merge$/, ([, n], body) => {
      const pr = world.pulls.find((p) => p.number === Number(n));
      if (pr.blocked) throw new GitHubError("405", { status: 405, data: { message: pr.blocked } });
      pr.merged = true;
      pr.state = "merged";
      pr.method = body.merge_method;
      const sha = commit(pr.base);
      pr.mergeSha = sha;
      return { sha, merged: true };
    }],
    ["GET", /\/pulls\/(\d+)$/, ([, n]) => {
      const pr = world.pulls.find((p) => p.number === Number(n));
      return { number: pr.number, html_url: `https://github.com/${repo}/pull/${pr.number}`, merged: pr.merged, state: pr.merged ? "closed" : pr.state, draft: pr.draft, base: { ref: pr.base } };
    }],
    ["POST", /\/pulls$/, (_, body) => {
      const pr = { number: nextNumber++, base: body.base, head: body.head, state: "open", draft: false, merged: false, title: body.title };
      world.pulls.push(pr);
      return { number: pr.number, html_url: `https://github.com/${repo}/pull/${pr.number}` };
    }],
    ["GET", /\/compare\/(.+)\.\.\.(.+)$/, ([, base, headRef]) => {
      const resolve = (ref) => {
        const name = decodeURIComponent(ref);
        if (world.branches[name]) return world.branches[name];
        const branch = Object.values(world.branches).find((h) => h.includes(name));
        return branch.slice(0, branch.indexOf(name) + 1);
      };
      const b = resolve(base);
      const h = resolve(headRef);
      return { ahead_by: h.filter((sha) => !b.includes(sha)).length, behind_by: b.filter((sha) => !h.includes(sha)).length };
    }],
    ["POST", /\/git\/refs$/, (_, body) => {
      const name = body.ref.replace("refs/heads/", "");
      if (world.branches[name]) throw new GitHubError("422", { status: 422, data: { message: "Reference already exists" } });
      const source = Object.values(world.branches).find((h) => h.includes(body.sha));
      world.branches[name] = source.slice(0, source.indexOf(body.sha) + 1);
      return {};
    }],
    ["DELETE", /\/git\/refs\/heads\/(.+)$/, ([, b]) => {
      delete world.branches[decodeURIComponent(b)];
      return {};
    }],
    ["GET", /\/releases\/tags\/(.+)$/, ([, t]) => {
      const release = world.releases.find((r) => r.tag_name === decodeURIComponent(t));
      if (!release) throw notFound(t);
      return release;
    }],
    ["POST", /\/releases\/generate-notes$/, (_, body) => ({ body: `Notes since ${body.previous_tag_name ?? "the start"}` })],
    ["POST", /\/releases$/, (_, body) => {
      const release = { ...body, html_url: `https://github.com/${repo}/releases/tag/${body.tag_name}`, created_at: now() };
      world.releases.push(release);
      world.tags.push(body.tag_name);
      return release;
    }],
    ["GET", /\/actions\/workflows\/([^/]+)\/runs\?branch=([^&]+)/, ([, wf, tag]) => ({
      workflow_runs: world.runs.filter((r) => r.workflow === decodeURIComponent(wf) && r.tag === decodeURIComponent(tag)),
    })],
    ["GET", /\/commits\/(.+)\/statuses/, ([, ref]) => world.statuses.filter((s) => s.ref === decodeURIComponent(ref))],
    ["GET", /\/commits\/(.+)\/check-runs/, ([, ref]) => ({ check_runs: world.checkRuns.filter((c) => c.ref === decodeURIComponent(ref)) })],
    ["GET", /\/orgs\/([^/]+)\/teams\/([^/]+)\/memberships\/(.+)$/, ([, org, team, user]) => {
      if (!(world.teams[`${org}/${team}`] ?? []).includes(user)) throw notFound(user);
      return { state: "active" };
    }],
    ["GET", /^\/user$/, () => ({ login })],
  ];

  async function request(method, path, body) {
    world.calls.push(`${method} ${path}`);
    for (const [m, pattern, handler] of routes) {
      if (m !== method) continue;
      const match = path.match(pattern);
      if (match) return structuredClone(handler(match, body ?? {}));
    }
    throw new Error(`fakeGitHub: no route for ${method} ${path}`);
  }

  async function graphql(query, vars) {
    world.calls.push(`GRAPHQL ${query.match(/(query|mutation)[^{(]*/)[0].trim()}`);
    if (query.includes("closedByPullRequestsReferences")) {
      const issue = world.issues.find((i) => i.number === vars.number);
      const nodes = (issue?.prs ?? []).map((n) => world.pulls.find((p) => p.number === n)).map((pr) => ({
        number: pr.number,
        url: `https://github.com/${repo}/pull/${pr.number}`,
        state: pr.merged ? "MERGED" : pr.state.toUpperCase(),
        merged: pr.merged,
        isDraft: pr.draft,
        baseRefName: pr.base,
        repository: { nameWithOwner: repo },
      }));
      return { repository: { issue: { closedByPullRequestsReferences: { nodes } } } };
    }
    if (query.includes("updateProjectV2ItemFieldValue")) {
      const item = world.board.items.find((i) => i.id === vars.item);
      item.status = world.board.field.options.find((o) => o.id === vars.option).name;
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } };
    }
    if (query.includes("items(first: 100")) {
      const { board } = world;
      return {
        organization: {
          projectV2: {
            id: board.projectId,
            field: board.field,
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: board.items.map((item) => {
                const issue = world.issues.find((i) => i.number === item.issue);
                return {
                  id: item.id,
                  fieldValueByName: item.status ? { name: item.status } : null,
                  content: { number: issue.number, title: issue.title, url: `https://github.com/${repo}/issues/${issue.number}`, state: issue.state.toUpperCase(), repository: { nameWithOwner: repo }, milestone: issue.milestone ? { number: issue.milestone } : null },
                };
              }),
            },
          },
        },
      };
    }
    throw new Error(`fakeGitHub: no GraphQL handler for ${query.slice(0, 60)}`);
  }

  async function paginate(path) {
    return request("GET", path);
  }

  /** A GitHub Projects board over the repo's issues. */
  function useBoard(statuses) {
    world.board = {
      projectId: "PVT_1",
      field: { id: "FIELD_1", options: statuses.map((name, i) => ({ id: `OPT_${i}`, name })) },
      items: [],
    };
  }

  function putOnBoard(issue, status) {
    world.board.items.push({ id: `ITEM_${issue.number}`, issue: issue.number, status });
  }

  return { request, graphql, paginate, world, addIssue, addPull, commit, head, useBoard, putOnBoard };
}
