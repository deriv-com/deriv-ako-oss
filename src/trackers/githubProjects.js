// GitHub Projects boards. A GitHub App can only read boards owned by an
// organization; boards on a personal account are out of its reach.

const LIST_PROJECTS = `
query($owner: String!) {
  organization(login: $owner) {
    projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number title closed url }
    }
  }
}`;

const PROJECT_FIELDS = `
query($owner: String!, $number: Int!) {
  organization(login: $owner) {
    projectV2(number: $number) {
      title
      url
      fields(first: 50) {
        nodes {
          ... on ProjectV2SingleSelectField { name options { name } }
        }
      }
    }
  }
}`;

/** Open boards in an organization, newest activity first. */
export async function listProjects(github, owner) {
  const data = await github.graphql(LIST_PROJECTS, { owner });
  return (data.organization?.projectsV2?.nodes ?? []).filter((p) => p && !p.closed);
}

/** The board's title, URL and the options of its status field. */
export async function getProjectStatuses(github, { owner, number, status_field = "Status" }) {
  const data = await github.graphql(PROJECT_FIELDS, { owner, number });
  const project = data.organization?.projectV2;
  if (!project) throw new Error(`Board ${owner} #${number} was not found, or the app can't read it.`);
  const field = project.fields.nodes.find((f) => f?.name?.toLowerCase() === status_field.toLowerCase());
  if (!field) {
    throw new Error(`Board "${project.title}" has no single-select field named "${status_field}".`);
  }
  return { title: project.title, url: project.url, statuses: field.options.map((o) => o.name) };
}

// --- The release engine's adapter ---

const BOARD = `
query($owner: String!, $number: Int!, $field: String!, $after: String) {
  organization(login: $owner) {
    projectV2(number: $number) {
      id
      field(name: $field) { ... on ProjectV2SingleSelectField { id options { id name } } }
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          fieldValueByName(name: $field) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          content { ... on Issue { number title url state repository { nameWithOwner } milestone { number } } }
        }
      }
    }
  }
}`;

const SET_STATUS = `
mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(
    input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }
  ) { projectV2Item { id } }
}`;

/** Every issue on the board, with its status. Boards are shared, so callers filter by repo. */
export async function readBoard(github, { owner, number, status_field = "Status" }) {
  const items = [];
  let after = null;
  let board;
  for (let page = 0; page < 20; page += 1) {
    const data = await github.graphql(BOARD, { owner, number, field: status_field, after });
    board = data.organization?.projectV2;
    if (!board) throw new Error(`Board ${owner} #${number} was not found, or the app can't read it.`);
    for (const node of board.items.nodes) {
      if (!node?.content?.number) continue; // drafts and pull requests
      items.push({
        projectItemId: node.id,
        status: node.fieldValueByName?.name ?? null,
        number: node.content.number,
        title: node.content.title,
        url: node.content.url,
        closed: node.content.state === "CLOSED",
        repo: node.content.repository.nameWithOwner,
        milestone: node.content.milestone?.number ?? null,
      });
    }
    if (!board.items.pageInfo.hasNextPage) break;
    after = board.items.pageInfo.endCursor;
  }
  return { projectId: board.id, field: board.field, items };
}

export async function setBoardStatus(github, board, projectItemId, status) {
  const option = board.field?.options.find((o) => o.name === status);
  if (!option) throw new Error(`The board has no "${status}" status.`);
  await github.graphql(SET_STATUS, { project: board.projectId, item: projectItemId, field: board.field.id, option: option.id });
}
