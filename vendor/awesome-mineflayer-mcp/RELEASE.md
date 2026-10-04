# Releasing & publishing

A tagged release publishes to **four** places, all driven by
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) on a `v*` tag:

| Target | Job | Auth | Result |
|---|---|---|---|
| **npm** | `publish` | OIDC trusted publishing (no secret) | `awesome-mineflayer-mcp` on npm, with provenance |
| **GHCR** (Docker) | `publish-docker` | built-in `GITHUB_TOKEN` | `ghcr.io/g0osey99/awesome-mineflayer-mcp:<version>` + `:latest` |
| **MCP Registry** | `publish-mcp` | GitHub OIDC (no secret) | `io.github.G0Osey99/awesome-mineflayer-mcp` listed |
| **Smithery** | (auto, on connect) | Smithery ↔ GitHub | reads [`smithery.yaml`](smithery.yaml) |

## One-time setup (per repo/account)

1. **npm trusted publishing.** On npmjs.com → the package's **Settings → Trusted Publishing**, add a GitHub Actions publisher: repo `G0Osey99/awesome-mineflayer-mcp`, workflow `ci.yml`. (First publish of a brand-new name may need a manual `npm publish` once — see Manual fallback.) Requires npm CLI ≥ 11.5.1 and Node ≥ 22.14 (the workflow installs `npm@latest`).
2. **MCP Registry namespace.** The `io.github.G0Osey99/*` namespace is authorized automatically for Actions running in a repo owned by that GitHub account. The namespace uses your GitHub login with its **exact casing** (`G0Osey99`, not lowercased) — it must match in `server.json` `name`, `package.json` `mcpName`, and the Dockerfile label, all three identical and case-sensitive. (Note: this is *different* from the GHCR image path `ghcr.io/g0osey99/…`, which GHCR lowercases.)
3. **GHCR.** Nothing to configure; the workflow pushes with `GITHUB_TOKEN` (`packages: write`). After the first push, optionally set the GHCR package to **public** (GitHub → your packages → Package settings).
4. **Smithery.** Sign in at [smithery.ai](https://smithery.ai) with GitHub and **add/connect this repo**; Smithery reads `smithery.yaml`.

## Cut a release

```bash
# 1. Pick the version and let `npm version` bump everything in sync
npm version minor          # or patch / major — updates package.json AND (via the
                           # `version` script) src/config.ts + server.json, and commits

# 2. Refresh the generated catalog + sanity-check, then amend if it changed
npm run docs:tools && npm run lint && npm run typecheck && npm test && npm run build
git add docs/TOOLS.md CHANGELOG.md && git commit --amend --no-edit   # if anything changed

# 3. Push the commit and the tag — this triggers all four publishers
git push --follow-tags
```

> Update the `## [x.y.z]` section in [`CHANGELOG.md`](CHANGELOG.md) before tagging.
> `npm version` already created the `vX.Y.Z` tag; `--follow-tags` pushes it.

## Verify after the workflow runs

- **npm:** `npm view awesome-mineflayer-mcp version` shows the new version.
- **MCP Registry:** `curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=awesome-mineflayer-mcp"` lists it.
- **GHCR:** the package appears under the repo's *Packages*; `docker pull ghcr.io/g0osey99/awesome-mineflayer-mcp:<version>`.
- **Smithery:** the server page shows the new version.

## Manual fallback (if a CI job fails)

```bash
# npm (needs an automation token, or run where trusted publishing is configured)
npm publish

# MCP Registry (local): install mcp-publisher from its GitHub releases, then
mcp-publisher login github          # device/browser login
mcp-publisher publish               # reads ./server.json

# GHCR
docker build -t ghcr.io/g0osey99/awesome-mineflayer-mcp:$(node -p "require('./package.json').version") .
echo $CR_PAT | docker login ghcr.io -u G0Osey99 --password-stdin
docker push ghcr.io/g0osey99/awesome-mineflayer-mcp:<version>
```

## Notes

- **Version sync.** `package.json` is the source of truth; `npm version` propagates
  it to `src/config.ts` (`SERVER_VERSION`) and `server.json` via
  `scripts/sync-version.mjs`. The `publish-mcp` job also re-derives `server.json`'s
  version from the git tag as a safety net.
- **MCP Registry is in preview** — data resets / breaking changes are possible; re-run the tag if a publish flakes (npm/GHCR propagation can lag the registry's ownership check).
- **Optional: list the Docker image in the registry too.** Add an `oci` package
  entry to `server.json` (`identifier: ghcr.io/g0osey99/awesome-mineflayer-mcp:<version>`,
  `transport: { type: stdio }`); ownership is already proven by the
  `io.modelcontextprotocol.server.name` label in the [`Dockerfile`](Dockerfile).
  Keep its tag in sync with the release. If the registry publish fails OCI
  validation, drop the entry and publish npm-only.
