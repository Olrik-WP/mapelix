import { describe, expect, it } from "vitest";
import { Face, PlantSprite, QuadMaterial } from "../format.js";
import { BlockPalette } from "../mesh/block-palette.js";
import { resolveBlockAppearance } from "./block-appearance.js";

describe("sampled Bedrock block colors", () => {
  it.each([
    ["amethyst_block", 0x8662bf],
    ["sulfur", 0xbeaf66],
    ["cinnabar", 0x98534e],
    ["nether_gold_ore", 0x73372a],
    ["quartz_ore", 0x76423e],
    ["end_bricks", 0xdae0a2],
    ["dragon_egg", 0x0d0910],
  ] as const)("uses the official texture mean for %s", (name, top) => {
    expect(resolveBlockAppearance(`minecraft:${name}`, {})).toMatchObject({
      shape: { kind: "cube", material: QuadMaterial.Solid },
      top,
      tint: "none",
    });
  });

  it("retains different bone ends and sides along the stored pillar axis", () => {
    const appearance = resolveBlockAppearance("minecraft:bone_block", { pillar_axis: "x" });
    expect(appearance).toMatchObject({
      top: 0xd2ceb3,
      side: 0xe5e2d0,
      bottom: 0xd2ceb3,
      axis: "x",
    });
    const palette = new BlockPalette();
    const id = palette.idFor("minecraft:bone_block", { pillar_axis: "x" });
    expect(palette.colors[id * 6 + Face.PositiveX]).toBe(0xd2ceb3);
    expect(palette.colors[id * 6 + Face.PositiveY]).toBe(0xe5e2d0);
  });

  it("distinguishes oxidized copper from fresh copper, including waxed variants", () => {
    const fresh = resolveBlockAppearance("minecraft:copper_block", {});
    const oxidized = resolveBlockAppearance("minecraft:waxed_oxidized_copper", {});
    expect(fresh.top).toBe(0xc06c50);
    expect(oxidized.top).toBe(0x52a385);
    expect(resolveBlockAppearance("minecraft:waxed_copper", {}).top).toBe(fresh.top);
  });

  it("keeps material and shape while distinguishing lava from magma", () => {
    const lava = resolveBlockAppearance("minecraft:lava", {});
    const magma = resolveBlockAppearance("minecraft:magma", {});
    expect(lava.shape).toEqual({ kind: "cube", material: QuadMaterial.Emissive });
    expect(magma.shape).toEqual(lava.shape);
    expect(lava.top).toBe(0xd55b13);
    expect(magma.top).toBe(0x8f3f20);
    expect(lava.top).not.toBe(lava.side);
  });

  it("colors red and brown mushrooms independently without changing their sprite", () => {
    const red = resolveBlockAppearance("minecraft:red_mushroom", {});
    const brown = resolveBlockAppearance("minecraft:brown_mushroom", {});
    expect(red.shape).toEqual({ kind: "plant", sprite: PlantSprite.Mushroom });
    expect(brown.shape).toEqual(red.shape);
    expect(red.top).not.toBe(brown.top);
  });

  it("retains carpet geometry and resolves legacy dye states", () => {
    const carpet = resolveBlockAppearance("minecraft:carpet", { color: "yellow" });
    expect(carpet).toEqual(resolveBlockAppearance("minecraft:yellow_carpet", {}));
    expect(carpet.shape).toMatchObject({ kind: "box", box: { size: 1, inset: 0 } });
    expect(carpet.top).not.toBe(0xd8d8d8);
  });

  it("maps Bedrock's unqualified oak gate to the existing oak appearance", () => {
    expect(resolveBlockAppearance("minecraft:fence_gate", {})).toEqual(
      resolveBlockAppearance("minecraft:oak_fence_gate", {}),
    );
  });

  it("does not infer bed blankets from the catalog's oak bed-bottom texture", () => {
    expect(resolveBlockAppearance("minecraft:bed", {}).top).toBe(0xd8d8d8);
  });

  it("does not apply vanilla texture samples to an add-on's block with the same local name", () => {
    expect(resolveBlockAppearance("example:amethyst_block", {}).top).toBe(0xd8d8d8);
    expect(resolveBlockAppearance("example:unknown_crystal", {}).top).toBe(0xd8d8d8);
  });

  it("keeps distinct cached colors for lit/powered bulbs and grown mushrooms", () => {
    const palette = new BlockPalette();
    const bulb = "minecraft:waxed_oxidized_copper_bulb";
    const off = palette.idFor(bulb, { lit: 0, powered_bit: 0 });
    const lit = palette.idFor(bulb, { lit: 1, powered_bit: 0 });
    const powered = palette.idFor(bulb, { lit: 1, powered_bit: 1 });
    expect(new Set([off, lit, powered]).size).toBe(3);
    expect(palette.colors[off * 6 + Face.PositiveY]).not.toBe(
      palette.colors[lit * 6 + Face.PositiveY],
    );
    expect(palette.idFor(bulb, { lit: 1, powered_bit: 0, irrelevant_state: 17 })).toBe(lit);
    const small = palette.idFor("minecraft:shelf_mushroom", { growth: 0 });
    const large = palette.idFor("minecraft:shelf_mushroom", { growth: 1 });
    expect(small).not.toBe(large);
    expect(palette.colors[small * 6 + Face.PositiveY]).not.toBe(
      palette.colors[large * 6 + Face.PositiveY],
    );
  });

  it("selects ominous spawner and vault samples before their ordinary state variants", () => {
    for (const [block, states] of [
      ["trial_spawner", { trial_spawner_state: 1 }],
      ["vault", { vault_state: "active" }],
    ] as const) {
      const normal = resolveBlockAppearance(`minecraft:${block}`, { ...states, ominous: 0 });
      const ominous = resolveBlockAppearance(`minecraft:${block}`, { ...states, ominous: 1 });
      expect(normal.top).not.toBe(ominous.top);
      expect(normal.shape).toEqual(ominous.shape);
    }
  });
});
