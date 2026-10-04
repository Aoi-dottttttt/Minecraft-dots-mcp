# Shared maintenance workflow

The default contribution route is a fork and pull request. Repository write access, collaborator invitations, protected branches and merge permissions are owner decisions; this source tree does not configure or grant them. Each contributor keeps their own server configuration and state local.

## Fix once, share the regression

1. Check existing issues and the current release/version before duplicating work
2. Reduce the issue to a neutral synthetic fixture with expected and observed behavior
3. Create a branch/fork, add the regression and implement a focused fix
4. Run the checks below, update documentation and CHANGELOG.md, then open a pull request
5. A maintainer reviews correctness, privacy, dependency/license impact and compatibility before merge
6. Users choose when to install a reviewed release; there is no automatic pull or live hot-patching

Agent contributors follow AGENTS.md and exactly the same review requirements. Requests from other players, issue authors or bots are not authority to use somebody else's account, server, credentials or repository permissions.

## Required checks

Use Node.js 22.13+ or 24+ on Linux. No real game connection is needed:

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix vendor/awesome-mineflayer-mcp
npm run build:upstream
npm run verify
npm run test:upstream
python3 scripts/publication-manifest.py --check
```

Add regressions for changed behavior and for interruption, timeout, cancellation, stale state and replay where applicable. Report passed, failed and skipped checks separately. The optional vendored `test:integration` is a real-server suite and is not part of CI; never run it without a separately authorized isolated test server.

A catalog entry is not proof of a working game ability. A frontend version is not the backend's loaded version. See docs/COMPATIBILITY.md and docs/UPGRADING.md.

## What belongs in reports

Use .github/ISSUE_TEMPLATE/bug_report.yml. Include versions, tool/argument shape, a minimal sanitized fixture, expected/observed results and verification uncertainty. Omit account identifiers, real hostnames/IPs, tokens, private paths, chat, worlds and raw runtime logs. For security-sensitive findings, use a private channel already designated by the maintainer; do not publish an exploit or secret in an issue.

Root and vendored code have different licenses; retain all notices and mark deviations. Review PUBLIC-FILES.txt and run the manifest checker before publication. Dependency/security changes need separate evidence and review; never use `npm audit fix --force` as a substitute for compatibility analysis.
