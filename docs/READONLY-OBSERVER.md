# Local read-only observer

The opt-in observer shares the guarded backend's **existing bot**. It never creates a second game connection. It provides a status/inventory dashboard and Prismarine's real-time reconstructed 3D view. It is not a native Minecraft client screenshot.

## Explicit startup

When starting a **new authorized session**, add `--observe-port 3100` to the daemon command:

```sh
node runtime/minecraft-daemon.mjs --user-started-session 25565 \
  --username ExampleBot --state-dir "$GAME_DIR" --observe-port 3100
```

Open `http://127.0.0.1:3100/` on the same computer. `--observe-port 0` chooses a free local port; read the actual URL from `get-session-status` under `observer.url`. Without the flag, no HTTP observer is started. An occupied port or observer initialization failure is reported as `observer.error: observer_start_failed`; it starts no alternative listener and does not disconnect the already-started game backend. The flag is also accepted by the direct backend entry for offline fixtures. Existing backends are not hot-upgraded or restarted.

There is deliberately no bind-address, authentication, reverse-proxy or remote-publication option. The server binds only IPv4 `127.0.0.1` and checks the exact host and same-origin browser requests, including websocket upgrades and polling. `localhost` is not the advertised origin. Do not publish or forward this unauthenticated port. Trusted-local-process access is within the existing security model; this is not protection from same-user malware.

## Read-only and privacy boundaries

- The dashboard returns allowlisted health, food, oxygen, location, dimension and time, plus server-authoritative inventory/window slots and boolean fence status
- Slots expose ordinary item identifiers, counts and durability, not NBT, custom names, book pages, chat, window titles or complete runtime status
- It never reads connection configuration, credentials, filesystem state, game logs or private assistant data
- 3D reconstructs already-loaded world chunks and nearby entities; player usernames and skins are omitted from emitted entity observations. Block-entity NBT (including signs/container contents) is removed before transmission. It cannot see unloaded chunks
- Browser controls can change only the local camera. Upstream camera mouse events are ignored and other application events disconnect the client; no mouse-click raycast, movement, inventory click, chat or MCP action is connected to browser input
- Four concurrent 3D clients and a two-chunk view radius limit resource use. Disconnect, dimension change and shutdown remove the observer's game listeners
- HTTP offers only reads. Socket.IO's polling POSTs carry its read-only transport protocol and cannot dispatch gameplay
- Missing textures show item names. Unsupported or not-yet-confirmed window states are labeled rather than filled from optimistic client inventory

The browser may retain already displayed game data in memory. Do not share screenshots or the page with others without the player's authorization.

## Ecosystem reuse and reviewed exclusions

`prismarine-viewer@1.33.0` supplies the renderer, packaged texture/model bundles, workers and `WorldView`; `minecraft-assets@1.17.0` supplies 1.21.1 inventory textures. Both are PrismarineJS ecosystem packages. The first-party adapter imports `WorldView` directly and owns the loopback HTTP lifecycle. It does not call upstream's convenience `mineflayer()` server, whose current implementation listens without a host restriction. No native canvas/headless renderer or screenshot API is loaded. The pinned worker bundles AJV/ProtoDef schema compilation and requires string code generation; only its own HTTP response permits CSP `unsafe-eval`, with network access disabled. The dashboard and viewer document retain their no-eval CSP.

`mineflayer-web-inventory@1.8.5` was reviewed but is **not installed or started**. Its published package lacks the compiled UI and runs another npm install in an installation hook. The reviewed server also shallow-copies unsupported window items and has mismatched disconnect listeners. This project instead provides a small read-only inventory/status interface over its existing authoritative inventory frames and official assets. It does not claim to have enabled that package or every upstream inventory layout.

Dependencies are locked and installed with `npm ci --ignore-scripts`. The published viewer already contains its browser bundle; no upstream prepare/build lifecycle is needed.

## Verification

`tests/readonly-observer.test.ts` tests snapshots, origin/host/method restrictions, static assets, websocket and polling transport, rejected application input, connection limits and listener cleanup. `npm run test:observer` verifies explicit flag startup/status/shutdown with the networkless fake backend. `npm run test:observer-worker` executes the exact pinned worker against a neutral 1.21.1 chunk and verifies nonempty geometry without a browser. `npm run test:observer-browser` runs Chromium against a synthetic grass-block world, checks the dashboard after reload, checks textured 3D pixels and navigates back; it never connects to Minecraft.

The browser check runs in the dedicated hosted CI job because some local execution environments prohibit Chromium's Unix sockets. See `VALIDATION.json` and exact-commit CI for observed results; an HTTP fixture pass alone is not visual or real-server acceptance.
