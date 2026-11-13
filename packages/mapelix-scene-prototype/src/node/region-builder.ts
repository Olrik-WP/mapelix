import { EMPTY_HEIGHT, encodeSceneRegion, regionGridSize, type SceneRegion } from "../format.js";
import { WorldDatabase } from "../leveldb/world-database.js";
import { BlockPalette } from "../mesh/block-palette.js";
import { ChunkVoxelReader } from "../mesh/chunk-voxels.js";
import { buildRegionVolume } from "../mesh/region-volume.js";
import { meshVoxelRegion } from "../mesh/voxel-level-mesher.js";
import { meshRegionVolume } from "../mesh/voxel-mesher.js";
import { buildVoxelRegion } from "../mesh/voxel-region.js";
import { ChunkSource, type Dimension } from "../world/chunk-source.js";
import { CAVE_LIMITS, sceneContext, type SceneContextOptions } from "../dimensions.js";
import { buildDiscoveryIndex } from "../world/discovery-index.js";
import type { DiscoveryRequest } from "../discoveries.js";

export interface RegionRequest extends SceneContextOptions {
  /** Exclusive upper mesh bound, in multiples of 16. Defaults to the dimension profile. */
  readonly ceilingY?: number;
  readonly level: number;
  readonly x: number;
  readonly z: number;
}

export interface RegionBuilderOptions {
  readonly directory: string;
  readonly dimension: Dimension;
}

/**
 * Builds serialized scene regions from one world. Each worker thread owns one
 * builder, so its database handles, block cache, and palette are never shared.
 */
export class RegionBuilder {
  private readonly database: WorldDatabase;
  private readonly chunks: ChunkSource;
  private readonly voxels: ChunkVoxelReader;
  private readonly palette = new BlockPalette();

  constructor(options: RegionBuilderOptions) {
    this.database = WorldDatabase.open(options.directory);
    this.chunks = new ChunkSource(this.database, options.dimension);
    this.voxels = new ChunkVoxelReader(this.chunks, this.palette);
  }

  build(request: RegionRequest): Uint8Array {
    return encodeSceneRegion(this.mesh(request));
  }

  /** Snapshot-based source indexing shares the worker/reader, independently of terrain meshing. */
  discoveries(request: DiscoveryRequest): Uint8Array {
    return buildDiscoveryIndex(this.chunks, request);
  }

  close(): void {
    this.database.close();
  }

  private mesh(request: RegionRequest): SceneRegion {
    const { level, x, z } = request;
    const config = this.chunks.config;
    const context = sceneContext(config.dimension, request);
    if (
      context.mode === "caves" &&
      (!Number.isInteger(level) || level < 0 || level > CAVE_LIMITS.maxLevel)
    ) {
      throw new RangeError(`Caves support LOD 0 through ${CAVE_LIMITS.maxLevel}`);
    }
    const window = context.mode === "caves" ? context : undefined;
    const geometry =
      window === undefined
        ? config.geometry
        : config.geometry === "islands"
          ? "islands"
          : "interior";
    if (level === 0) {
      const volume = buildRegionVolume(this.chunks, this.palette, x, z, context.maxY, window);
      return volume === undefined
        ? emptyRegion(level, x, z)
        : meshRegionVolume(volume, this.palette, x, z, geometry);
    }
    const voxels = buildVoxelRegion(this.voxels, level, x, z, context.maxY, window);
    return voxels === undefined ? emptyRegion(level, x, z) : meshVoxelRegion(voxels, geometry);
  }
}

function emptyRegion(level: number, x: number, z: number): SceneRegion {
  const empty = new Uint32Array(0);
  return {
    level,
    x,
    z,
    heights: new Int16Array(regionGridSize(level) ** 2).fill(EMPTY_HEIGHT),
    minY: 0,
    maxY: 0,
    opaque: empty,
    plants: empty,
    translucent: empty,
  };
}
