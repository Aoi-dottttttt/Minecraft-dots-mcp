# Local distribution changes

The upstream TypeScript source, tests, license and attribution are retained from commit 89a407ca18a4a39196c6ebe726d5208cff88a9e5. This guarded distribution changes package.json and package-lock.json for dependency hardening:

- MCP SDK and compatible transitive packages use patched, locked versions
- Development-only Vitest is pinned to 4.1.11, with its supported Vite dependency
- Optional prismarine-viewer and playwright-core dependencies are omitted because the guarded entrypoint already excludes get_screenshot

The vendored standalone screenshot feature therefore has no bundled optional renderer and is outside the supported guarded-runtime surface. The upstream loader reports missing extras if invoked. No upstream source is silently patched. Do not reinstall extras or change dependencies without a separate dependency/security review. See the root SECURITY.md and README.md for supported entrypoints and residual advisories.
