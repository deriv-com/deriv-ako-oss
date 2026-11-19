# Flow file reference

`release-flow.yaml` describes each project's release process. `npx ako setup` writes it, and you can edit it by hand; `npx ako check` validates it. It holds no secrets: those live in `.env`.

```yaml
version: 1

defaults:            # optional: shared by every project, overridden per project
  approval: others

projects:
  - key: web-app
    name: Web App
    aliases: [web]
    repo: acme/web-app
    tracker: { ... }
    release: { ... }
    deploy: { ... }
    steps: qa-regression
    approval: others
    people: { ... }
    slack: { ... }
```

## Top level

| Field      | Required | Meaning                                                                                             |
| :--------- | :------- | :-------------------------------------------------------------------------------------------------- |
| `version`  | yes      | The file format. Always `1` for now.                                                                |
| `defaults` | no       | Any project field. Each project gets these unless it sets its own; sections like `people` merge per key. |
| `projects` | yes      | One entry per project.                                                                              |

## Project

| Field      | Required | Meaning                                                                                                           |
| :--------- | :------- | :---------------------------------------------------------------------------------------------------------------- |
| `key`      | yes      | Lowercase letters, numbers and dashes. Used in commands: `create release for web-app`.                            |
| `name`     | no       | Display name. Defaults to `key`.                                                                                  |
| `aliases`  | no       | Other names people use. When a name fits two projects, AKO asks which one.                                        |
| `repo`     | yes      | `owner/name` on GitHub. PRs from other repos linked to an issue are listed but never merged.                      |
| `tracker`  | yes      | Where the work lives. See below.                                                                                  |
| `release`  | no       | What gets tagged. Defaults to a tag on the repo's default branch.                                                 |
| `deploy`   | no       | How the deploy reports back. Defaults to `none`.                                                                  |
| `steps`    | no       | `qa-regression` (default), `direct-release`, or a list. See below.                                                |
| `approval` | no       | `others` (default): a release manager who didn't ask for the release approves it. `self`: release managers may approve their own requests; with none listed, whoever asked approves, for solo developers. |
| `people`   | depends  | Release managers and QA. At least one release manager is required unless `approval: self`.                       |
| `slack`    | no       | The project's Slack channels.                                                                                     |

## Tracker

Every tracker has `statuses`, naming the columns (or labels) AKO reads and moves work between:

| Status              | Required        | Meaning                                                                                                   |
| :------------------ | :-------------- | :-------------------------------------------------------------------------------------------------------- |
| `ready`             | yes             | One or more columns holding work that's ready to go into a release.                                       |
| `staged`            | no              | Where AKO moves an issue once its PRs merge. Without it, issues stay put.                                 |
| `ready_for_release` | yes             | Where QA moves tested work. Every issue must be here before the release can be approved.                  |
| `done`              | for `archive`   | Where AKO moves issues after the release ships.                                                           |
| `catch_up`          | no              | Earlier columns to also scan for closed issues whose PRs already reached the release branch.              |

### `type: github-projects`

A GitHub Projects board owned by an organization. GitHub Apps can't read boards on personal accounts.

| Field          | Required | Meaning                                                      |
| :------------- | :------- | :----------------------------------------------------------- |
| `number`       | yes      | The board number, from its URL: `.../projects/<number>`.     |
| `owner`        | no       | The organization owning the board. Defaults to the repo owner. |
| `status_field` | no       | The single-select field holding the columns. Default `Status`. |

### `type: github-issues`

Plain issues on the repo, with one label per status. `done: closed` closes the issue instead of labelling it. Merging a PR also closes the issues it names, so a closed issue counts as done only when it has no status label: one still labelled `Staged` hasn't passed QA.

### `type: clickup`

| Field              | Required | Meaning                                                                                  |
| :----------------- | :------- | :--------------------------------------------------------------------------------------- |
| `list`             | yes      | The list ID: the number after `/li/` in the list's URL. Quote it in YAML.                |
| `release_list`     | no       | Where release tasks are created. Defaults to `list`.                                     |
| `release_template` | no       | A task copied for each release, such as one holding your QA checklist.                   |
| `pr_field`         | no       | The custom field holding PR links. AKO also reads the task description.                  |

ClickUp status names are matched without regard to case. Needs `CLICKUP_API_TOKEN` in `.env`.

## Release

| Field        | Applies to       | Meaning                                                                                          |
| :----------- | :--------------- | :----------------------------------------------------------------------------------------------- |
| `type`       |                  | `tag` (default) or `release-branch`.                                                             |
| `tag_prefix` | both             | Tags are `<prefix><YYYYMMDD>_<n>`, such as `production_v20261102_0`. Default `production_v`.     |
| `branch`     | `tag`            | Where PRs merge and the tested commit is tagged. Defaults to the repo's default branch.          |
| `from`, `to` | `release-branch` | PRs merge into `from`, which deploys to staging. At approval AKO promotes the tested commit into `to` and tags that merge. |
| `merge_method` | both           | How AKO merges each issue's PRs: `squash` (default), `merge` or `rebase`. Promotion PRs always use `merge`. |

The release is opened in the tracker, named after the tag it will get: a milestone for GitHub trackers, a release task for ClickUp. At approval AKO tags the commit QA tested, not whatever is newest, and publishes a GitHub Release. Commits merged after regression started stay out and go in the next release; asking for approval says how many there are.

One release is open per project at a time. Running `create` again adds the newly ready work to it, unless you ask for a new one (`--new`, or the "Open a new release" button in Slack).

## Deploy

| `type`          | Field      | Watches                                                              |
| :-------------- | :--------- | :------------------------------------------------------------------- |
| `actions`       | `workflow` | The GitHub Actions workflow file the tag starts, such as `deploy.yml`. |
| `commit-status` | `context`  | Commit statuses whose name starts with this (CircleCI, Jenkins, Bitrise). |
| `check-run`     | `check`    | Check runs whose name starts with this (Google Cloud Build).          |
| `none`          |            | Nothing: AKO reports the tag and release, and stops.                  |

AKO never deploys anything itself.

## Steps

Steps run in this order. A project lists a subset, in the same order.

| Step                  | What happens                                                                 |
| :-------------------- | :--------------------------------------------------------------------------- |
| `pick_issues`         | Lists ready work for someone to tick. Required.                              |
| `open_release`        | Opens the release in the tracker, named after its tag. Required.             |
| `merge_prs`           | Merges each issue's open PRs in the project's repo.                          |
| `announce_regression` | Tells QA the release is on staging.                                          |
| `approval`            | Asks the release managers, and waits for one to approve. Required.           |
| `publish`             | Tags the tested commit and publishes a GitHub Release. Required.             |
| `watch_deploy`        | Follows the deploy the tag starts and reports how it went.                   |
| `archive`             | Moves the release's issues to `done`.                                        |

Presets: `qa-regression` is all eight. `direct-release` skips `merge_prs` and `announce_regression`, for work that's already merged and needs no QA step.

## People

```yaml
people:
  release_managers:
    github: [alice, acme/release-managers]   # usernames or org/team
    slack: [U000000001, S000000001]          # Slack user IDs (U...) or user group IDs (S...)
  qa:
    github: [bob]
    slack: [S000000002]
```

Store IDs, not display names: names change and repeat. The setup wizard looks names up and writes the IDs. In Slack, anyone listed (or in a listed user group) can approve there. From the terminal, approving needs your own GitHub sign-in, so it uses the `github` list. GitHub teams need the app's Members permission.

## Slack

| Field              | Meaning                                                              |
| :----------------- | :------------------------------------------------------------------- |
| `channels`         | Channel IDs (`C...`) where AKO answers for this project.             |
| `announce_channel` | Where release announcements go. Defaults to the first channel.       |
