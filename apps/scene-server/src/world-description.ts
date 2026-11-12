import type { Dimension } from "@mapelix/scene-prototype";
import { DIMENSIONS as PROFILES } from "@mapelix/scene-prototype/dimensions";

import type { BlockBounds } from "./config.js";
import type { DimensionDescription } from "./http-server.js";

/**
 * The engine's profile of a dimension, and where a viewer starts in it: the world
 * spawn in the Overworld, the matching Nether position (X and Z divided by eight),
 * or the End's arrival platform. A start outside the stored area moves to its middle.
 */
export function describeDimension(
  id: Dimension,
  stored: BlockBounds | undefined,
  overworldSpawn: { readonly x: number; readonly y: number; readonly z: number },
): DimensionDescription {
  const profile = PROFILES[id];
  let spawn =
    id === "overworld"
      ? overworldSpawn
      : id === "nether"
        ? { x: Math.floor(overworldSpawn.x / 8), y: 64, z: Math.floor(overworldSpawn.z / 8) }
        : { x: 100, y: 64, z: 0 };
  if (
    stored !== undefined &&
    (spawn.x < stored.minX ||
      spawn.x > stored.maxX ||
      spawn.z < stored.minZ ||
      spawn.z > stored.maxZ)
  ) {
    spawn = {
      x: Math.floor((stored.minX + stored.maxX) / 2),
      y: spawn.y,
      z: Math.floor((stored.minZ + stored.maxZ) / 2),
    };
  }
  return {
    id,
    label: profile.label,
    bounds: stored ?? null,
    minY: profile.minY,
    maxY: profile.maxY,
    defaultCeilingY: profile.defaultCeilingY,
    spawn,
  };
}
