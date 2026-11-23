import { describe, expect, it } from "vitest";

import { EMPTY_HEIGHT, Face, unpackQuad, type Quad, type SceneRegion } from "../format.js";
import { BlockPalette, TintCode } from "./block-palette.js";
import { biomeTints } from "./biome-tints.js";
import {
  VOLUME_HEIGHT,
  VOLUME_LAYER,
  VOLUME_MARGIN,
  VOLUME_SIZE,
  cellIndex,
  describeVolume,
} from "./region-volume.js";
import { meshRegionVolume } from "./voxel-mesher.js";

type Place = (x: number, y: number, z: number, block: string) => void;

/** Builds a volume from placed blocks. Coordinates are region-local; the margin is added. */
function mesh(build: (place: Place) => void): readonly Quad[] {
  const palette = new BlockPalette();
  const cells = new Uint16Array(VOLUME_LAYER * VOLUME_HEIGHT);
  build((x, y, z, block) => {
    cells[cellIndex(x + VOLUME_MARGIN, y, z + VOLUME_MARGIN)] = palette.idFor(block, {});
  });
  const volume = describeVolume(
    { originX: -VOLUME_MARGIN, originZ: -VOLUME_MARGIN, cells },
    palette,
    () => 1,
  );
  return quadsOf(meshRegionVolume(volume, palette, 0, 0));
}

function quadsOf(region: SceneRegion): Quad[] {
  const list = region.opaque;
  return Array.from({ length: list.length / 3 }, (_, index) => unpackQuad(list, index));
}

/** A stone floor under the whole volume, including the margin. */
function floor(place: Place, y = 60): void {
  for (let z = -VOLUME_MARGIN; z < VOLUME_SIZE - VOLUME_MARGIN; z += 1) {
    for (let x = -VOLUME_MARGIN; x < VOLUME_SIZE - VOLUME_MARGIN; x += 1) {
      place(x, y, z, "minecraft:stone");
    }
  }
}

describe("voxel mesher", () => {
  it("samples cave biome tints at each negative block altitude", () => {
    const palette = new BlockPalette();
    const cells = new Uint16Array(VOLUME_LAYER * 64);
    const leaf = palette.idFor("minecraft:oak_leaves", {});
    for (const y of [-50, -34]) cells[cellIndex(24, y, 24)] = leaf;
    const biomeAt = (_x: number, y: number, _z: number) => (y < -48 ? 6 : 2);
    const volume = describeVolume(
      {
        originX: -16,
        originZ: -16,
        cells,
        baseY: -64,
        limitY: 0,
        window: { minY: -64, maxY: -32 },
        biomeAt,
      },
      palette,
      biomeAt,
    );
    const faces = quadsOf(meshRegionVolume(volume, palette, 0, 0, "interior"));
    for (const [y, biome] of [
      [-50, 6],
      [-34, 2],
    ] as const) {
      const top = faces.find((q) => q.y === y && q.face === Face.PositiveY);
      expect(top?.color).toBe(biomeTints(biome)[TintCode.Foliage]);
    }
    expect(biomeTints(6)[TintCode.Foliage]).not.toBe(biomeTints(2)[TintCode.Foliage]);
  });
  describe("cave slices", () => {
    const palette = new BlockPalette();
    const stone = palette.idFor("minecraft:stone", {});
    const window = { minY: 16, maxY: 48 };

    /**
     * Stone up to y 39 under open sky, with a sealed cave at y 20..22 and a notch under an
     * overhang at y 36..37. Columns from region-local x 48 on lie outside stored chunks.
     */
    function caveSlice(options: { sky?: boolean; unexplored?: boolean } = {}): Quad[] {
      const cells = new Uint16Array(VOLUME_LAYER * 64);
      const explored = new Uint8Array(VOLUME_LAYER).fill(1);
      for (let z = 0; z < VOLUME_SIZE; z += 1) {
        for (let x = 0; x < VOLUME_SIZE; x += 1) {
          if (options.unexplored === true && x >= VOLUME_MARGIN + 48) {
            explored[z * VOLUME_SIZE + x] = 0;
            continue;
          }
          for (let y = 0; y < 40; y += 1) {
            const cave = y >= 20 && y <= 22 && x >= 26 && x < 36 && z >= 26 && z < 36;
            // A notch into a cliff: open to the low ground at x < 20, under rock at x 20..23.
            const notch = y >= 36 && y <= 37 && x >= 20 && x < 24 && z === 40;
            const low = x < 20 && y >= 30;
            if (!cave && !notch && !low) cells[cellIndex(x, y, z, 0)] = stone;
          }
        }
      }
      const skyRoof = new Int16Array(VOLUME_LAYER).fill(39);
      for (let z = 0; z < VOLUME_SIZE; z += 1)
        for (let x = 0; x < 20; x += 1) skyRoof[z * VOLUME_SIZE + x] = 29;
      const volume = describeVolume(
        {
          originX: -VOLUME_MARGIN,
          originZ: -VOLUME_MARGIN,
          cells,
          baseY: 0,
          limitY: 64,
          window,
          explored,
          ...(options.sky === false ? {} : { skyRoof }),
        },
        palette,
        () => 1,
      );
      return quadsOf(meshRegionVolume(volume, palette, 0, 0, "interior"));
    }

    it("leaves out the ground and cliffs under the open sky", () => {
      const quads = caveSlice();
      expect(quads.some((quad) => quad.y === 39 && quad.face === Face.PositiveY)).toBe(false);
      expect(quads.some((quad) => quad.y === 29 && quad.face === Face.PositiveY)).toBe(false);
      // The notch under the overhang opens onto the low ground, so the sky reaches it.
      expect(quads.some((quad) => quad.y === 36 || quad.y === 37)).toBe(false);
      // Only the sealed cave shows: its floor, its ceiling, and its walls.
      expect(quads.find((quad) => quad.face === Face.PositiveY)).toMatchObject({ y: 19 });
      expect(quads.find((quad) => quad.face === Face.NegativeY)).toMatchObject({ y: 23 });
      expect(quads.every((quad) => quad.y >= 19 && quad.y <= 23)).toBe(true);
    });

    it("keeps open ground without a sky roof, as in the Nether", () => {
      const quads = caveSlice({ sky: false });
      expect(quads.some((quad) => quad.y === 39 && quad.face === Face.PositiveY)).toBe(true);
    });

    it("draws no walls toward chunks that were never generated", () => {
      const quads = caveSlice({ sky: false, unexplored: true });
      expect(quads.some((quad) => quad.face === Face.PositiveX && quad.x === 47)).toBe(false);
      expect(quads.some((quad) => quad.y === 39 && quad.face === Face.PositiveY)).toBe(true);
    });

    it("reports the highest visible block as the column height", () => {
      const volumeHeights = (sky: boolean) => {
        const cells = new Uint16Array(VOLUME_LAYER * 64);
        for (let index = 0; index < VOLUME_LAYER * 40; index += 1) cells[index] = stone;
        for (let y = 20; y <= 22; y += 1) cells[cellIndex(30, y, 30, 0)] = 0;
        const volume = describeVolume(
          {
            originX: -VOLUME_MARGIN,
            originZ: -VOLUME_MARGIN,
            cells,
            baseY: 0,
            limitY: 64,
            window,
            ...(sky ? { skyRoof: new Int16Array(VOLUME_LAYER).fill(39) } : {}),
          },
          palette,
          () => 1,
        );
        return meshRegionVolume(volume, palette, 0, 0, "interior").heights;
      };
      const heights = volumeHeights(true);
      const column = (30 - VOLUME_MARGIN) * 64 + 30 - VOLUME_MARGIN;
      // The cave's ceiling block, not the hidden ground.
      expect(heights[column]).toBe(24);
      expect(heights[0]).toBe(EMPTY_HEIGHT);
      expect(volumeHeights(false)[0]).toBe(40);
    });
  });

  it("merges a flat floor into one top face and hides the rest", () => {
    const quads = mesh((place) => floor(place));

    expect(quads).toHaveLength(1);
    expect(quads[0]).toMatchObject({
      face: Face.PositiveY,
      x: 0,
      z: 0,
      y: 60,
      width: 64,
      height: 64,
    });
  });

  it("keeps faces a camera can see and drops sealed ones", () => {
    const quads = mesh((place) => {
      floor(place);
      // A pillar on the floor shows its four sides and its top.
      place(10, 61, 10, "minecraft:stone");
      // A sealed pocket under the floor is never visible.
      place(30, 59, 30, "minecraft:stone");
    });
    const pillar = quads.filter((quad) => quad.x === 10 && quad.z === 10 && quad.y === 61);

    expect(pillar.map((quad) => quad.face).sort((left, right) => left - right)).toEqual([
      Face.PositiveX,
      Face.NegativeX,
      Face.PositiveY,
      Face.PositiveZ,
      Face.NegativeZ,
    ]);
    expect(quads.some((quad) => quad.y < 60)).toBe(false);
  });

  it("draws the underside of an overhang that open air reaches from the side", () => {
    const quads = mesh((place) => {
      floor(place);
      for (let x = 20; x < 30; x += 1) place(x, 64, 20, "minecraft:stone");
    });

    const underside = quads.filter((quad) => quad.face === Face.NegativeY && quad.y === 64);
    expect(underside).toHaveLength(1);
    expect(underside[0]).toMatchObject({ x: 20, z: 20, width: 10, height: 1 });
  });

  it("keeps the ground under a wide, high platform", () => {
    const quads = mesh((place) => {
      floor(place);
      for (let z = -8; z < 72; z += 1) {
        for (let x = -8; x < 72; x += 1) place(x, 140, z, "minecraft:stone");
      }
    });

    const ground = quads.filter((quad) => quad.face === Face.PositiveY && quad.y === 60);
    expect(ground).toEqual([expect.objectContaining({ x: 0, z: 0, width: 64, height: 64 })]);
  });
});
