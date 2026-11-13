import { describe, expect, it } from "vitest";
import {
  Face,
  FULL_BOX,
  MODEL_BOUND_CODES,
  QUAD_LAVA_FLAG,
  QUAD_MODEL_FLAG,
  QuadMaterial,
  isLavaQuad,
  modelBoxBounds,
  packModelWord1,
  packQuadWord0,
  partitionLavaQuads,
  unpackQuad,
} from "./format.js";

describe("optional version 2 quad extensions", () => {
  it("round-trips every model bound while keeping legacy material, size and sprite fields valid", () => {
    for (let id = 0; id < MODEL_BOUND_CODES.length; id++) {
      const word0 = packQuadWord0(4, 60, 8, Face.PositiveY, QuadMaterial.Solid) | QUAD_MODEL_FLAG;
      const word1 = packModelWord1(id);
      const decoded = unpackQuad(Uint32Array.of(word0, word1, 0xffaabbcc), 0);
      expect(decoded.modelBounds).toEqual(modelBoxBounds(id));
      expect(decoded.box).toEqual(FULL_BOX);
      expect(decoded.width).toBe(1);
      expect(decoded.height).toBe(1);
      expect(decoded.sprite).toBeLessThanOrEqual(5);
      expect((word0 >>> 26) & 15).toBe(QuadMaterial.Solid);
      expect(isLavaQuad(word0, word1)).toBe(false);
    }
  });
  it("reads pre-extension regions with their unchanged meaning", () => {
    // Literal legacy words: cube at (0, 0, 0), positive-Y face, size 16, RGB #d55b13.
    const old = Uint32Array.of(0x1100000, 0x000f0000, 0xffd55b13);
    const quad = unpackQuad(old, 0);
    expect(quad).not.toHaveProperty("modelBounds");
    expect(quad).not.toHaveProperty("lava");
    expect(quad.box).toEqual(FULL_BOX);
  });
  it("keeps an existing encoded door bound independent of catalog generation order", () => {
    const words = Uint32Array.of(0x811f0404, 0x100f0000, 0xffaabbcc);
    expect(unpackQuad(words, 0).modelBounds).toEqual([0, 0, 0, 16, 16, 3]);
  });
  it("partitions lava in place without mistaking detail ids for lava or losing any quads", () => {
    const base = packQuadWord0(0, 60, 0, Face.PositiveY, QuadMaterial.Emissive);
    const words = Uint32Array.of(
      base,
      0xf0000 | QUAD_LAVA_FLAG,
      1,
      base | QUAD_MODEL_FLAG,
      packModelWord1(12),
      2,
      base,
      0xf0000,
      3,
    );
    const original = words.buffer;
    partitionLavaQuads(words);
    expect(words.buffer).toBe(original);
    expect([words[2]!, words[5]!].sort((a, b) => a - b)).toEqual([2, 3]);
    expect(words[8]).toBe(1);
    expect(isLavaQuad(words[6]!, words[7]!)).toBe(true);
  });
});
