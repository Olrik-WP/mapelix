import {
  CAVE_LIMITS,
  DIMENSIONS,
  sceneContext,
  type SceneContext,
} from "@mapelix/scene-prototype/dimensions";
import {
  DISCOVERY_KINDS,
  unpackDiscoveryBlock,
  type DiscoveryGroup,
  type DiscoveryTile,
} from "@mapelix/scene-prototype/discoveries";

/** Viewer-only proximity policy; this never changes stored source indexes. */
export const SURFACE_DISCOVERY_DEPTH = 8;
export function nearSurface(y: number, height: number | undefined): boolean {
  return height === undefined || height - (y + 1) <= SURFACE_DISCOVERY_DEPTH;
}

/** Cooperatively filter source tiles using loaded terrain, preserving cached packets. */
export function* surfaceDiscoveryTiles(
  tiles: readonly DiscoveryTile[],
  heightAt: (x: number, z: number) => number | undefined,
): Generator<void, readonly DiscoveryTile[]> {
  const result: DiscoveryTile[] = [];
  let scanned = 0;
  for (const tile of tiles) {
    const checked = new Uint8Array(1024),
      heights: (number | undefined)[] = Array(1024),
      words: number[] = [];
    for (const word of tile.blocks) {
      if (++scanned % 256 === 0) yield;
      const block = unpackDiscoveryBlock(tile, word),
        key = (block.x & 31) + (block.z & 31) * 32;
      if (!checked[key]) {
        checked[key] = 1;
        heights[key] = heightAt(block.x, block.z);
      }
      if (nearSurface(block.y, heights[key])) words.push(word);
    }
    result.push({ ...tile, blocks: Uint32Array.from(words) });
  }
  return result;
}

/** Surface objects remain on Surface; deeply covered objects need their cave window. */
export function discoveryContext(
  group: DiscoveryGroup,
  current: SceneContext,
  surfaceHeight?: number,
  surfaceThickness: number = CAVE_LIMITS.defaultThickness,
): SceneContext {
  if (group.dimension !== current.dimension)
    throw new RangeError("Discovery belongs to another dimension");
  if (current.mode === "surface" && group.y < current.maxY && nearSurface(group.y, surfaceHeight))
    return current;
  if (current.mode === "caves" && group.y >= current.minY && group.y < current.maxY) return current;
  const thickness = current.mode === "caves" ? current.maxY - current.minY : surfaceThickness;
  const limits = DIMENSIONS[group.dimension];
  const minY = Math.max(
    limits.minY,
    Math.min(limits.maxY - thickness, Math.floor(group.y / 16) * 16),
  );
  return sceneContext(group.dimension, { mode: "caves", minY, maxY: minY + thickness });
}

export function discoveryDistance(group: DiscoveryGroup, previous: number): number {
  const span = Math.max(group.maxX - group.minX, group.maxY - group.minY, group.maxZ - group.minZ);
  return Math.min(previous, Math.max(18, Math.min(40, 16 + span * 1.5)));
}

export interface DiscoveryDetailText {
  readonly title: string;
  readonly lines: readonly string[];
  readonly closeLabel?: string;
}

export function defaultDiscoveryDetails(group: DiscoveryGroup): DiscoveryDetailText {
  return {
    title: `${DISCOVERY_KINDS[group.kind]?.label ?? "Discovery"} × ${group.count}`,
    lines: [
      `X ${group.x} · Y ${group.y} · Z ${group.z}`,
      `${group.exposed} exposed · ${group.buried} buried · ${group.unknown} uncertain`,
    ],
    closeLabel: "Close discovery details",
  };
}
