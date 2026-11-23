import { describe, expect, it } from "vitest";

import { Face, regionCellSize, regionGridSize, unpackQuad, type Quad } from "../format.js";
import { VoxelKind } from "./block-palette.js";
import { VoxelBox } from "./voxel-box.js";
import { meshVoxelRegion } from "./voxel-level-mesher.js";

const LEVEL = 3;
const SPAN = regionGridSize(LEVEL);
const MARGIN = 4;

/** Meshes a level 3 region of stone voxels. Coordinates are region-local; the margin is added. */
function mesh(build: (place: (x: number, layer: number, z: number) => void) => void): Quad[] {
  const box = new VoxelBox(SPAN + MARGIN * 2, 24);
  build((x, layer, z) => {
    const index = box.index(x + MARGIN, layer, z + MARGIN);
    box.kind[index] = VoxelKind.Solid;
    box.top[index] = 0x7d7d7d;
    box.side[index] = 0x7d7d7d;
    box.fill[index] = 16;
  });
  const region = meshVoxelRegion({
    level: LEVEL,
    x: 0,
    z: 0,
    voxelSize: regionCellSize(LEVEL),
    span: SPAN,
    margin: MARGIN,
    low: 0,
    box,
    explored: new Uint8Array(box.width ** 2).fill(1),
  });
  return Array.from({ length: region.opaque.length / 3 }, (_, index) =>
    unpackQuad(region.opaque, index),
  );
}

describe("voxel level mesher", () => {
  it("draws a floating platform as a slab over open ground", () => {
    const quads = mesh((place) => {
      for (let z = -MARGIN; z < SPAN + MARGIN; z += 1) {
        for (let x = -MARGIN; x < SPAN + MARGIN; x += 1) place(x, 15, z);
      }
      for (let z = 40; z < 50; z += 1) {
        for (let x = 40; x < 50; x += 1) place(x, 20, z);
      }
    });

    const underside = quads.filter((quad) => quad.face === Face.NegativeY);
    expect(underside).toEqual([expect.objectContaining({ x: 40, z: 40, y: 20, width: 10 })]);
    expect(quads.some((quad) => quad.y > 15 && quad.y < 20)).toBe(false);
  });

  it("draws no cave walls toward unexplored land, nor faces under the open sky", () => {
    const box = new VoxelBox(SPAN + MARGIN * 2, 24);
    const explored = new Uint8Array(box.width ** 2);
    for (let z = 0; z < box.width; z += 1) {
      for (let x = 0; x < box.width; x += 1) {
        if (x >= MARGIN + 6) continue;
        explored[z * box.width + x] = 1;
        for (let layer = 0; layer < 16; layer += 1) {
          // A sealed cave at layers 4..5 under ground that ends at layer 15.
          if (layer >= 4 && layer <= 5 && x === MARGIN + 2 && z === MARGIN + 2) continue;
          const index = box.index(x, layer, z);
          box.kind[index] = VoxelKind.Solid;
          box.fill[index] = 16;
        }
      }
    }
    const size = regionCellSize(LEVEL);
    const region = meshVoxelRegion(
      {
        level: LEVEL,
        x: 0,
        z: 0,
        voxelSize: size,
        span: SPAN,
        margin: MARGIN,
        low: 0,
        box,
        explored,
        window: { minY: 0, maxY: 24 * size },
        skyRoof: new Int16Array(box.width ** 2).fill(16 * size - 1),
      },
      "interior",
    );
    const quads = Array.from({ length: region.opaque.length / 3 }, (_, index) =>
      unpackQuad(region.opaque, index),
    );
    expect(quads.length).toBeGreaterThan(0);
    // Quads are in voxel units: only the cave, from the floor at layer 3 to the ceiling at 6.
    expect(quads.every((quad) => quad.y >= 3 && quad.y <= 6)).toBe(true);
    expect(quads.some((quad) => quad.face === Face.PositiveX && quad.x === 5)).toBe(false);
  });
});
