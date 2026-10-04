# Runtime compatibility contract

Target: Minecraft Java 1.21.1, protocol 767, offline protocol identity through an authorized local server/bridge. Other versions, modded layouts, plugins and authentication routes are not certified by this candidate.

## Independent versions

- Package/backend version: currently 3.1.1-rc.1
- Frontend/controller version: currently 3.1.1-rc.1
- Local IPC protocol version: 1, checked during attachment
- Tool schemas: CAPABILITIES.json, regenerated from the networkless fixture

The backend reports its actual loaded version, process and session identity. A new frontend can attach only to a compatible IPC session. Updating frontend files never hot-patches Mineflayer, action code or inventory authority already loaded in the backend. Backend changes require an explicit new session.

The initial generic candidate renames runtime paths and private namespace fields. It is not promised to attach to older personalized controller state. Start a fresh approved session for the generic release; never migrate old queues or clone runtime state between players.

## Frontend transport failures

Once the frontend attempts to write a `call` to the daemon, a transport error,
invalid-JSON/oversized frame, timeout or connection close before a complete
response leaves the outcome unknown. The tool error reports `uncertain: true`
and `automaticRetry: false`, and the file-queue controller fences later actions.
This does not assert that the backend executed the call. Explicit daemon
rejections retain their reported uncertainty; local validation or frame-encoding
failures before dispatch remain `uncertain: false`. Read-only IPC status/list
failures do not acquire a gameplay uncertainty flag merely because a call was
pending on the same socket.

This is a conservative frontend error-classification fix within IPC version 1;
tool schemas, backend code and existing backend fences are unchanged. It does
not reconnect, replay requests, restart a backend or update a running session.

## Change policy

Schema or semantic changes require a documented compatibility decision, regression fixture and maintainer review. Breaking tool/IPC contracts require a version boundary and migration notes. Do not infer compatibility solely from matching tool names or package version. The public candidate is 3.1.1-rc.1 so it cannot be confused with the historical base.

## Verification boundaries

Aliases increase catalog size without adding independent abilities. Offline protocol tests establish synthetic behavior only. Boat placement/riding, full tool catalog behavior and real-server/plugin compatibility remain unvalidated. Publish only the exact test scope observed.
