# Security policy

## Supported versions

Security fixes go into the latest release. Run a release tag rather than the default branch, and update when a new one comes out.

## Reporting a vulnerability

Please don't open a public issue for a security problem.

1. **GitHub private advisory** (preferred): [report a vulnerability](https://github.com/deriv-com/deriv-ako-oss/security/advisories/new).
2. **Email**: [security@deriv.com](mailto:security@deriv.com). Name the repository and the part affected.

Include what the problem is, how to reproduce it, and its impact. We aim to acknowledge reports within a few business days.

## Running AKO safely

- **`.env` holds secrets**: the GitHub App's private key and any Slack, ClickUp and AI tokens. Setup writes it readable only by its owner. Never commit it, and keep it on the one machine or secret store that runs AKO.
- **Run `npx ako` only in the AKO folder.** There it runs the copy you installed. In another folder, `npx` would look for a package called `ako` on npm, which isn't AKO.
- **The browser setup** (`npx ako setup --ui`) is served only on `127.0.0.1` while it runs, behind a one-time link code, and checks the Host header so another site can't reach it through DNS rebinding. It shows `release-flow.yaml` as it's saved, and never `.env` or any token. Don't forward or share its link while it's open.
- **The GitHub App** asks only for the permissions your flow file uses. The full list and the reason for each is in [docs/adopter-guide.md](docs/adopter-guide.md#github-app-permissions).
- **Protect your release tags.** Anyone with write access to a repo can create a tag. A tag ruleset that lets only the AKO app create release tags makes the release manager's approval the real gate. `npx ako check` warns when tags aren't protected.
- **`npx ako login` keeps a personal token** in `~/.config/deriv-ako/credentials.json`, readable only by its owner, for eight hours. It can do only what both that person and the app may. `npx ako logout` deletes it.
- **Release state is public to anyone who can read the repo.** Each release's tracking issue lists its issues, commits and who approved. It holds no secrets. AKO ignores lock comments there from anyone but its own app and people with access to the repo, so an outsider can't stall a release.
- **Approvals need two people unless you say otherwise.** Asking for approval needs a person, never the app, and whoever asked can't approve the same request unless the project sets `approval: self`. A release is approved where it was asked for (the terminal or Slack), since AKO can't match a GitHub login to a Slack user. In Slack, typing "approve" only shows the Approve button.
- **The AI never decides anything on its own.** It only reads what a person typed to AKO, never issue or pull request text, and its answer is checked against a fixed list of actions and the projects in your flow file. Merges, tags and releases still need a person's confirmation and a release manager's approval.
