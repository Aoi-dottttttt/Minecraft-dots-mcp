# Restore and reproduce

1. Verify the distribution with `sha256sum -c SHA256SUMS` before installing dependencies
2. Follow README.md or README.zh-CN.md using the two committed lockfiles
3. Build vendored code, then run all applicable offline checks
4. Use a new source/version directory rather than overwriting a running backend
5. Start only after selecting and authorizing the server, identity and intended gameplay

The archive is an allowlisted source distribution. Generated build output, dependencies, real configurations, authentication caches, worlds, runtime state, chat, queues and historical diagnostic results are excluded. Install dependencies from the npm registry or a matching trusted cache; preserve their license files.

Frontend replacement preserves the loaded backend and its fences. Updating backend files does not hot-patch a running process. Backend updates require a normal explicit new session. For rollback, stop only the new owned process and choose the previous version on a future explicit start. Do not replay old command queues or retry uncertain item operations.
