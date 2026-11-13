import { describe, expect, it } from "vitest";
import { Face, unpackQuad } from "../format.js";
import { BlockPalette, lavaFill } from "./block-palette.js";
import {
  VOLUME_HEIGHT,
  VOLUME_LAYER,
  VOLUME_MARGIN,
  VOLUME_SIZE,
  cellIndex,
  describeVolume,
} from "./region-volume.js";
import { meshRegionVolume } from "./voxel-mesher.js";

describe("detail model visibility and liquid levels", () => {
  it("drops internal faces between full lava columns and keeps only their exposed surface", () => {
    const palette = new BlockPalette();
    const cells = new Uint16Array(VOLUME_LAYER * VOLUME_HEIGHT);
    const lava = palette.idFor("minecraft:lava", {});
    for (let z = 19; z <= 21; z++)
      for (let x = 19; x <= 21; x++)
        for (const y of [60, 61]) {
          cells[cellIndex(x + VOLUME_MARGIN, y, z + VOLUME_MARGIN)] = lava;
        }
    const region = meshRegionVolume(
      describeVolume({ originX: -16, originZ: -16, cells }, palette, () => 1),
      palette,
      0,
      0,
      "interior",
    );
    const quads = Array.from({ length: region.opaque.length / 3 }, (_, i) =>
      unpackQuad(region.opaque, i),
    );
    expect(
      quads
        .filter((q) => q.x === 20 && q.z === 20)
        .every((q) => q.face === Face.PositiveY || q.face === Face.NegativeY),
    ).toBe(true);
  });
  it("retains the Overworld sky barrier beneath opaque lava, without exposing sealed terrain", () => {
    const palette = new BlockPalette();
    const cells = new Uint16Array(VOLUME_LAYER * VOLUME_HEIGHT);
    const lava = palette.idFor("minecraft:lava", {});
    for (let z = 0; z < VOLUME_SIZE; z++)
      for (let x = 0; x < VOLUME_SIZE; x++) cells[cellIndex(x, 60, z)] = lava;
    cells[cellIndex(VOLUME_MARGIN + 10, 59, VOLUME_MARGIN + 10)] = palette.idFor(
      "minecraft:stone",
      {},
    );
    const region = meshRegionVolume(
      describeVolume({ originX: -16, originZ: -16, cells }, palette, () => 1),
      palette,
      0,
      0,
    );
    const quads = Array.from({ length: region.opaque.length / 3 }, (_, i) =>
      unpackQuad(region.opaque, i),
    );
    expect(quads.length).toBeGreaterThan(0);
    expect(quads.every((q) => q.lava && q.face === Face.PositiveY)).toBe(true);
  });
  it("connects fences across region boundaries, with the original volume margin", () => {
    const palette = new BlockPalette();
    const cells = new Uint16Array(VOLUME_LAYER * VOLUME_HEIGHT);
    const fence = palette.idFor("minecraft:oak_fence", {});
    for (const x of [63, 64]) cells[cellIndex(x + VOLUME_MARGIN, 60, VOLUME_MARGIN + 4)] = fence;
    const region = meshRegionVolume(
      describeVolume({ originX: -16, originZ: -16, cells }, palette, () => 1),
      palette,
      0,
      0,
    );
    const quads = Array.from({ length: region.opaque.length / 3 }, (_, i) =>
      unpackQuad(region.opaque, i),
    );
    expect(
      quads.some((q) => q.x === 63 && q.modelBounds?.[0] === 8 && q.modelBounds[3] === 16),
    ).toBe(true);
    expect(quads.some((q) => q.x === 64)).toBe(false);
  });
  it("keeps every exposed lava depth and fills vertically stacked lava", () => {
    const palette = new BlockPalette();
    const cells = new Uint16Array(VOLUME_LAYER * VOLUME_HEIGHT);
    for (let depth = 0; depth < 16; depth++) {
      const lava = palette.idFor("minecraft:flowing_lava", { liquid_depth: depth });
      cells[cellIndex(depth * 3 + VOLUME_MARGIN, 60, VOLUME_MARGIN + 4)] = lava;
      cells[cellIndex(depth * 3 + VOLUME_MARGIN, 61, VOLUME_MARGIN + 4)] = lava;
    }
    const region = meshRegionVolume(
      describeVolume({ originX: -16, originZ: -16, cells }, palette, () => 1),
      palette,
      0,
      0,
    );
    const quads = Array.from({ length: region.opaque.length / 3 }, (_, i) =>
      unpackQuad(region.opaque, i),
    );
    for (let depth = 0; depth < 16; depth++) {
      const top = quads.find((q) => q.x === depth * 3 && q.y === 61 && q.face === Face.PositiveY)!;
      expect(top.lava).toBe(true);
      expect(top.box.size).toBe(lavaFill(depth));
      const bottomSides = quads.filter(
        (q) =>
          q.x === depth * 3 && q.y === 60 && q.face !== Face.PositiveY && q.face !== Face.NegativeY,
      );
      expect(bottomSides.every((q) => q.box.size === 16)).toBe(true);
    }
  });
});
