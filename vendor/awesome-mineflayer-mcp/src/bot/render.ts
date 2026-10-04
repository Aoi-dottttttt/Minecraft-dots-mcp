/**
 * Build a top-down (or horizontal-slice) colored map of the area around the bot
 * from the block data it already has, plus entity markers. Output is a raw RGBA
 * raster that util/png.ts turns into a PNG — so a vision-capable LLM (and a human)
 * can literally see the bot's surroundings without any native rendering deps.
 */

import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";

type RGB = [number, number, number];

/** Exact block-name → color overrides (most-specific wins). */
const EXACT: Record<string, RGB> = {
  grass_block: [104, 158, 56],
  dirt: [134, 96, 67],
  coarse_dirt: [120, 85, 58],
  podzol: [90, 64, 30],
  farmland: [110, 78, 50],
  path: [120, 100, 64],
  sand: [219, 207, 163],
  red_sand: [190, 110, 50],
  gravel: [136, 126, 125],
  stone: [125, 125, 125],
  cobblestone: [122, 122, 122],
  deepslate: [80, 80, 86],
  cobbled_deepslate: [74, 74, 80],
  bedrock: [40, 40, 40],
  obsidian: [30, 22, 44],
  water: [56, 92, 196],
  lava: [222, 116, 38],
  ice: [150, 190, 235],
  packed_ice: [140, 180, 230],
  blue_ice: [120, 165, 225],
  snow: [240, 244, 250],
  snow_block: [238, 242, 248],
  netherrack: [110, 40, 40],
  soul_sand: [82, 64, 50],
  soul_soil: [76, 58, 46],
  end_stone: [220, 222, 160],
  glowstone: [240, 215, 120],
  sea_lantern: [200, 220, 215],
  coal_ore: [60, 60, 60],
  deepslate_coal_ore: [55, 55, 60],
  iron_ore: [196, 160, 130],
  deepslate_iron_ore: [150, 130, 120],
  copper_ore: [190, 120, 80],
  gold_ore: [225, 200, 90],
  deepslate_gold_ore: [200, 180, 90],
  redstone_ore: [180, 50, 50],
  deepslate_redstone_ore: [150, 45, 45],
  lapis_ore: [60, 80, 190],
  diamond_ore: [110, 220, 220],
  deepslate_diamond_ore: [100, 200, 205],
  emerald_ore: [60, 200, 110],
  ancient_debris: [90, 60, 50],
  oak_log: [120, 95, 60],
  spruce_log: [85, 62, 38],
  birch_log: [200, 195, 170],
  jungle_log: [120, 90, 55],
  acacia_log: [170, 95, 55],
  dark_oak_log: [70, 52, 32],
  crafting_table: [150, 110, 70],
  furnace: [110, 110, 110],
  chest: [160, 120, 60],
  bookshelf: [160, 130, 80],
};

const KEYWORDS: Array<[RegExp, RGB]> = [
  [/_leaves$/, [54, 110, 48]],
  [/(_log|_wood|stem|hyphae)$/, [120, 92, 56]],
  [/(_planks|_stairs|_slab|_fence|_door|_trapdoor)$/, [165, 130, 85]],
  [/_ore$/, [150, 140, 120]],
  [/(_wool|_carpet|_bed)$/, [200, 200, 200]],
  [/_concrete/, [150, 150, 160]],
  [/_terracotta/, [160, 110, 85]],
  [/_glass/, [200, 225, 235]],
  [/(deepslate|tuff|basalt|blackstone)/, [80, 80, 86]],
  [/(stone|cobble|andesite|diorite|granite|brick)/, [125, 122, 120]],
  [/(water|kelp|seagrass|coral)/, [56, 92, 196]],
  [/(grass|fern|leaf|vine|moss|lily|bamboo|sapling|flower|crop|wheat|sugar)/, [96, 150, 60]],
  [/(sand|sandstone)/, [215, 200, 155]],
  [/(wool|nylium|mycelium)/, [150, 120, 130]],
  [/(ice|snow|powder)/, [220, 235, 245]],
  [/(nether|crimson|warped|soul)/, [110, 60, 60]],
  [/(rail|iron|anvil|hopper|cauldron)/, [120, 120, 128]],
];

const AIR = new Set(["air", "cave_air", "void_air"]);

/** A solid block's map color, or null for air/unknown. */
export function blockColor(name: string | undefined | null): RGB | null {
  if (!name || AIR.has(name)) return null;
  const exact = EXACT[name];
  if (exact) return exact;
  for (const [re, rgb] of KEYWORDS) if (re.test(name)) return rgb;
  return [150, 150, 150];
}

function shade(rgb: RGB, factor: number): RGB {
  return [
    Math.max(0, Math.min(255, Math.round(rgb[0] * factor))),
    Math.max(0, Math.min(255, Math.round(rgb[1] * factor))),
    Math.max(0, Math.min(255, Math.round(rgb[2] * factor))),
  ];
}

export interface RenderOptions {
  center: { x: number; y: number; z: number };
  radius: number;
  maxDim: number;
  mode: "surface" | "slice";
  sliceY: number;
  includeEntities: boolean;
}

export interface RenderResult {
  width: number;
  height: number;
  rgba: Uint8Array;
  scale: number;
  cells: number;
  legend: string[];
}

const SKY: RGB = [175, 200, 235]; // open-to-sky / all-air column
const UNKNOWN: RGB = [40, 42, 48]; // unloaded chunk / no data

/** Render the area into an RGBA raster. North (−Z) is up; West (−X) is left. */
export function renderArea(bot: Bot, opts: RenderOptions): RenderResult {
  const r = opts.radius;
  const cells = 2 * r + 1;
  const scale = Math.max(1, Math.floor(opts.maxDim / cells));
  const width = cells * scale;
  const height = cells * scale;
  const rgba = new Uint8Array(width * height * 4);

  const cx = Math.floor(opts.center.x);
  const cz = Math.floor(opts.center.z);
  const cyTop = Math.floor(opts.center.y) + 16;
  const cyBottom = Math.floor(opts.center.y) - 24;

  const used = new Set<string>();

  // Each grid cell (gx,gz) → one color.
  for (let row = 0; row < cells; row++) {
    // row 0 is the top of the image = north (−Z).
    const wz = cz - r + row;
    for (let col = 0; col < cells; col++) {
      const wx = cx - r + col;
      let color: RGB;

      if (opts.mode === "slice") {
        const b = bot.blockAt(new Vec3(wx, opts.sliceY, wz));
        if (b === null) color = UNKNOWN;
        else {
          const c = blockColor(b.name);
          color = c ?? [225, 228, 235]; // air at this layer = light (walkable)
          if (c) used.add(b.name);
        }
      } else {
        // surface: topmost solid block within the vertical window.
        let found: RGB | null = null;
        let anyLoaded = false;
        for (let y = cyTop; y >= cyBottom; y--) {
          const b = bot.blockAt(new Vec3(wx, y, wz));
          if (b === null) continue;
          anyLoaded = true;
          const c = blockColor(b.name);
          if (c) {
            const rel = (y - opts.center.y) / 24; // height relief
            found = shade(c, Math.max(0.62, Math.min(1.18, 1 + rel * 0.35)));
            used.add(b.name);
            break;
          }
        }
        color = found ?? (anyLoaded ? SKY : UNKNOWN);
      }

      // Paint the scale×scale cell.
      for (let py = 0; py < scale; py++) {
        const yy = row * scale + py;
        for (let px = 0; px < scale; px++) {
          const xx = col * scale + px;
          const i = (yy * width + xx) * 4;
          rgba[i] = color[0];
          rgba[i + 1] = color[1];
          rgba[i + 2] = color[2];
          rgba[i + 3] = 255;
        }
      }
    }
  }

  const putDot = (wx: number, wz: number, rgb: RGB, rPx: number): void => {
    const ccol = Math.round((wx - (cx - r)) * scale + scale / 2);
    const crow = Math.round((wz - (cz - r)) * scale + scale / 2);
    for (let dy = -rPx; dy <= rPx; dy++) {
      for (let dx = -rPx; dx <= rPx; dx++) {
        if (dx * dx + dy * dy > rPx * rPx) continue;
        const xx = ccol + dx;
        const yy = crow + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const i = (yy * width + xx) * 4;
        rgba[i] = rgb[0];
        rgba[i + 1] = rgb[1];
        rgba[i + 2] = rgb[2];
        rgba[i + 3] = 255;
      }
    }
  };

  if (opts.includeEntities) {
    const selfId = bot.entity?.id;
    for (const e of Object.values(bot.entities) as Array<{
      id: number;
      type?: string;
      kind?: string;
      position?: { x: number; y: number; z: number };
    }>) {
      if (!e || e.id === selfId || !e.position) continue;
      const wx = Math.floor(e.position.x);
      const wz = Math.floor(e.position.z);
      if (Math.abs(wx - cx) > r || Math.abs(wz - cz) > r) continue;
      let rgb: RGB = [230, 230, 230];
      const kind = (e.kind ?? "").toLowerCase();
      if (e.type === "player") rgb = [80, 220, 255];
      else if (kind.includes("hostile")) rgb = [235, 60, 60];
      else if (e.type === "mob" || kind.includes("passive") || kind.includes("animal")) rgb = [240, 220, 70];
      else if (e.type === "object" || e.type === "item") rgb = [220, 220, 220];
      putDot(wx, wz, rgb, Math.max(1, Math.floor(scale / 3)));
    }
  }

  // The bot itself, at center, white with a facing tick.
  putDot(cx, cz, [255, 255, 255], Math.max(1, Math.floor(scale / 2)));
  const yaw = bot.entity?.yaw ?? 0;
  // mineflayer's bot.entity.yaw (converted from Notchian): 0 → −Z (north),
  // increasing toward −X (west). Horizontal view dir = (−sin(yaw), −cos(yaw)),
  // matching mineflayer's getViewDirection / lookAt. (NOT the raw protocol yaw.)
  const fdx = -Math.sin(yaw);
  const fdz = -Math.cos(yaw);
  const ccol = Math.round((cx - (cx - r)) * scale + scale / 2);
  const crow = Math.round((cz - (cz - r)) * scale + scale / 2);
  for (let s = 1; s <= scale; s++) {
    const xx = Math.round(ccol + fdx * s);
    const yy = Math.round(crow + fdz * s);
    if (xx < 0 || yy < 0 || xx >= width || yy >= height) break;
    const i = (yy * width + xx) * 4;
    rgba[i] = 20;
    rgba[i + 1] = 20;
    rgba[i + 2] = 20;
    rgba[i + 3] = 255;
  }

  return { width, height, rgba, scale, cells, legend: [...used].sort() };
}
