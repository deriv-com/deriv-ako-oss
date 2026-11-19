# Changelog

All notable changes are listed here. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- Every command runs as `npx ako …` in the AKO folder. `npm run setup` and `npm run check` stay as aliases.
- `npx ako setup`: creates AKO's GitHub App from a manifest, describes each project in `release-flow.yaml` by reading its board, branches and workflows, and connects an optional AI provider and Slack. It offers to sign in, opening the app's settings to turn on Device Flow only when GitHub says it's off, and won't finish with a project nobody can approve.
- Running `npx ako setup` again asks what to change (add a project, Slack, the AI provider, the GitHub App, or start over) and runs only that part. Adding a project reuses the app without asking and sets up the new project's Slack channel.
- `npx ako check`: tests the GitHub App and its permissions, each repo, board, branch and deploy workflow, release-tag protection, the AI provider and Slack.
- `npx ako chat add slack`: connects Slack to an existing setup.
- `npx ako setup --ui`: the same setup in a browser page served from `127.0.0.1` while it runs, behind a one-time link code. A band shows every part of the setup as a pipeline and ticks each one off; the page asks one question at a time with what AKO said since the last answer, keeps a log of everything AKO did, shows `release-flow.yaml` as it's saved with the changed lines marked, and ends with the next command to run. Keys work too: 1 to 8 pick an option, Y or N answer a yes-or-no question, Enter continues and Esc goes back. A button switches between light and dark mode, which otherwise follows the system.
- `npx ako setup` starts by asking whether to continue in the browser or the terminal. The terminal setup uses arrow-key menus, hidden token input and grouped messages.
- Going back in the setup: Esc (or Back in the browser) returns to the previous question, across steps, offering earlier answers again without repeating what they did.
- `release-flow.yaml` version 1, with GitHub Projects, GitHub issues and ClickUp trackers, tag and release-branch releases, and Actions, commit-status and check-run deploy watching.
- GitHub App and Slack app manifests, example flow files, and a leak check for public contributions.
- `npx ako release`: `ready`, `create`, `announce`, `status`, `request`, `approve`, `hold`, `watch`, `archive` and `unlock`. Name the project and each one finds the release it acts on (`approve` the one waiting for approval, `announce` the one QA hasn't heard about), asking when several fit, or listing them with `--yes`; a tag names one exactly. A project has one open release at a time: new work joins it until its approval is asked for, then goes in the next release. Running `create` again retries the open release's PRs that didn't merge, and a merge after regression started sends it back to QA. A release picks ready work from GitHub Projects, GitHub issues or ClickUp, opens a milestone or ClickUp task named after its tag, merges each issue's PRs, tells QA, asks the release managers, tags the commit QA tested, publishes a GitHub Release, follows the deploy and archives the work.
- Release-branch flows promote the tested commit (not the branch as it is now) through a pull request, and tag the merge.
- Each release is kept in a tracking issue on GitHub, with a lock for steps that change GitHub, so the terminal, the Slack bot and restarts all see the same release and nothing runs twice.
- `npx ako login`, `npx ako logout` and `npx ako whoami`: sign in through the AKO app with GitHub's device flow, so approvals from the terminal are recorded as you. Asking for, giving or holding an approval without a sign-in offers to sign in on the spot.
- `npx ako`: ask in plain words. Rules read common requests without AI; an optional AI provider reads the rest, and its answer is checked against the fixed list of actions and your projects.
- `npx ako serve`: the Slack bot, over Socket Mode, with buttons for each step and approvals checked against Slack release managers and user groups. A request by project that could mean several releases gets a button for each.
- A Dockerfile and `docker-compose.yml` for running the bot.
- `release.merge_method` in the flow file: `squash` (default), `merge` or `rebase`.
- Release safeguards: work added after regression started sends the release back to QA, so the tag can't leave it out; nothing joins a release once its approval is asked for; approving checks QA's statuses again; asking for approval needs a person; a typed approval in Slack only shows the Approve button; and only AKO's app or people with repo access can hold a release's lock.
- The terminal shows a spinner while AKO works and ignores keys pressed meanwhile, so a stray Esc can't cancel the next question. Esc inside a request in `ako` stops only that request.

### Changed

- The Slack app asks only for the scopes the bot uses: `channels:history`, `groups:history`, `im:read` and `im:write` are gone, so AKO can't read channel messages it isn't mentioned in. An app made from an older manifest keeps them until they're removed under OAuth & Permissions and the app is reinstalled.
- A release is approved where it was asked for: from the terminal for a terminal request, in Slack for a Slack one. AKO can't match a GitHub login to a Slack user, so someone could otherwise ask in one place and approve their own request in the other. A request is refused where no release manager could approve it, and either place can still hold a release.
- Approving or holding a release says why it can't happen (not a release manager, your own request, nothing to approve) before asking anything, and approving an archived release says it's already published and archived.

- Node.js 22.4 or later is required (Node.js 20 has reached end of life, and the Slack bot uses Node's built-in WebSocket).

### Security

- The Docker image runs Node.js 22.23.5, which has the Node.js security fixes released on 10 November 2026.
- GitHub, ClickUp and Slack requests that hit a rate limit (429, or GitHub's 403 with a reset time or `Retry-After`) are sent again once the wait the service asks for is over, up to two retries and a minute per wait. A longer wait is reported instead of hanging the command.
- The browser setup accepts only `127.0.0.1` as the Host, not `localhost`, so a name pointed elsewhere by a resolver can't reach it.
- A flow file with too many YAML aliases is reported as a YAML error, like any other, instead of crashing the command.
- Slack user-group lookups drop expired entries from the cache.
