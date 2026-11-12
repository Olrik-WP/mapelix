import { describe, expect, it } from "vitest";
import { QuadMaterial } from "../format.js";
import { resolveBlockAppearance } from "./block-appearance.js";

describe("dimension block appearances", () => {
  // Leaf block identifiers present in Mojang's Bedrock samples v1.26.60.5.
  it.each([
    ["oak_leaves", "foliage"],
    ["spruce_leaves", "foliage"],
    ["birch_leaves", "foliage"],
    ["jungle_leaves", "foliage"],
    ["acacia_leaves", "foliage"],
    ["dark_oak_leaves", "foliage"],
    ["mangrove_leaves", "foliage"],
    ["leaves", "foliage"],
    ["leaves2", "foliage"],
    ["cherry_leaves", "none"],
    ["pale_oak_leaves", "none"],
    ["azalea_leaves", "none"],
    ["azalea_leaves_flowered", "none"],
    ["red_poplar_leaves", "none"],
    ["orange_poplar_leaves", "none"],
    ["yellow_poplar_leaves", "none"],
  ] as const)("recognizes vanilla %s and its tint policy", (name, tint) => {
    expect(resolveBlockAppearance(`minecraft:${name}`, {})).toMatchObject({
      shape: { kind: "cube", material: QuadMaterial.Foliage },
      tint,
    });
  });
  it("keeps pale oak foliage gray without a biome green tint", () => {
    expect(resolveBlockAppearance("minecraft:pale_oak_leaves", {})).toMatchObject({
      top: 0x757a73,
      side: 0x757a73,
      tint: "none",
    });
  });
  it.each([
    ["red", 0x9a2c27],
    ["orange", 0xbc5618],
    ["yellow", 0xd78628],
  ] as const)(
    "preserves fixed %s poplar foliage instead of the green fallback",
    (variant, color) => {
      const leaves = resolveBlockAppearance(`minecraft:${variant}_poplar_leaves`, {});
      expect(leaves).toMatchObject({
        top: color,
        side: color,
        tint: "none",
        shape: { kind: "cube", material: QuadMaterial.Foliage },
      });
      expect(resolveBlockAppearance("minecraft:oak_leaves", {}).tint).toBe("foliage");
      expect(resolveBlockAppearance("minecraft:cherry_leaves", {}).top).toBe(0xf589bf);
    },
  );
  it("distinguishes crimson and warped ground, vegetation and wood", () => {
    for (const suffix of ["nylium", "roots", "fungus", "stem", "wart_block"]) {
      const crimson = resolveBlockAppearance(`minecraft:crimson_${suffix}`, {});
      const warped = resolveBlockAppearance(`minecraft:warped_${suffix}`, {});
      expect(crimson.top).not.toBe(warped.top);
      expect(crimson.tint).toBe("none");
    }
    const ground = resolveBlockAppearance("minecraft:warped_nylium", {});
    expect(ground.top).not.toBe(ground.side);
  });
  it.each(["lava", "flowing_lava", "magma", "glowstone", "shroomlight"])(
    "keeps %s emissive",
    (name) => {
      expect(resolveBlockAppearance(`minecraft:${name}`, {}).shape).toEqual({
        kind: "cube",
        material: QuadMaterial.Emissive,
      });
    },
  );
  it("keeps End Stone distinct from purpur and gives unsupported blocks a stable solid fallback", () => {
    const stone = resolveBlockAppearance("minecraft:end_stone", {});
    expect(resolveBlockAppearance("minecraft:end_stone_bricks", {}).top).toBe(stone.top);
    expect(resolveBlockAppearance("minecraft:purpur_block", {}).top).not.toBe(stone.top);
    const unknown = resolveBlockAppearance("example:unknown_crystal", {});
    expect(unknown.shape).toEqual({ kind: "cube", material: QuadMaterial.Solid });
    expect(Number.isInteger(unknown.top)).toBe(true);
    expect(resolveBlockAppearance("minecraft:air", {}).shape).toEqual({ kind: "empty" });
  });
});
