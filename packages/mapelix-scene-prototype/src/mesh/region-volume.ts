import type { DecodedSubchunk } from "@mapelix/prototype/bedrock";

import { BASE_REGION_SPAN, WORLD_MAX_Y, WORLD_MIN_Y } from "../format.js";
import { paddedBounds, type VerticalBounds } from "../dimensions.js";
import { decodeSection, type ChunkSource, type DecodedChunk } from "../world/chunk-source.js";
import { BlockPalette, PALETTE_ID_MASK, Shape, WATERLOGGED } from "./block-palette.js";

/** Neighbor blocks loaded around a level 0 region, for culling, occlusion, and sky tracing. */
export const VOLUME_MARGIN = 16;
export const VOLUME_SIZE = BASE_REGION_SPAN + 2 * VOLUME_MARGIN;
export const VOLUME_HEIGHT = WORLD_MAX_Y - WORLD_MIN_Y;
export const VOLUME_LAYER = VOLUME_SIZE * VOLUME_SIZE;
/** Column height used when a column holds no block of the requested kind. */
export const NO_BLOCK = WORLD_MIN_Y - 1;

const CHUNKS_PER_SIDE = VOLUME_SIZE / 16;

/**
 * Every block of a level 0 region and its margin, as palette ids. Cells are
 * stored y-major: `(y - WORLD_MIN_Y) * VOLUME_LAYER + z * VOLUME_SIZE + x`.
 */
export interface RegionVolume {
  /** World block coordinates of volume cell (0, 0). */
  readonly originX: number;
  readonly originZ: number;
  readonly cells: Uint16Array;
  /** Allocation bounds; omitted by legacy synthetic volumes. */
  readonly baseY?: number;
  readonly limitY?: number;
  /** Owner bounds, excluding the source halo. Present only for cave meshing. */
  readonly window?: VerticalBounds;
  readonly biomeAt?: (x: number, y: number, z: number) => number | undefined;
  /** Cave meshing only: 1 for each column inside a stored chunk. Other columns hide nothing. */
  readonly explored?: Uint8Array;
  /**
   * Cave meshing of surface dimensions only: the sky roof of each whole world column, see
   * `chunkRoofs`, or `NO_BLOCK`. Air above it is open sky, which cave views leave out.
   */
  readonly skyRoof?: Int16Array;
  /** Highest opaque cube in each column. Air below it is covered from the sky. */
  readonly topSolid: Int16Array;
  /** Highest block of any visible kind in each column. */
  readonly topBlock: Int16Array;
  /** Biome id at the top of each column, or -1 where no chunk is stored. */
  readonly biomes: Int16Array;
}

export function cellIndex(x: number, y: number, z: number, baseY = WORLD_MIN_Y): number {
  return (y - baseY) * VOLUME_LAYER + z * VOLUME_SIZE + x;
}

/** Loads a region and its margin. Returns undefined when the region itself stores no chunk. */
export function buildRegionVolume(
  chunks: ChunkSource,
  palette: BlockPalette,
  regionX: number,
  regionZ: number,
  ceilingY = chunks.config.maxY,
  window?: VerticalBounds,
): RegionVolume | undefined {
  const originX = regionX * BASE_REGION_SPAN - VOLUME_MARGIN;
  const originZ = regionZ * BASE_REGION_SPAN - VOLUME_MARGIN;
  const allocated =
    window === undefined
      ? { minY: WORLD_MIN_Y, maxY: WORLD_MAX_Y }
      : paddedBounds(window, chunks.config.dimension);
  const cells = new Uint16Array(VOLUME_LAYER * (allocated.maxY - allocated.minY));
  const loaded: Array<DecodedChunk | undefined> = [];
  let regionHasChunks = false;

  for (let row = 0; row < CHUNKS_PER_SIDE; row += 1) {
    for (let column = 0; column < CHUNKS_PER_SIDE; column += 1) {
      const chunkX = originX / 16 + column,
        chunkZ = originZ / 16 + row;
      const chunk =
        window === undefined
          ? chunks.chunk(chunkX, chunkZ)
          : chunks.chunkRange(chunkX, chunkZ, allocated.minY, allocated.maxY);
      if (chunk === undefined) continue;
      const insideRegion =
        row > 0 && row < CHUNKS_PER_SIDE - 1 && column > 0 && column < CHUNKS_PER_SIDE - 1;
      regionHasChunks ||= insideRegion;
      loaded[row * CHUNKS_PER_SIDE + column] = chunk;
      for (const section of chunk.sections) {
        if (section.y * 16 < (window === undefined ? ceilingY : allocated.maxY))
          writeSection(
            cells,
            palette,
            section,
            column * 16,
            row * 16,
            chunk.bedColors.get(section.y),
            allocated.minY,
            allocated.maxY,
            chunk.bannerColors.get(section.y),
          );
      }
    }
  }
  if (!regionHasChunks) return undefined;

  const biomeAt = (x: number, y: number, z: number): number | undefined =>
    loaded[(z >> 4) * CHUNKS_PER_SIDE + (x >> 4)]?.biomes.at(x & 15, y, z & 15);
  return describeVolume(
    {
      originX,
      originZ,
      cells,
      ...(window === undefined
        ? {}
        : {
            baseY: allocated.minY,
            limitY: allocated.maxY,
            window,
            biomeAt,
            ...caveColumns(chunks, palette, originX / 16, originZ / 16, loaded),
          }),
    },
    palette,
    biomeAt,
  );
}

/**
 * Finds the column tops and surface biomes of a filled volume. Biomes are looked up
 * with volume-local coordinates; columns without a stored chunk get no biome.
 */
export function describeVolume(
  filled: Pick<
    RegionVolume,
    | "originX"
    | "originZ"
    | "cells"
    | "baseY"
    | "limitY"
    | "window"
    | "biomeAt"
    | "explored"
    | "skyRoof"
  >,
  palette: BlockPalette,
  biomeAt: (x: number, y: number, z: number) => number | undefined,
): RegionVolume {
  const biomes = new Int16Array(VOLUME_LAYER).fill(-1);
  const topSolid = new Int16Array(VOLUME_LAYER).fill(NO_BLOCK);
  const topBlock = new Int16Array(VOLUME_LAYER).fill(NO_BLOCK);
  for (let z = 0; z < VOLUME_SIZE; z += 1) {
    for (let x = 0; x < VOLUME_SIZE; x += 1) {
      const column = z * VOLUME_SIZE + x;
      scanColumn(
        filled.cells,
        palette,
        column,
        topSolid,
        topBlock,
        filled.baseY ?? WORLD_MIN_Y,
        filled.limitY ?? WORLD_MAX_Y,
      );
      const top = topBlock[column]!;
      biomes[column] = biomeAt(x, top === NO_BLOCK ? 64 : top, z) ?? -1;
    }
  }
  return { ...filled, topSolid, topBlock, biomes };
}

/** Sky roofs kept per chunk source, 512 bytes per chunk. */
const ROOF_CACHE_SIZE = 4096;
const roofCaches = new WeakMap<ChunkSource, Map<string, Int16Array | undefined>>();
/** Leaves let the sky through for cave views, so the ground under a canopy stays open. */
const FOLIAGE = /leaves$/;

/**
 * The sky roof of each column of a stored chunk, `z * 16 + x`: its highest opaque block other
 * than leaves, or `NO_BLOCK`. Sections are read from the top down until every column has its
 * roof. The result does not depend on a cave slice, so it is kept per chunk.
 */
export function chunkRoofs(
  chunks: ChunkSource,
  palette: BlockPalette,
  chunkX: number,
  chunkZ: number,
): Int16Array | undefined {
  let cache = roofCaches.get(chunks);
  if (cache === undefined) roofCaches.set(chunks, (cache = new Map()));
  const key = `${chunkX},${chunkZ}`;
  if (cache.has(key)) {
    const cached = cache.get(key);
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const records = chunks.records(chunkX, chunkZ);
  let roofs: Int16Array | undefined;
  if (records !== undefined) {
    roofs = new Int16Array(256).fill(NO_BLOCK);
    let missing = 256;
    for (const record of records.sections) {
      const section = decodeSection(record);
      if (section === undefined) continue;
      const storage = section.primary;
      const roof = storage.palette.map(
        (name, index) =>
          !FOLIAGE.test(name) && palette.isOpaque(palette.idFor(name, storage.states?.[index])),
      );
      const baseY = section.y * 16;
      for (let index = 0; index < 4096; index += 1) {
        if (!roof[storage.indexes[index]!]) continue;
        // Bedrock order is `x * 256 + z * 16 + y`.
        const column = ((index >> 4) & 15) * 16 + (index >> 8);
        const y = baseY + (index & 15);
        if (roofs[column] === NO_BLOCK) missing -= 1;
        if (y > roofs[column]!) roofs[column] = y;
      }
      // Records run from the top section down, so the first roof found is the highest.
      if (missing === 0) break;
    }
  }
  cache.set(key, roofs);
  if (cache.size > ROOF_CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return roofs;
}

/** Which volume columns lie in stored chunks, and their sky roofs where the sky is open. */
function caveColumns(
  chunks: ChunkSource,
  palette: BlockPalette,
  firstChunkX: number,
  firstChunkZ: number,
  loaded: ReadonlyArray<DecodedChunk | undefined>,
): Pick<RegionVolume, "explored" | "skyRoof"> {
  const explored = new Uint8Array(VOLUME_LAYER);
  const skyRoof =
    chunks.config.geometry === "surface" ? new Int16Array(VOLUME_LAYER).fill(NO_BLOCK) : undefined;
  for (let row = 0; row < CHUNKS_PER_SIDE; row += 1) {
    for (let column = 0; column < CHUNKS_PER_SIDE; column += 1) {
      if (loaded[row * CHUNKS_PER_SIDE + column] === undefined) continue;
      const roofs = skyRoof && chunkRoofs(chunks, palette, firstChunkX + column, firstChunkZ + row);
      for (let z = 0; z < 16; z += 1) {
        for (let x = 0; x < 16; x += 1) {
          const index = (row * 16 + z) * VOLUME_SIZE + column * 16 + x;
          explored[index] = 1;
          if (skyRoof !== undefined && roofs !== undefined) skyRoof[index] = roofs[z * 16 + x]!;
        }
      }
    }
  }
  return skyRoof === undefined ? { explored } : { explored, skyRoof };
}

function writeSection(
  cells: Uint16Array,
  palette: BlockPalette,
  section: DecodedSubchunk,
  offsetX: number,
  offsetZ: number,
  bedColors?: ReadonlyMap<number, number>,
  minY = WORLD_MIN_Y,
  maxY = WORLD_MAX_Y,
  bannerColors?: ReadonlyMap<number, number>,
): void {
  if (section.y < minY / 16 || section.y >= maxY / 16) return;
  const blocks = sectionCells(section, palette, bedColors, bannerColors);
  const baseY = section.y * 16;
  for (let index = 0; index < 4096; index += 1) {
    const cell = blocks[index]!;
    if (cell === 0) continue;
    const x = offsetX + (index >> 8);
    const z = offsetZ + ((index >> 4) & 15);
    cells[cellIndex(x, baseY + (index & 15), z, minY)] = cell;
  }
}

/**
 * The palette ids of a subchunk's blocks in Bedrock's order, `x * 256 + z * 16 + y`,
 * with `WATERLOGGED` set on blocks that hold water.
 */
export function sectionCells(
  section: DecodedSubchunk,
  palette: BlockPalette,
  bedColors?: ReadonlyMap<number, number>,
  bannerColors?: ReadonlyMap<number, number>,
): Uint16Array {
  const storage = section.primary;
  const ids = Uint16Array.from(storage.palette, (name, index) =>
    palette.idFor(name, storage.states?.[index]),
  );
  // Bedrock keeps the water of waterlogged blocks in a second storage layer.
  const waterLayer = section.storages[1];
  const waterIds = waterLayer?.palette.map((name) => /(?:^|:)(?:flowing_)?water$/.test(name));
  const cells = new Uint16Array(4096);
  for (let index = 0; index < 4096; index += 1) {
    const logged =
      waterLayer !== undefined && waterIds?.[waterLayer.indexes[index]!] === true ? WATERLOGGED : 0;
    cells[index] = ids[storage.indexes[index]!]! | logged;
  }
  if (bedColors !== undefined) {
    for (const [index, color] of bedColors) {
      const id = storage.indexes[index]!;
      const name = storage.palette[id];
      if (name !== "minecraft:bed" && name !== "bed") continue;
      cells[index] =
        palette.idFor(name, { ...storage.states?.[id], color }) | (cells[index]! & WATERLOGGED);
    }
  }
  if (bannerColors !== undefined) {
    for (const [index, color] of bannerColors) {
      const id = storage.indexes[index]!;
      const name = storage.palette[id];
      if (name === undefined || !/^(?:minecraft:)?(?:standing|wall)_banner$/.test(name)) continue;
      cells[index] =
        palette.idFor(name, { ...storage.states?.[id], color }) | (cells[index]! & WATERLOGGED);
    }
  }
  return cells;
}

function scanColumn(
  cells: Uint16Array,
  palette: BlockPalette,
  column: number,
  topSolid: Int16Array,
  topBlock: Int16Array,
  minY: number,
  maxY: number,
): void {
  for (let y = maxY - 1; y >= minY; y -= 1) {
    const cell = cells[(y - minY) * VOLUME_LAYER + column]!;
    const shape = palette.shape[cell & PALETTE_ID_MASK]!;
    if (topBlock[column] === NO_BLOCK && (shape !== Shape.Empty || cell & WATERLOGGED)) {
      topBlock[column] = y;
    }
    if (shape === Shape.Cube || shape === Shape.Lava) {
      topSolid[column] = y;
      return;
    }
  }
}
