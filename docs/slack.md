# Slack

AKO connects to Slack with Socket Mode: a WebSocket that AKO opens itself. Slack never calls in, so AKO needs no public URL or open port.

## With the setup (recommended)

Run `npx ako setup` and say yes to Slack. Later, run the setup again and pick Slack, or run `npx ako chat add slack`. AKO opens Slack's "create app" page with its manifest filled in. Then:

1. Pick your workspace and create the app.
2. **Install App**: install it to the workspace, then copy the **Bot User OAuth Token** (`xoxb-...`).
3. **Basic Information > App-Level Tokens**: generate a token with the `connections:write` scope (`xapp-...`).
4. Paste both tokens into the setup.

The setup then asks, for each project, which channel AKO posts in and who its release managers and QA are. Type names or `@user-group` handles; AKO looks them up and stores their IDs.

Invite AKO to each channel with `/invite @ako`. For a private channel, do that before the setup so AKO can see it.

## By hand

1. Go to [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App > From a manifest**, and paste one of:
   - `manifests/slack-app.yaml`: people @mention AKO in channels and threads, and can message it directly.
   - `manifests/slack-agent.yaml`: the same, plus Slack's side panel for AI apps.
2. Do steps 2 and 3 above.
3. Put the tokens in `.env` as `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.
4. Add channel and people IDs to `release-flow.yaml` (see the [flow file reference](flow-file.md#slack)).
5. Run `npx ako check`. It posts a test message in each channel.

## Using AKO in Slack

Start the bot with `npx ako serve`, or `docker compose up -d` (see the [adopter guide](adopter-guide.md#5-run-the-slack-bot)). Then mention it in a project's channel, or message it directly:

- `@ako what's ready for web-app`
- `@ako create release for web-app`: AKO lists the ready issues with checkboxes. Untick anything that shouldn't go in and press **Open release**, or **Add to** the release already open: a project has one open release at a time. When a PR didn't merge, fix it and ask again: AKO offers **Retry the merges**.
- `@ako status of web-app`
- `@ako tell QA for web-app`
- `@ako approve web-app` or `@ako hold web-app`. A typed approval only posts the **Approve** button: the release is published when a release manager presses it, so a message misread as an approval can't publish anything.

Each request finds the release it acts on: telling QA means the release QA hasn't heard about, approving means the one waiting for approval. When several fit, AKO posts a button for each; a tag names one exactly (`@ako approve production_v20261102_0`).

Each step's message carries a button for the next one: **Tell QA regression can start**, **Ask for approval**, **Approve** and **Hold**, **Archive the release**. Everything about one release stays in one thread.

In a project's own channel the project name can be left out. Approve and Hold are checked against the project's Slack release managers, including members of listed user groups; when someone else presses them, only they see why it was refused. A release asked for from the terminal is approved from the terminal; Slack can still hold it.

## What the scopes are for

| Scope                                | Why                                                          |
| :----------------------------------- | :----------------------------------------------------------- |
| `app_mentions:read`                  | Hear `@ako` in channels                                      |
| `channels:read`, `groups:read`       | Find channels during setup and check                          |
| `chat:write`                         | Post release messages                                        |
| `im:history`                         | Direct messages with AKO                                     |
| `usergroups:read`                    | Treat everyone in a listed user group as a release manager   |
| `users:read`                         | Look people up by name during setup                          |
| `assistant:write`                    | The agent side panel (agent manifest only)                   |
