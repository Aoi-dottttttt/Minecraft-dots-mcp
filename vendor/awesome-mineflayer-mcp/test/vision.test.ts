import { describe, it, expect } from "vitest";
import { encodePNG } from "../src/util/png.js";
import { blockColor, renderArea } from "../src/bot/render.js";

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function readU32BE(buf: Buffer, off: number): number {
  return buf.readUInt32BE(off);
}

describe("encodePNG", () => {
  it("produces a valid PNG with the right signature and dimensions", () => {
    const w = 5;
    const h = 3;
    const rgba = new Uint8Array(w * h * 4).fill(128);
    const png = encodePNG(w, h, rgba);
    // signature
    expect([...png.subarray(0, 8)]).toEqual(PNG_SIG);
    // first chunk is IHDR
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    expect(readU32BE(png, 16)).toBe(w); // IHDR width
    expect(readU32BE(png, 20)).toBe(h); // IHDR height
    expect(png[24]).toBe(8); // bit depth
    expect(png[25]).toBe(6); // RGBA
    // ends with IEND
    expect(png.subarray(png.length - 8, png.length - 4).toString("ascii")).toBe("IEND");
  });
});

describe("blockColor", () => {
  it("returns null for air variants and a color for solids", () => {
    expect(blockColor("air")).toBeNull();
    expect(blockColor("cave_air")).toBeNull();
    expect(blockColor("stone")).toEqual([125, 125, 125]);
    expect(blockColor("oak_log")).toBeTruthy();
    // keyword fallback
    expect(blockColor("some_unknown_leaves")).toEqual([54, 110, 48]);
    // default fallback
    expect(blockColor("totally_made_up_block")).toEqual([150, 150, 150]);
  });
});

describe("renderArea", () => {
  // Minimal fake bot: solid stone at y<=64, air above; one entity nearby.
  const fakeBot = {
    entity: { position: { x: 0, y: 65, z: 0 }, yaw: 0, id: 1 },
    entities: {
      1: { id: 1, type: "player", position: { x: 0, y: 65, z: 0 } },
      2: { id: 2, type: "mob", kind: "Hostile mobs", position: { x: 3, y: 64, z: -2 } },
    },
    blockAt: (v: { x: number; y: number; z: number }) =>
      v.y <= 64 ? { name: "stone", boundingBox: "block" } : { name: "air", boundingBox: "empty" },
  } as any;

  it("produces an RGBA raster of the expected size that encodes to a PNG", () => {
    const r = renderArea(fakeBot, {
      center: { x: 0, y: 65, z: 0 },
      radius: 8,
      maxDim: 160,
      mode: "surface",
      sliceY: 64,
      includeEntities: true,
    });
    const cells = 17; // 2*8+1
    expect(r.cells).toBe(cells);
    expect(r.width).toBe(cells * r.scale);
    expect(r.rgba.length).toBe(r.width * r.height * 4);
    expect(r.legend).toContain("stone");
    // every pixel got an alpha
    expect(r.rgba[3]).toBe(255);
    const png = encodePNG(r.width, r.height, r.rgba);
    expect(readU32BE(png, 16)).toBe(r.width);
  });

  it("draws the facing tick toward north (up) at yaw 0 and south (down) at yaw π", () => {
    const botYaw = (yaw: number) =>
      ({
        entity: { position: { x: 0, y: 65, z: 0 }, yaw, id: 1 },
        entities: {},
        blockAt: (v: { y: number }) =>
          v.y <= 64 ? { name: "stone", boundingBox: "block" } : { name: "air", boundingBox: "empty" },
      }) as any;
    const opts = { center: { x: 0, y: 65, z: 0 }, radius: 8, maxDim: 160, mode: "surface" as const, sliceY: 64, includeEntities: false };

    const darkRows = (r: { width: number; height: number; rgba: Uint8Array }) => {
      const rows: number[] = [];
      for (let y = 0; y < r.height; y++)
        for (let x = 0; x < r.width; x++) {
          const i = (y * r.width + x) * 4;
          if (r.rgba[i] === 20 && r.rgba[i + 1] === 20 && r.rgba[i + 2] === 20) rows.push(y);
        }
      return rows;
    };

    const north = renderArea(botYaw(0), opts);
    const south = renderArea(botYaw(Math.PI), opts);
    const centerRow = Math.floor(north.height / 2);
    const nRows = darkRows(north);
    const sRows = darkRows(south);
    expect(nRows.length).toBeGreaterThan(0);
    expect(sRows.length).toBeGreaterThan(0);
    // yaw 0 → tick extends above center (north/up); yaw π → below (south/down).
    expect(Math.min(...nRows)).toBeLessThan(centerRow);
    expect(Math.max(...nRows)).toBeLessThanOrEqual(centerRow);
    expect(Math.max(...sRows)).toBeGreaterThan(centerRow);
  });

  it("slice mode renders without scanning a column", () => {
    const r = renderArea(fakeBot, {
      center: { x: 0, y: 65, z: 0 },
      radius: 4,
      maxDim: 80,
      mode: "slice",
      sliceY: 64,
      includeEntities: false,
    });
    expect(r.rgba.length).toBe(r.width * r.height * 4);
    expect(r.legend).toContain("stone");
  });
});
