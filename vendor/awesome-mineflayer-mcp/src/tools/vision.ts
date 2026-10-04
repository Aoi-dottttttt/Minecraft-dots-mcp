/** Vision: render what's around the bot as an image an LLM (or human) can see. */

import { z } from "zod";
import type { Registrar } from "./registry.js";
import { imageResult } from "../util/result.js";
import { encodePNG } from "../util/png.js";
import { renderArea } from "../bot/render.js";
import { captureScreenshot } from "../bot/screenshot.js";
import {
  SCREENSHOT_WIDTH,
  SCREENSHOT_HEIGHT,
  SCREENSHOT_LOAD_MS,
  VIEW_DISTANCE,
} from "../config.js";

export function registerVision(reg: Registrar): void {
  reg({
    name: "get_screenshot",
    group: "vision",
    description:
      "Capture a REAL screenshot of what the bot actually sees — the textured 3D Minecraft world from its eyes (first person) or an orbit view (third person) — as a PNG image. This is an actual game render, not a schematic. " +
      "Requires the optional screenshot extras (prismarine-viewer + a headless browser via Playwright); if they're missing it returns UNSUPPORTED with install steps. The bot must be in loaded chunks. First call is slower (launches the renderer/browser).",
    inputSchema: {
      width: z.number().int().min(64).max(1920).optional().describe(`Image width in px (default ${SCREENSHOT_WIDTH})`),
      height: z.number().int().min(64).max(1080).optional().describe(`Image height in px (default ${SCREENSHOT_HEIGHT})`),
      firstPerson: z
        .boolean()
        .optional()
        .describe("First-person from the bot's eyes (default true); false = third-person orbit"),
      waitMs: z
        .number()
        .int()
        .min(0)
        .max(15000)
        .optional()
        .describe(`Time to let the world render before capturing, in ms (default ${SCREENSHOT_LOAD_MS})`),
      viewDistance: z.number().int().min(2).max(12).optional().describe(`Chunk render distance (default ${VIEW_DISTANCE})`),
    },
    annotations: { readOnlyHint: true, title: "Get screenshot" },
    timeoutMs: 60_000,
    handler: async (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const width = args.width ?? SCREENSHOT_WIDTH;
      const height = args.height ?? SCREENSHOT_HEIGHT;
      const firstPerson = args.firstPerson !== false;
      const png = await captureScreenshot(bot, {
        width,
        height,
        firstPerson,
        waitMs: args.waitMs ?? SCREENSHOT_LOAD_MS,
        viewDistance: args.viewDistance ?? VIEW_DISTANCE,
      });
      const alt =
        `${firstPerson ? "First-person" : "Third-person"} screenshot (${width}×${height}) of the bot's actual view ` +
        `at the current position. Real textured Minecraft render.`;
      return imageResult(png.toString("base64"), "image/png", alt);
    },
  });

  reg({
    name: "render_map",
    group: "vision",
    description:
      "Render a colored top-down map (or a horizontal cross-section) of the area around the bot as a PNG image — a lightweight schematic overview (no extra dependencies). For a real textured first-person game render, use `get_screenshot` instead. " +
      "North (−Z) is up, West (−X) is left. The bot is the white dot in the center with a dark facing tick; players are cyan, hostile mobs red, passive mobs yellow, items grey. " +
      'mode "surface" (default) shows the topmost block of each column with height shading; mode "slice" shows a single Y layer (great for caves/mining — air reads light, walls dark). ' +
      "Returns the image plus a text legend of the block types shown.",
    inputSchema: {
      center: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .optional()
        .describe("Center of the map (defaults to the bot's position)"),
      radius: z.number().int().min(2).max(64).optional().describe("Blocks from center to each edge (default 24)"),
      mode: z.enum(["surface", "slice"]).optional().describe('"surface" top-down (default) or "slice" single-layer'),
      sliceY: z.number().int().optional().describe("Y layer for mode:slice (defaults to the bot's feet level)"),
      includeEntities: z.boolean().optional().describe("Overlay nearby entities as colored dots (default true)"),
      maxDim: z.number().int().min(64).max(768).optional().describe("Max image width/height in pixels (default 480)"),
    },
    annotations: { readOnlyHint: true, title: "Render map" },
    handler: (args, ctx) => {
      const bot = ctx.manager.requireBot();
      const pos = bot.entity?.position;
      const center = args.center ?? {
        x: pos?.x ?? 0,
        y: pos?.y ?? 64,
        z: pos?.z ?? 0,
      };
      const mode = args.mode ?? "surface";
      const sliceY = args.sliceY ?? Math.floor(center.y);
      // Surface mode scans a vertical column per cell (CPU-heavy and synchronous),
      // so cap its radius; slice mode is one blockAt per cell and can go wider.
      const SURFACE_MAX = 40;
      const requested = args.radius ?? 24;
      const radius = mode === "surface" ? Math.min(requested, SURFACE_MAX) : requested;
      const clamped = radius !== requested;

      const r = renderArea(bot, {
        center,
        radius,
        maxDim: args.maxDim ?? 480,
        mode,
        sliceY,
        includeEntities: args.includeEntities !== false,
      });

      const png = encodePNG(r.width, r.height, r.rgba);
      const base64 = png.toString("base64");

      const cx = Math.floor(center.x);
      const cz = Math.floor(center.z);
      const alt =
        `${mode === "slice" ? `Slice at Y=${sliceY}` : "Top-down surface map"} centered at ` +
        `(${cx}, ${Math.floor(center.y)}, ${cz}), radius ${radius} blocks ` +
        `(${r.cells}×${r.cells} blocks, ${r.scale}px each, ${r.width}×${r.height}px). ` +
        `North is up. Bot = white center dot. ` +
        (clamped ? `(radius clamped to ${radius} for surface mode; use mode:"slice" for a wider view.) ` : "") +
        (r.legend.length ? `Blocks shown: ${r.legend.slice(0, 40).join(", ")}.` : "No loaded blocks in range (move or wait for chunks).");

      return imageResult(base64, "image/png", alt);
    },
  });
}
