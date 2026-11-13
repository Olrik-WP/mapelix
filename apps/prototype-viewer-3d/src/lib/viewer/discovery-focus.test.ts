import { describe, expect, it } from "vitest";
import { sceneContext } from "@mapelix/scene-prototype/dimensions";
import {
  packDiscoveryBlock,
  type DiscoveryGroup,
  type DiscoveryTile,
} from "@mapelix/scene-prototype/discoveries";
import {
  discoveryContext,
  discoveryDistance,
  nearSurface,
  surfaceDiscoveryTiles,
} from "./discovery-focus";

const group = (y: number): DiscoveryGroup => ({
  dimension: "overworld",
  id: `test/${y}`,
  kind: 13,
  x: 14,
  y,
  z: 20,
  count: 1,
  exposed: 1,
  buried: 0,
  unknown: 0,
  minX: 14,
  maxX: 15,
  minY: y,
  maxY: y + 1,
  minZ: 20,
  maxZ: 21,
});

describe("discovery framing", () => {
  it("filters Surface cooperatively without changing cached all-height packets", () => {
    const blocks = Uint32Array.from({ length: 1024 }, (_, i) =>
      packDiscoveryBlock(i & 31, i % 2 ? 81 : -63, i >> 5, 13, "exposed"),
    );
    const original = blocks.slice(),
      tile: DiscoveryTile = { dimension: "overworld", x: 0, z: 0, sourceChunks: 15, blocks };
    const iterator = surfaceDiscoveryTiles([tile], () => 82);
    let yields = 0;
    while (true) {
      const step = iterator.next();
      if (step.done) {
        expect(step.value[0]!.blocks).toHaveLength(512);
        break;
      }
      yields++;
    }
    expect(yields).toBe(4);
    expect(blocks).toEqual(original);
  });
  it("treats exactly eight blocks below the column top as near Surface", () => {
    expect(nearSurface(73, 82)).toBe(true);
    expect(nearSurface(72, 82)).toBe(false);
  });
  it("keeps surface objects on Surface and opens a negative cave slice for deeply covered objects", () => {
    const surface = sceneContext();
    expect(discoveryContext(group(81), surface, 82)).toEqual(surface);
    expect(discoveryContext(group(76), surface, 82)).toEqual(surface);
    expect(discoveryContext(group(-63), surface, 82)).toMatchObject({
      mode: "caves",
      minY: -64,
      maxY: -32,
    });
    expect(discoveryContext(group(81), surface)).toEqual(surface);
    expect(discoveryContext(group(-63), surface, 82, 16)).toMatchObject({ minY: -64, maxY: -48 });
  });
  it("retains cave thickness, compatible aliases and an already visible slice", () => {
    const caves = sceneContext("overworld", { mode: "caves", minY: -32, maxY: -16 });
    expect(discoveryContext(group(-24), caves)).toEqual(caves);
    expect(discoveryContext(group(-63), caves)).toMatchObject({
      minY: -64,
      maxY: -48,
      ceilingY: -48,
    });
    expect(discoveryContext(group(81), caves, 82)).toMatchObject({
      mode: "caves",
      minY: 80,
      maxY: 96,
    });
  });
  it("approaches moderately, handles larger groups and never zooms out from a close view", () => {
    expect(discoveryDistance(group(81), 160)).toBe(18);
    expect(discoveryDistance({ ...group(81), maxX: 80 }, 160)).toBe(40);
    expect(discoveryDistance(group(81), 6)).toBe(6);
  });
});
