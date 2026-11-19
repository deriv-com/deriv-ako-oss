# Contributing

Thanks for helping improve Deriv AKO.

## Before you start

- For a bug, open an issue with what you ran, what you expected and what happened. Leave out tokens, keys and anything from your own `.env`.
- For a new feature, open an issue first so we can agree on the approach before you write code.
- Security problems go through [SECURITY.md](SECURITY.md), not issues.

## Development

```bash
npm install
npm test
npm run leak-check
```

- Node.js 22.4 or later, ES modules, no build step.
- Keep dependencies to a minimum. Each new one needs a reason in the PR, and `node scripts/third-party-notices.js` to update [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- If you change how a manifest is built, run `node scripts/write-manifests.js` so the files in `manifests/` match.

### Installing and publishing

AKO is installed from a clone (`git clone`, `npm install`, then `npx ako` in that folder), as the [README](README.md#quick-start) says. It is not published to npm: `"private": true` in `package.json` makes `npm publish` refuse, so it can't go out by accident. If we decide to publish it, that is its own change: drop `"private"`, add a `files` list so only `bin/`, `src/`, `manifests/` and the docs ship, add `publishConfig`, and update the README.

## Design rules

- **A new team writes a flow file, not code.** Nothing in AKO may branch on a project's name. If a release process can't be described in `release-flow.yaml`, add a step or an adapter for everyone, not a special case.
- **GitHub is the source of truth.** Every step re-reads GitHub before acting and skips what's already done, so two copies of AKO, or a retry, never merge or tag twice.
- **The AI only picks an action.** It never reads issue or PR text, and code checks every answer it gives.

## Tests and examples

Use made-up data only: the `acme` organization, people like `alice` and `bob`, and placeholder Slack IDs of a letter, zeros and a few digits (`U000000001`). Real tokens, IDs, names, emails and internal links fail the leak check.

## Pull requests

- Keep each PR to one change, with tests.
- Run `npm test` and `npm run leak-check` before you open it. Both must pass.
- A maintainer reviews every PR before it merges.

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE), and to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
