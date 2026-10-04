# Contributing

Thanks for your interest in improving **awesome-mineflayer-mcp**!

## Development setup

```bash
git clone https://github.com/G0Osey99/awesome-mineflayer-mcp.git
cd awesome-mineflayer-mcp
npm install
npm run typecheck    # tsc --noEmit (strict)
npm test             # vitest — pure-logic unit tests
npm run dev          # run from source (tsx), no build step
```

### A Minecraft server to test against

The bot needs something to connect to. The repo ships a one-command offline-mode
server via Docker:

```bash
docker compose up -d        # offline 1.20.4 server on localhost:25565
docker compose logs -f      # wait for "Done"
```

Then, from your MCP client, `connect_bot { host: "localhost", username: "DevBot", auth: "offline" }`.
Tear it down with `docker compose down -v`. For deterministic read-only checks,
seed the world per [`eval/fixture.md`](eval/fixture.md).

For `get_screenshot`, the optional renderer packages (`prismarine-viewer`,
`playwright-core`) install by default; you just need a browser — have Chrome/Edge
installed, or run `npx playwright install chromium`.

## Project layout

```
src/
  index.ts        entry (stdio transport, graceful shutdown, crash guards)
  server.ts       builds the McpServer: registers tool groups, resources, prompts
  config.ts       env + constants + safety policy (groups, read-only, command/host allow-lists)
  bot/            manager (lifecycle FSM), plugins, events, wire-events, state, windows, action-locks
  tools/          one module per tool group (+ registry.ts)
  prompts/        guided multi-tool workflows
  resources/      MCP resources + push notifications
  util/           errors, format, result, resolve (name→id + fuzzy), serialize, async, redact
  schemas/        shared Zod fragments
```

## Adding a tool

Tools live in a `src/tools/<group>.ts` module that exports a `register<Group>(reg)`
function. Use [`src/tools/look.ts`](src/tools/look.ts) as a minimal template. Each
tool is one `reg({ ... })` call:

```ts
reg({
  name: "my_tool",                 // unique snake_case name
  group: "look",                   // group key for MCP_DISABLE_GROUPS
  description: "What it does, its params, what it returns, and the errors it can raise.",
  inputSchema: {                   // a RAW Zod shape — { x: z.number() }, NOT z.object(...)
    target: z.string().describe("..."),
  },
  annotations: { title: "My tool", readOnlyHint: true /* destructiveHint / idempotentHint */ },
  timeoutMs: DEFAULT_ACTION_TIMEOUT_MS, // OPTIONAL: only for single round-trip awaits with no
                                        // internal timeout — NOT for long-running, self-cancelling actions
  handler: (args, ctx) => {
    const bot = ctx.manager.requireBot();      // throws NOT_CONNECTED if offline
    // ... resolve names via util/resolve, do the work ...
    return { ok: true };                        // returned value becomes text + structuredContent
  },
});
```

Guidelines:

- **Names, not objects.** Accept human names (`"diamond_ore"`, `"zombie"`) and resolve
  them with `resolveBlock` / `resolveItem` / `resolveEntityType` (they raise `UNKNOWN_NAME`
  with fuzzy suggestions). Never take prismarine objects or JS predicates.
- **Errors.** Throw `ToolError(code, message, suggestions?)` — the registry converts it to a
  stable `isError` result. Don't throw raw strings.
- **Long-running actions** should take an `ActionLocks` handle (`ctx.locks.begin(name, onCancel?)`),
  honour `h.signal.aborted`, and `h.release()` in a `finally`.
- **Mark read tools** with `annotations.readOnlyHint: true` so they survive `MCP_READ_ONLY` mode
  and clients can auto-approve them.
- Register the new group's `register<Group>` in [`src/server.ts`](src/server.ts) and add it to the
  README catalog.

## Before opening a PR

- `npm run typecheck` and `npm test` must pass.
- Add/adjust unit tests for pure logic you touched (see `test/`).
- Keep stdout clean — it is the MCP protocol channel. Log to **stderr** only.

## Conventions

- TypeScript strict, ESM (`.js` import specifiers), Node ≥ 20.
- Match the surrounding style; keep handlers small and push shared logic into `bot/` or `util/`.
