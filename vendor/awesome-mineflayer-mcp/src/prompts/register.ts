/**
 * MCP Prompts — discoverable, parameterized guided workflows.
 *
 * Tools are the *verbs*; prompts are the *playbooks* that teach an agent how to
 * chain them for a concrete goal. Clients surface these as slash-commands /
 * pickable templates, so the knowledge of "observe → act → verify" lives at the
 * point of use instead of only in the server's instructions string.
 *
 * Each prompt returns a single user-role message: drop-in guidance the agent
 * then executes with the real tools.
 */

import { z } from "zod";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import type { ToolContext } from "../context.js";

/** A completion callback that suggests block/item names from the connected world. */
function nameCompleter(ctx: ToolContext, kind: "block" | "item") {
  return (value: string | undefined): string[] => {
    const bot = ctx.manager.botOrNull();
    const reg = (bot as unknown as { registry?: Record<string, Record<string, unknown>> })?.registry;
    const table = reg?.[kind === "block" ? "blocksByName" : "itemsByName"];
    if (!table) return [];
    const q = (value ?? "").trim().toLowerCase();
    const names = Object.keys(table);
    const matches = q
      ? names.filter((n) => n.includes(q)).sort((a, b) => {
          const as = a.startsWith(q) ? 0 : 1;
          const bs = b.startsWith(q) ? 0 : 1;
          return as - bs || a.length - b.length;
        })
      : names;
    return matches.slice(0, 100);
  };
}

function userText(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerPrompts(ctx: ToolContext): void {
  const server = ctx.server;

  server.registerPrompt(
    "getting_started",
    {
      title: "Getting started",
      description: "Orientation for driving the Mineflayer bot: how to connect, observe, act, and recover.",
    },
    () =>
      userText(
        [
          "You are controlling a single Minecraft bot through this MCP server. Follow this loop:",
          "",
          "1. CONNECT (if needed). Call `get_connection_status` first — a default account may already be auto-connected. If status is `disconnected`, call `connect_default` (configured account) or `connect_bot { host, username, auth }`. After connecting, call `wait_for_chunks_to_load` before acting.",
          "2. OBSERVE. Use `get_observation` for a one-call snapshot (vitals, position, hotbar, nearby entities, and new events). Or compose `get_state`, `get_inventory`, `list_entities`, and `get_events`. When polling `get_events`, pass the returned `nextSince` each time so you only see new events; `dropped:true` means the buffer overflowed.",
          "3. ACT. Movement: `goto`. Mining/gathering: `collect_block` (handles pathfinding + tool-select + pickup). Single blocks: `dig` / `place_block`. Crafting: `list_recipes` then `craft_item`. Combat: `pvp_attack`. Talk: `chat`.",
          "4. NAMES. Block/item/entity arguments take human names like `oak_log`, `diamond_pickaxe`, `zombie`. A wrong name returns fuzzy suggestions — read them and retry.",
          "5. RECOVER. Long actions (goto, dig, collect_block, pvp_attack, fish, smelt_item, craft_item) are mutually exclusive and cancellable: start a new one to supersede, or call `stop_pathfinding` / `pvp_stop` / `cancel_collect` / `cancel_task`. On a typed error (NO_PATH, MISSING_TOOL, NOT_CONNECTED, …) read the suggestions and adjust.",
          "",
          "Prefer a few high-level tools (collect_block, goto, craft_item) over many low-level ones. Re-observe after each significant action before deciding the next.",
        ].join("\n"),
      ),
  );

  server.registerPrompt(
    "gather_wood",
    {
      title: "Gather wood",
      description: "Find nearby trees and collect logs.",
      argsSchema: {
        count: z.string().optional().describe("How many logs to collect (default 16)"),
        logType: completable(
          z.string().optional().describe('Specific log, e.g. "oak_log" (default: any *_log)'),
          nameCompleter(ctx, "block"),
        ),
      },
    },
    (args) => {
      const count = args.count?.trim() || "16";
      const target = args.logType?.trim()
        ? `the block "${args.logType.trim()}"`
        : 'logs (try ["oak_log","birch_log","spruce_log","jungle_log","acacia_log","dark_oak_log","mangrove_log","cherry_log"])';
      return userText(
        [
          `Goal: collect ${count} ${args.logType?.trim() ? args.logType.trim() : "logs"}.`,
          "",
          `1. Observe with \`get_observation\`. 2. \`find_blocks\` for ${target} within ~64 blocks to confirm trees are nearby. 3. Call \`collect_block { target: <log name or list>, count: ${count} }\` — it pathfinds, auto-equips an axe (or punches), mines, and picks up drops.`,
          "If it returns NO_PATH, move closer with `goto` or pick a different tree from `find_blocks`. If inventory fills, set `chestLocations`/`depositItems` or `toss_item` junk. Report how many logs you ended with via `get_inventory`.",
        ].join("\n"),
      );
    },
  );

  server.registerPrompt(
    "mine_to_diamonds",
    {
      title: "Mine to diamonds",
      description: "Descend safely and branch-mine at diamond depth.",
      argsSchema: {
        targetY: z.string().optional().describe("Y level to mine at (default -59 for 1.18+, the diamond-rich layer)"),
      },
    },
    (args) => {
      const y = args.targetY?.trim() || "-59";
      return userText(
        [
          `Goal: reach Y=${y} and find diamonds.`,
          "",
          "1. Check inventory for a pickaxe (iron or better mines diamond) with `get_inventory`; craft one first if missing (`list_recipes`, `craft_item`).",
          `2. Descend with a safe staircase rather than straight down: repeatedly \`dig\` the block ahead-and-down and step in, OR \`goto { goalType:"y", y:${y} }\` and let the pathfinder route. Never dig the block directly under you (fall/lava risk).`,
          `3. At Y=${y}, branch-mine: dig 1×2 tunnels, leaving gaps between branches. Use \`find_blocks { matching:"diamond_ore" }\` and \`collect_block { target:"diamond_ore" }\` whenever ore is in range.`,
          "4. Watch `get_state` health/food and `get_events` for `entityHurt`/lava; keep torches/cobblestone; retreat and eat (`autoeat_eat`) if health drops.",
        ].join("\n"),
      );
    },
  );

  server.registerPrompt(
    "build_shelter",
    {
      title: "Build a shelter",
      description: "Enclose a small safe space before nightfall.",
      argsSchema: {
        material: completable(
          z.string().optional().describe('Block to build with, e.g. "cobblestone" (default: whatever you have most of)'),
          nameCompleter(ctx, "item"),
        ),
      },
    },
    (args) => {
      const mat = args.material?.trim();
      return userText(
        [
          "Goal: build a small enclosed shelter (walls + roof + a door or torch).",
          "",
          `1. Pick a build material${mat ? ` (${mat})` : " — check `get_inventory` for your most plentiful solid block"} and ensure you have ~30+ of it; gather/craft more if short.`,
          "2. Stand on flat ground (`get_state` for position). Place a ring of walls 2 blocks high around a 3×3 area using `place_block` against existing block faces, then roof it over. Leave one block for a door.",
          "3. Equip and place a `door` (or just seal the gap and place a `torch` inside for light). Verify with `get_block_at` that the enclosure has no gaps a mob could path through.",
          "If `place_block` fails (no reference face / occupied), reposition with `goto` and target a different adjacent face.",
        ].join("\n"),
      );
    },
  );

  server.registerPrompt(
    "find_and_smelt",
    {
      title: "Find and smelt",
      description: "Mine an ore (or gather an input) and smelt it in a furnace.",
      argsSchema: {
        input: completable(
          z.string().describe('What to smelt, e.g. "raw_iron" or "iron_ore"'),
          nameCompleter(ctx, "item"),
        ),
        fuel: completable(
          z.string().optional().describe('Fuel to use, e.g. "coal" (default: coal/charcoal in inventory)'),
          nameCompleter(ctx, "item"),
        ),
      },
    },
    (args) => {
      const input = args.input?.trim() || "raw_iron";
      const fuel = args.fuel?.trim() || "coal";
      return userText(
        [
          `Goal: smelt ${input} into its product.`,
          "",
          `1. Make sure you have ${input} (mine it with \`collect_block\` / \`dig\` if it's an ore) and fuel (${fuel}).`,
          "2. Locate a furnace with `find_blocks { matching:\"furnace\" }`, or craft+place one. Then call `smelt_item` — it opens the furnace, loads fuel+input, waits for progress, and collects the output. (Or drive it manually: `open_furnace`, `furnace_action`, `furnace_status`.)",
          "3. `smelt_item` is cancellable via `cancel_task`. Confirm the result with `get_inventory`.",
        ].join("\n"),
      );
    },
  );

  server.registerPrompt(
    "follow_and_defend",
    {
      title: "Follow and defend",
      description: "Follow a player and fight off hostile mobs near them.",
      argsSchema: {
        player: z.string().describe("Username of the player to follow and protect"),
      },
    },
    (args) => {
      const player = args.player?.trim() || "<player>";
      return userText(
        [
          `Goal: follow ${player} and keep them safe.`,
          "",
          `1. Find them: \`find_nearest_entity { username:"${player}" }\` to get an entityId. 2. \`follow_entity { entityId, range: 2 }\` to tail them dynamically.`,
          "3. Enable survival automation: `autoeat_set_enabled { enabled: true }` and `armor_equip_all`.",
          `4. Loop on \`get_events\`/\`list_entities\`: when a hostile mob (kind "Hostile mobs") is within ~8 blocks of ${player}, \`pvp_attack { entityId }\` it, then resume following. Disengage with \`pvp_stop\` once clear.`,
          "Keep checking your own `get_state` health and eat as needed.",
        ].join("\n"),
      );
    },
  );
}
