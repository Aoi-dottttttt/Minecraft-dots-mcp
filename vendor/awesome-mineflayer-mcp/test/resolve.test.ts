import { describe, it, expect } from "vitest";
import { fuzzySuggest, resolveItem, resolveBlock, type Registry } from "../src/util/resolve.js";
import { ToolError } from "../src/util/errors.js";

const registry: Registry = {
  itemsByName: {
    diamond: { id: 1, name: "diamond", displayName: "Diamond" },
    diamond_ore: { id: 2, name: "diamond_ore", displayName: "Diamond Ore" },
    diamond_pickaxe: { id: 3, name: "diamond_pickaxe", displayName: "Diamond Pickaxe" },
    stick: { id: 4, name: "stick", displayName: "Stick" },
  },
  items: {
    1: { id: 1, name: "diamond", displayName: "Diamond" },
    2: { id: 2, name: "diamond_ore", displayName: "Diamond Ore" },
    3: { id: 3, name: "diamond_pickaxe", displayName: "Diamond Pickaxe" },
    4: { id: 4, name: "stick", displayName: "Stick" },
  },
  blocksByName: { stone: { id: 1, name: "stone", displayName: "Stone" } },
  blocks: { 1: { id: 1, name: "stone", displayName: "Stone" } },
  entitiesByName: {},
  entities: {},
};

describe("resolve", () => {
  it("resolves an item by name", () => {
    expect(resolveItem(registry, "diamond")).toEqual({ id: 1, name: "diamond", displayName: "Diamond" });
  });

  it("resolves an item by numeric id and numeric string", () => {
    expect(resolveItem(registry, 3).name).toBe("diamond_pickaxe");
    expect(resolveItem(registry, "3").name).toBe("diamond_pickaxe");
  });

  it("strips a minecraft: prefix and is case-insensitive", () => {
    expect(resolveItem(registry, "minecraft:Diamond").id).toBe(1);
  });

  it("throws UNKNOWN_NAME with fuzzy suggestions on a typo", () => {
    try {
      resolveItem(registry, "dimond");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      const err = e as ToolError;
      expect(err.code).toBe("UNKNOWN_NAME");
      expect(err.suggestions).toContain("diamond");
    }
  });

  it("resolveBlock works against the block table", () => {
    expect(resolveBlock(registry, "stone").id).toBe(1);
  });

  it("fuzzySuggest ranks substring matches first", () => {
    const out = fuzzySuggest("diamond", Object.keys(registry.itemsByName));
    expect(out[0]).toBe("diamond");
    expect(out).toContain("diamond_ore");
    expect(out).not.toContain("stick");
  });
});
