# Adopter guide

How to set up Deriv AKO for your team, and keep it safe.

## What you need

- Node.js 22.4 or later, on a laptop to try it or a small server for a team. Or Docker, for the Slack bot.
- Admin rights on the GitHub organization (or personal account) that owns your repos, to create and install the app.
- For ClickUp boards, a ClickUp API token. For Slack, rights to create an app in your workspace.

## 1. Run the setup

```bash
npm install
npx ako setup
```

Run every command as `npx ako …` in the AKO folder. `npx` runs the copy installed there; in another folder it would look for a package called `ako` on npm instead, which isn't AKO. `npm run setup` and `npm run check` do the same as `npx ako setup` and `npx ako check`.

Run the setup again any time. It asks what you want to change (add a project, connect Slack or change its channels and people, the AI provider, the GitHub App, or start the flow file over) and runs only that part. It keeps what's already in `.env` and `release-flow.yaml`, including your own comments. Adding a project uses the app already in `.env` without asking, and sets up its Slack channel when Slack is connected.

The setup opens pages in your browser and always prints their links too. On a server with no browser, run it as `BROWSER=none npx ako setup` and open the links yourself.

The setup's first question is where to do it:

- **In your browser**: a form, one question at a time. This is the default.
- **Here in the terminal**: menus you move through with the arrow keys, and hidden input for tokens.

Both ask the same questions and write the same files. To skip the first question, run `npx ako setup --ui` (browser) or `npx ako setup --terminal`. When the setup's input is piped from a script, it uses plain numbered questions instead.

The setup won't finish with a project nobody can approve: if a project has no release managers by the end, it asks for their GitHub usernames, or whether whoever asks may approve.

**Going back.** Press Esc to go back to the previous question, across steps too. In the terminal it then asks whether you meant to go back or quit; in the browser there is also a Back button. Each question you go through again offers your earlier answer, so Enter keeps it. Nothing is done twice: going back past the step that created the GitHub App offers that app rather than creating another, and a project is never added to the flow file twice. With piped input, answer `<` to go back.

### In your browser

This asks the same questions as the terminal setup, with forms instead of typed answers, and writes the same files. A band across the top shows every part of the setup as a pipeline and ticks each one off. Questions come one at a time, with what AKO said since your last answer in the same card, and a log below keeps everything AKO did. Beside them, `release-flow.yaml` shows as AKO last saved it, with the lines that changed marked. Away from a text field, 1 to 8 pick an option, Y or N answer a yes-or-no question, Enter continues and Esc goes back. The button at the top switches between light and dark mode; until you use it, the page follows your system. The terminal shows each step as it happens. `npx ako chat add slack --ui` does the same for adding Slack.

- The page is served by AKO on `127.0.0.1`, only while the setup runs. When it finishes, the page says so and the server stops. Nothing stays online.
- Its link carries a one-time code, and AKO only answers requests to the loopback address, so other programs and websites can't use the page.
- Tokens go in password fields. They are saved to `.env` and never sent back to the page. The page is shown `release-flow.yaml`, which holds no secrets, and nothing else.
- Keep the terminal that started it open. Closing it ends the setup; what was already saved is kept.

### The GitHub App

AKO acts through its own GitHub App, never a personal access token. The setup asks which boards and deploy reporting you use, then creates an app with just those permissions: a browser page opens, you confirm on GitHub, and AKO saves the app's ID and private key to `.env`. GitHub shows that key once, so the setup writes it straight away.

Then install the app on the account that owns your repos, choosing only the repos AKO releases.

To create the app by hand instead, use the settings in `manifests/github-app.json`, generate a private key, and pick "Use a GitHub App I already created" in the setup.

Asking for and giving approvals from the terminal is done as a person, who signs in through the app. That needs **Enable Device Flow** ticked in the app's settings, which only GitHub's settings page can change. The setup offers to sign you in, and opens that page only if GitHub says Device Flow is off; tick it, save, and the sign-in carries on. Choose Later to do it with `npx ako login`.

### GitHub App permissions

| Permission      | Access         | Why                                                         | When                              |
| :-------------- | :------------- | :---------------------------------------------------------- | :-------------------------------- |
| Metadata        | Read           | Required by GitHub for every app                            | Always                            |
| Contents        | Read and write | Merge PRs, create tags and releases                         | Always                            |
| Pull requests   | Read and write | Merge PRs, open promotion PRs                               | Always                            |
| Issues          | Read and write | Milestones, assigning issues, the release's tracking issue  | Always                            |
| Actions         | Read           | Find the deploy run a tag starts                            | Always                            |
| Projects (org)  | Read and write | Read the board and move issues between columns              | GitHub Projects boards            |
| Commit statuses | Read           | Watch deploys that report as commit statuses                | `deploy.type: commit-status`      |
| Checks          | Read           | Watch deploys that report as check runs                     | `deploy.type: check-run`          |
| Members (org)   | Read           | Check membership of release-manager teams                   | Teams in `people`                 |

When you add a project that needs more, `npx ako check` names the missing permission and links to the page to add it. After changing an app's permissions, accept them on the installation.

### Projects

For each project the setup reads the repo's board, branches and workflows, so you pick from lists rather than type names. See the [flow file reference](flow-file.md) for every field, and [examples/](../examples/) for complete files.

### AI provider (optional)

Any provider with an OpenAI-compatible API works: OpenAI itself, or LiteLLM, OpenRouter, Anthropic and others through their base URL. The setup lists the provider's models to pick from. Without a key, AKO takes plain commands only.

### Slack (optional)

See [slack.md](slack.md). Add it later by running the setup again, or with `npx ako chat add slack`.

## 2. Check every connection

```bash
npx ako check
```

Fix everything marked ✗ before the first release. Warnings (!) are worth reading; the most common is unprotected release tags.

## 3. Protect your release tags

Anyone with write access to a repo can create a tag, which would start a production deploy without a release manager's approval. A tag ruleset closes that gap:

1. In the repo, open **Settings > Rules > Rulesets > New ruleset > New tag ruleset**.
2. Name it, and set **Enforcement status** to **Active**.
3. Under **Bypass list**, add the AKO GitHub App.
4. Under **Target tags**, add a pattern for your prefix, such as `production_v*`.
5. Tick **Restrict creations**, **Restrict updates** and **Restrict deletions**, then save.

`npx ako check` then shows the tags as protected. Rulesets on private repos need a paid GitHub plan; on the free plan the check keeps warning, and the approval stays a convention.

## 4. Run releases

Every command runs in the AKO folder, which holds `.env` and `release-flow.yaml`. Each one can be typed as a command or asked in plain words in `npx ako`.

| Command                                     | What it does                                                                                          |
| :------------------------------------------ | :---------------------------------------------------------------------------------------------------- |
| `npx ako release ready <project>`           | Lists the work that's ready and not already in a release.                                              |
| `npx ako release create <project>`          | Asks which issues go in, adds them to the open release (or opens one), merges their PRs, and offers to tell QA. Run it again to retry PRs that didn't merge. `--items 12,14`, `--all` and `--yes` skip the questions. |
| `npx ako release announce <project>`        | Tells QA regression can start, at the commit on the branch now. For when it was skipped at `create`.   |
| `npx ako release status <project>`          | Where each issue in the project's latest releases stands.                                              |
| `npx ako release request <project>`         | Asks the release managers to approve. Needs your sign-in. Refused until every issue is ready for release. |
| `npx ako release approve <project>`         | A release manager approves: AKO checks every issue is still ready, tags the tested commit, publishes the GitHub Release and watches the deploy. |
| `npx ako release hold <project> --note "…"` | A release manager holds it. Ask again with `request` when it's ready.                                  |
| `npx ako release watch <project>`           | Follows the deploy of the latest published release.                                                    |
| `npx ako release archive <project>`         | Moves the release's work to `done` and closes the release.                                             |
| `npx ako release unlock <tag>`              | Clears a lock left by a copy of AKO that stopped mid-step. Locks also expire after 10 minutes.         |

### Which release a command acts on

Name the project, and each command finds the release it can act on:

| Command    | Acts on                                                                    |
| :--------- | :------------------------------------------------------------------------- |
| `announce` | the open release QA hasn't been told about, else the one QA is testing     |
| `request`  | the release in regression (or open, for a flow without QA)                 |
| `approve`, `hold` | the release waiting for approval                                    |
| `watch`    | the latest published release                                               |
| `archive`  | the published release not yet archived                                     |

When several fit, the terminal asks which, and Slack shows a button for each. With `--yes` nobody is there to ask, so AKO lists them and stops. A tag always names one release exactly, and finds its project by prefix: `npx ako release approve production_v20261102_0` works without the project when only one project uses that prefix.

### One open release at a time

A project has one open release. `create` adds new work to it until its approval is asked for, and retries any of its PRs that didn't merge before (a failed check, a missing review, or a PR linked since), even when nothing new is ready; then the release waiting for approval keeps its tested commit, and `create` opens the next release for the new work. Work added or merged once regression has started came after the commit QA was testing, so the release goes back to QA: tell QA again, and the tag then holds the new work too.

### Signing in

`npx ako login` signs you in through the AKO app with GitHub's device flow: you confirm a code in your browser, and AKO never sees a password. From then on, merges, tags and approvals from your terminal show on GitHub as you, through the app. The sign-in lasts eight hours; `npx ako whoami` shows it and `npx ako logout` ends it. It's kept in `~/.config/deriv-ako/credentials.json`, readable only by you.

Asking for approval, approving and holding from the terminal need a sign-in: GitHub records who approved, and AKO can tell when someone tries to approve their own request. When you aren't signed in, those commands offer to sign you in first (with `--yes` they say to run `npx ako login` instead). Without a sign-in, the other commands act as the app, using the private key in `.env`.

Signing in needs **Enable Device Flow** turned on in the app's settings. The setup offers to do both.

### Who may approve

- Only the release managers in the flow file: GitHub usernames and teams for the terminal, Slack users and user groups for Slack.
- Whoever asked for approval can't approve the same request, unless the project sets `approval: self`. A request always comes from a person (signed in on the terminal, or in Slack), never from the app, so it can't be made anonymously and then approved by the same person.
- A release is approved where it was asked for: a request from the terminal is approved from the terminal, and one from Slack in Slack. AKO knows people by their GitHub login in one and their Slack user in the other, and can't tell that the two are the same person, so this keeps someone from approving their own request in the other place. A request is refused where no release manager could approve it. Holding works from either place.
- A request expires after 24 hours. Ask again to restart it.

### Where releases are kept

Each release has a tracking issue in its project's repo, labelled `ako-release`. Its description lists the release's issues, the tested commit and who asked and approved, and ends with AKO's own state in a hidden block. Don't edit that block. Comments on the issue record each step and mention QA and the release managers on GitHub.

Because the release lives on GitHub, the terminal and the Slack bot always see the same release, and any copy of AKO can pick up where another stopped. Before a step that changes GitHub (merging, tagging, archiving), AKO posts a short lock comment, so two copies can't do it at once. Only lock comments from the AKO app or from people with access to the repo count, so someone outside it can't block a release by posting one.

### Protected tags and personal sign-ins

With the tag ruleset from step 3, GitHub may refuse a release tag created by a person signed in through the app, since only the app is on the bypass list. When that happens and the machine has the app's private key, AKO creates the tag as the app; the approval is still recorded under the person who gave it. Without the key, AKO says so and the release manager approves in Slack instead. Adding release managers to the ruleset's bypass list also works, at the cost of letting them create tags by hand.

## 5. Run the Slack bot

`npx ako serve` connects to Slack and keeps running. It needs no public URL or open port: it opens a WebSocket to Slack (Socket Mode).

To run it as a container on a server, copy `.env` and `release-flow.yaml` next to `docker-compose.yml` and run:

```bash
docker compose up -d
docker compose logs -f
```

The image contains no secrets and no team settings. `.env` is passed in as environment variables and `release-flow.yaml` is mounted read-only. If `.env` points `GITHUB_APP_PRIVATE_KEY_PATH` at a file, uncomment the `secrets` volume. The container runs as a non-root user and stops cleanly on `docker compose down`.

Only run one bot per Slack app: Slack spreads events across every open connection, so two copies would each see part of the conversation. Any number of people can use the terminal at the same time.

## Keeping secrets safe

- `.env` is created readable only by its owner and is git-ignored. Keep it on the machine that runs AKO, or in your secret store.
- The private key in `.env` acts as the app. Anyone holding it can do whatever the app can, so rotate it from the app's settings if it's ever exposed.
- `~/.config/deriv-ako/credentials.json` holds each person's `npx ako login` token. It's readable only by them and expires after eight hours.
- `release-flow.yaml` holds no secrets, only names and IDs. It's git-ignored too, since a clone of AKO is often public; keep it in your own private repo if you want it versioned.
