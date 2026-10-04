# Persistent game session and restartable MCP frontend

The runtime now has three independent lifetimes:

1. An optional user-supplied local authentication bridge has its own lifetime
2. The game daemon owns one configured Mineflayer backend and its original connection
3. A replaceable MCP stdio frontend attaches to that daemon over a private Unix socket

The frontend never creates, restarts or reconnects a game backend. Closing a
controller, replacing its MCP process or updating frontend-only code preserves
the existing backend session. It first stops movement and continuous actions.
There is one controller at a time. A replacement cannot submit new work until
old work and cancellation cleanup settle. Game physics continues, so MCPBot can
still be hurt, drown, fall or be disconnected by server rules while unattended.

## Starting and attaching

A first game session must still be started through the existing explicit user
Start flow. The daemon consumes a loopback server/bridge port and non-secret username, not credentials:

```sh
node runtime/minecraft-daemon.mjs --user-started-session PORT --username ExampleBot --state-dir PRIVATE_GAME_DIR
```

Do not run this manually against a live bridge as a test or an implicit restart.
For an already started daemon, a replacement MCP frontend is attach-only:

```sh
node runtime/minecraft-frontend.mjs --attach PRIVATE_GAME_DIR
```

The private file-queue controller wraps that frontend and always uses a new
controller directory. Old controller queues are never reused:

```sh
node runtime/minecraft-client.mjs --attach PRIVATE_GAME_DIR --state-dir FRESH_CONTROLLER_DIR
python3 runtime/call.py --state-dir FRESH_CONTROLLER_DIR get-controller-status
```

No shell argument contains credentials. Socket and state directory ownership
and permissions are checked. This feature creates no new TCP listener; its private Unix socket is local IPC.

## What can update without leaving

Frontend routing, queue handling and MCP presentation code can be replaced and
reattached while the existing game backend remains alive. The backend reports
its actual loaded version and process/session identity independently from the
frontend version. A new frontend does not imply new gameplay code is loaded.

Mineflayer, inventory authority, action implementation and other loaded backend
code are not hot-patched. Changes there may still require a normal user-triggered
session restart. Existing fences and uncertain operations are never unlocked
by attaching a fresh frontend. Replacing the daemon itself ends the game.

## No replay and explicit quit

The daemon records call request IDs for its session lifetime. Reusing the same
ID with different arguments is rejected; a finished identical ID returns its
stored outcome. Pending or uncertain work is never run again. Controller death
does not authorize retry. If a controller's response was lost, inspect status
and the original request outcome rather than enqueueing a new equivalent action.
Dedupe state is bounded and fails closed instead of silently evicting old IDs.

Disconnect-player and the launcher's Stop MCPBot explicitly end gameplay. Controller
detach/close does not. After a real logout, backend failure, kick or server
connection loss, no automatic reconnect occurs. A new explicit user Start is
required. An ended daemon can remain inspectable, but cannot recreate its game.

## Offline evidence and limits

The full verify suite includes private IPC lifecycle/race tests and a synthetic
Minecraft protocol-767 server. Tests must establish that the same actual game
connection survives frontend replacement, control stops on loss, a second
controller cannot act, no uncertain call is replayed, and genuine disconnect
never reconnects. See VALIDATION.json for the checks completed for this release.
Synthetic vanilla protocol evidence is not proof of a real modded server's
behavior or that an existing live session has been migrated.

## Optional Linux Start window

The native launcher requires an existing separately authorized bridge program. The bridge CLI must accept `--config PATH --proxy-from-env --port 0` and emit a JSON listening event with its chosen loopback port on stdout. That integration is external and not bundled. Use the direct daemon flow in README.md for an authorized local server.

```sh
runtime/open.sh --config /absolute/path/to/private-config.json \
  --bridge /absolute/path/to/bridge.cjs --username ExampleBot \
  --relay-label relay.example.invalid
```

Replace the example label with the intended service label. Opening the window validates paths but does not read credentials or create a network connection. Only clicking Start runs the supplied bridge and creates one new daemon. The launcher uses Linux process identity and pidfd checks to stop only its verified owned processes. It requires Python/Tk and is not a macOS/Windows launcher. Default state is under `$XDG_STATE_HOME/minecraft-mcp`, or `~/.local/state/minecraft-mcp`.
