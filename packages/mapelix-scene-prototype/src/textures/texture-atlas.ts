import { createHash } from "node:crypto";

import {
  isCutoutTile,
  ATLAS_FORMAT_VERSION,
  MAX_ATLAS_SIDE,
  MAX_ATLAS_TILES,
  MIN_ATLAS_TILE,
  atlasBytes,
  atlasCellSize,
  atlasGutter,
  atlasLevelCount,
  atlasLevelSize,
  encodeTextureAtlas,
  type AtlasTileInfo,
  type TextureAtlas,
} from "./atlas-format.js";
import type { TextureNames } from "./block-textures.js";
import type { PackImage } from "./pack-image.js";
import { ResourcePackChangedError, ResourcePackError } from "./pack-limits.js";
import { heightToNormals, type TextureSetLayer } from "./texture-sets.js";
import { BANNER_TEXTURE, BANNER_TILE, bannerTileSide, cutBannerTile } from "./banner-tile.js";
import {
  BED_COLORS,
  BED_TILES,
  bedTexturePath,
  bedTilePath,
  cutBedTile,
  type BedTile,
} from "./bed-tiles.js";
import type {
  BlockTextureNames,
  Flipbook,
  ResourcePack,
  ResourcePackInfo,
  ResourcePackStack,
  SkippedImage,
  TerrainEntry,
} from "./resource-pack.js";

export interface TextureAtlasOptions {
  /** Largest tile side; larger textures are averaged down (default 32). */
  readonly maxTileSize?: number;
  /** GPU bytes the atlas and its mipmaps may take; tiles shrink until it fits (default 32 MiB). */
  readonly budgetBytes?: number;
  /**
   * Builds the normal and material atlases of the stack's texture sets too. Ignored when no
   * pack holds texture sets; it then changes neither the atlas nor its revision.
   */
  readonly pbr?: PbrAtlasOptions;
}

export interface PbrAtlasOptions {
  /** Tile side of both atlases, 16, 32 or 64 (default 32), apart from the color tiles. */
  readonly tileSize?: number;
  /** GPU bytes both atlases may take with their mipmaps; tiles shrink until they fit (48 MiB). */
  readonly budgetBytes?: number;
}

export const DEFAULT_PBR_OPTIONS = {
  tileSize: 32,
  budgetBytes: 48 * 1024 * 1024,
} as const;

/** A texture set the PBR atlases could not use; its tiles keep flat defaults. */
export interface SkippedTextureSet {
  readonly pack: ResourcePackInfo;
  readonly file: string;
  readonly reason: string;
}

/**
 * The normal and material atlases: the same cells and tiles as the color atlas, at their own
 * tile size. Normals are tangent space with red toward the texture's right, green toward its
 * bottom and blue out of the face; materials are metalness (red), emissive (green) and
 * roughness (blue). Tiles without a texture set hold a flat normal and a rough, dull material.
 */
export interface BuiltPbrAtlases {
  readonly tileSize: number;
  /** The tile size asked for; larger than `tileSize` when the budget made the tiles smaller. */
  readonly requestedTileSize: number;
  readonly normal: TextureAtlas;
  readonly material: TextureAtlas;
  readonly normalBytes: Uint8Array;
  readonly materialBytes: Uint8Array;
  /** GPU bytes of both atlases with their mipmaps. */
  readonly gpuBytes: number;
  /** Texture sets used. */
  readonly sets: number;
  readonly skipped: readonly SkippedTextureSet[];
}

/** Flat normal and default material: no metal, no glow, fully rough. */
const FLAT_NORMAL = [128, 128, 255, 255] as const;
const DEFAULT_MATERIAL = [0, 0, 255, 255] as const;

/**
 * Packs draw normal maps with green toward the bottom of the texture (the DirectX convention).
 * Set to false for green toward the top.
 */
const NORMAL_GREEN_DOWN = true;

/**
 * What a region builder needs to texture blocks: the merged block and terrain entries of the
 * stack and the atlas tile of each image. Plain data, so it crosses to worker threads.
 */
export interface TextureIndex {
  readonly fingerprint: string;
  readonly tiles: Readonly<Record<string, number>>;
  readonly blocks: Readonly<Record<string, BlockTextureNames>>;
  readonly terrain: Readonly<Record<string, TerrainEntry>>;
  /** Tiles with holes (`isCutoutTile`), ascending. */
  readonly cutout: readonly number[];
}

/** Packs and files an atlas was made of, for attribution. */
export interface TextureNotice {
  readonly pack: ResourcePackInfo;
  /** Image files of the pack in the atlas, sorted. */
  readonly files: readonly string[];
}

export interface BuiltTextureAtlas {
  /** The texture revision (`textureRevision`): names the atlas and every region textured with it. */
  readonly fingerprint: string;
  readonly atlas: TextureAtlas;
  readonly bytes: Uint8Array;
  readonly index: TextureIndex;
  /** GPU bytes of the atlas with its mipmaps. */
  readonly gpuBytes: number;
  readonly notices: readonly TextureNotice[];
  /** Images the packs hold but the atlas could not use, replaced by the next pack's if any. */
  readonly skipped: readonly SkippedImage[];
  /** The PBR atlases, when asked for and the stack holds texture sets. */
  readonly pbr?: BuiltPbrAtlases;
}

export const DEFAULT_ATLAS_OPTIONS = {
  maxTileSize: 32,
  budgetBytes: 32 * 1024 * 1024,
} as const;

/** Lookups for `resolveBlockTextures` from an index. */
export function textureNames(index: TextureIndex): TextureNames {
  return {
    blockTextures: (block) => index.blocks[block],
    terrainEntry: (name) => index.terrain[name],
  };
}

interface Source {
  readonly path: string;
  readonly side: number;
  /** Frame indexes into the image's square frames, in play order. */
  readonly frames: readonly number[];
  readonly ticksPerFrame: number;
  /** The image's alpha is an overlay mask, see `AtlasTileInfo.overlay`. */
  readonly overlay: boolean;
  /** A tile cut from a bed's entity texture (see `cutBedTile`), read from `image`. */
  readonly bed?: { readonly image: string; readonly tile: BedTile };
  readonly banner?: true;
}

function pbrOptions(options: PbrAtlasOptions): Required<PbrAtlasOptions> {
  const tileSize = options.tileSize ?? DEFAULT_PBR_OPTIONS.tileSize;
  const budgetBytes = options.budgetBytes ?? DEFAULT_PBR_OPTIONS.budgetBytes;
  if (![16, 32, 64].includes(tileSize)) throw new RangeError("pbr.tileSize must be 16, 32 or 64");
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1) {
    throw new RangeError("pbr.budgetBytes must be a positive integer");
  }
  return { tileSize, budgetBytes };
}

function atlasOptions(
  options: TextureAtlasOptions,
): Required<Omit<TextureAtlasOptions, "pbr">> & { readonly pbr?: Required<PbrAtlasOptions> } {
  const maxTileSize = options.maxTileSize ?? DEFAULT_ATLAS_OPTIONS.maxTileSize;
  const budgetBytes = options.budgetBytes ?? DEFAULT_ATLAS_OPTIONS.budgetBytes;
  if (
    !Number.isInteger(Math.log2(maxTileSize)) ||
    maxTileSize < MIN_ATLAS_TILE ||
    maxTileSize > 256
  ) {
    throw new RangeError("maxTileSize must be a power of two from 4 to 256");
  }
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1) {
    throw new RangeError("budgetBytes must be a positive integer");
  }
  return {
    maxTileSize,
    budgetBytes,
    ...(options.pbr === undefined ? {} : { pbr: pbrOptions(options.pbr) }),
  };
}

/**
 * The texture revision: names the atlas and every region textured with it. It follows from the
 * stack fingerprint and the options alone, so it is known before the atlas is built. `pbr` counts
 * only for a stack with texture sets (`hasTextureSets`): pass it only then.
 */
export function textureRevision(
  stackFingerprint: string,
  options: TextureAtlasOptions = {},
): string {
  const { maxTileSize, budgetBytes, pbr } = atlasOptions(options);
  const parts: (string | number)[] = [
    "mapelix-atlas",
    ATLAS_FORMAT_VERSION,
    stackFingerprint,
    maxTileSize,
    budgetBytes,
  ];
  if (pbr !== undefined) parts.push("pbr", pbr.tileSize, pbr.budgetBytes);
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 20);
}

/**
 * Builds the atlas of every block texture a stack defines. Images are read twice, once for
 * their size and once to draw them, so only one decoded image is in memory at a time.
 */
export async function buildTextureAtlas(
  stack: ResourcePackStack,
  options: TextureAtlasOptions = {},
): Promise<BuiltTextureAtlas> {
  const { maxTileSize, budgetBytes, pbr: askedPbr } = atlasOptions(options);
  const pbr = stack.hasTextureSets ? askedPbr : undefined;

  // The merged entries: each block and terrain name from the first pack defining it.
  const blocks: Record<string, BlockTextureNames> = {};
  const terrain: Record<string, TerrainEntry> = {};
  const flipbooks = new Map<string, Flipbook>();
  for (const pack of stack.packs) {
    for (const name of pack.blocks.keys()) {
      if (Object.hasOwn(blocks, name)) continue;
      const faces = stack.blockTextures(name)!;
      blocks[name] = faces;
      for (const textureName of new Set(Object.values(faces))) {
        if (Object.hasOwn(terrain, textureName)) continue;
        const entry = stack.terrainEntry(textureName);
        if (entry === undefined) continue;
        terrain[textureName] = entry;
        const flipbook = stack.flipbook(textureName);
        if (flipbook !== undefined) flipbooks.set(flipbook.path, flipbook);
      }
    }
  }
  const paths = [
    ...new Set(Object.values(terrain).flatMap((entry) => entry.textures.map((ref) => ref.path))),
  ].sort();
  const overlays = new Set(
    Object.values(terrain).flatMap((entry) =>
      entry.textures.flatMap((ref) => (ref.overlay === true ? [ref.path] : [])),
    ),
  );

  const sources: Source[] = [];
  for (const path of paths) {
    const size = await stack.readImageSize(path);
    if (size === undefined) continue;
    const side = Math.min(size.width, size.height);
    const flipbook = flipbooks.get(path);
    const available = Math.floor(size.height / side);
    const frames =
      flipbook === undefined
        ? [0]
        : (flipbook.frames ?? Array.from({ length: available }, (_, frame) => frame)).filter(
            (frame) => frame < available,
          );
    sources.push({
      path,
      side,
      frames: frames.length === 0 ? [0] : frames,
      ticksPerFrame: flipbook?.ticksPerFrame ?? 1,
      overlay: overlays.has(path),
    });
  }
  // Beds are entities in the game; their block tiles are cut from the entity textures.
  for (const color of BED_COLORS) {
    const image = bedTexturePath(color);
    const size = await stack.readImageSize(image);
    if (size === undefined || size.width !== size.height || size.width % 64 !== 0) continue;
    for (const tile of BED_TILES)
      sources.push({
        path: bedTilePath(color, tile),
        side: size.width / 4,
        frames: [0],
        ticksPerFrame: 1,
        overlay: false,
        bed: { image, tile },
      });
  }
  const bannerSize = await stack.readImageSize(BANNER_TEXTURE);
  const bannerSide =
    bannerSize === undefined ? undefined : bannerTileSide(bannerSize.width, bannerSize.height);
  if (bannerSide !== undefined)
    sources.push({
      path: BANNER_TILE,
      side: bannerSide,
      frames: [0],
      ticksPerFrame: 1,
      overlay: false,
      banner: true,
    });
  const count = sources.reduce((sum, source) => sum + source.frames.length, 0);
  if (count === 0) throw new RangeError("The resource packs hold no block texture");
  if (count > MAX_ATLAS_TILES) {
    throw new RangeError(
      `The resource packs hold ${count} block textures, more than ${MAX_ATLAS_TILES}`,
    );
  }

  // The tile size is the most common texture size, bounded by the options, the budget and the
  // largest texture every device can sample.
  const sides = new Map<number, number>();
  for (const source of sources)
    sides.set(source.side, (sides.get(source.side) ?? 0) + source.frames.length);
  const common = [...sides].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
  let tileSize = Math.max(
    MIN_ATLAS_TILE,
    2 ** Math.floor(Math.log2(Math.min(common, maxTileSize))),
  );
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const fits = (tile: number): boolean =>
    atlasBytes({ tileSize: tile, columns, rows }) <= budgetBytes &&
    columns * atlasCellSize(tile) <= MAX_ATLAS_SIDE &&
    rows * atlasCellSize(tile) <= MAX_ATLAS_SIDE;
  while (tileSize > MIN_ATLAS_TILE && !fits(tileSize)) tileSize /= 2;
  if (!fits(tileSize)) {
    throw new RangeError(`${count} block textures do not fit in the texture budget`);
  }

  const cell = atlasCellSize(tileSize);
  const gutter = atlasGutter(tileSize);
  const { width, height } = atlasLevelSize({ tileSize, columns, rows }, 0);
  const base = new Uint8Array(width * height * 4);
  const tiles: AtlasTileInfo[] = [];
  const placed: Placed[] = [];
  const tileOf: Record<string, number> = {};
  const used = new Map<ResourcePack, string[]>();
  const sheetImages = new Map<string, PackImage | undefined>();
  for (const source of sources) {
    const file = source.banner ? BANNER_TEXTURE : (source.bed?.image ?? source.path);
    let image: PackImage | undefined;
    if (source.bed === undefined && !source.banner) image = await stack.readImage(file);
    else {
      if (!sheetImages.has(file)) sheetImages.set(file, await stack.readImage(file));
      const sheet = sheetImages.get(file);
      image =
        sheet === undefined
          ? undefined
          : source.banner
            ? cutBannerTile(sheet)
            : cutBedTile(sheet, source.bed!.tile);
    }
    if (image === undefined) continue;
    const found = (await stack.locateImage(file))!;
    const files = used.get(found.pack) ?? [];
    if (!files.includes(found.file)) used.set(found.pack, [...files, found.file]);
    tileOf[source.path] = tiles.length;
    if (source.bed === undefined && !source.banner) placed.push({ source, tile: tiles.length });
    // An image that failed to decode was replaced by the next pack's, which may hold fewer
    // frames than the layout counted: its frames repeat.
    const side = Math.min(image.width, image.height);
    const available = Math.max(1, Math.floor(image.height / side));
    for (const [order, wanted] of source.frames.entries()) {
      const frame = wanted % available;
      const tile = tiles.length;
      const x0 = (tile % columns) * cell + gutter;
      const y0 = Math.floor(tile / columns) * cell + gutter;
      const average = resample(image, side, frame, tileSize, base, width, x0, y0, !source.overlay);
      wrapGutter(base, width, x0, y0, tileSize, gutter);
      tiles.push({
        ...average,
        frames: order === 0 ? source.frames.length : 0,
        ticksPerFrame: Math.min(255, source.ticksPerFrame),
        ...(source.overlay ? { overlay: true } : {}),
      });
    }
  }

  const levels: Uint8Array[] = [base];
  // Overlay tiles average their colors without alpha weights, as their alpha is a mask.
  const weighted = (cellX: number, cellY: number): boolean =>
    tiles[cellY * columns + cellX]?.overlay !== true;
  for (let level = 1; level < atlasLevelCount(tileSize); level++) {
    levels.push(
      halve(
        levels[level - 1]!,
        atlasLevelSize({ tileSize, columns, rows }, level - 1),
        cell >> (level - 1),
        weighted,
      ),
    );
  }
  const atlas: TextureAtlas = { tileSize, columns, rows, tiles, levels };
  const fingerprint = textureRevision(stack.fingerprint, {
    maxTileSize,
    budgetBytes,
    ...(pbr === undefined ? {} : { pbr }),
  });
  const pbrAtlases =
    pbr === undefined ? undefined : await buildPbrAtlases(stack, placed, atlas, pbr);
  return {
    fingerprint,
    atlas,
    bytes: encodeTextureAtlas(atlas),
    index: {
      fingerprint,
      tiles: tileOf,
      blocks,
      terrain,
      cutout: tiles.flatMap((tile, index) => (isCutoutTile(tile) ? [index] : [])),
    },
    gpuBytes: atlasBytes(atlas),
    notices: stack.packs
      .filter((pack) => used.has(pack))
      .map((pack) => ({ pack: pack.info, files: used.get(pack)!.sort() })),
    skipped: [...stack.skippedImages()],
    ...(pbrAtlases === undefined ? {} : { pbr: pbrAtlases }),
  };
}

/** Where a color source landed: its first tile, its frames following. */
interface Placed {
  readonly source: Source;
  readonly tile: number;
}

/**
 * The normal and material atlases of the placed tiles, from the texture set of each color
 * image. A set that cannot be read is skipped as a whole and reported; its tiles stay flat.
 */
async function buildPbrAtlases(
  stack: ResourcePackStack,
  placed: readonly Placed[],
  color: TextureAtlas,
  options: Required<PbrAtlasOptions>,
): Promise<BuiltPbrAtlases> {
  const { columns, rows } = color;
  const fits = (tile: number): boolean =>
    2 * atlasBytes({ tileSize: tile, columns, rows }) <= options.budgetBytes &&
    Math.max(columns, rows) * atlasCellSize(tile) <= MAX_ATLAS_SIDE;
  let tileSize = options.tileSize;
  while (tileSize > MIN_ATLAS_TILE && !fits(tileSize)) tileSize /= 2;
  const cell = atlasCellSize(tileSize);
  const gutter = atlasGutter(tileSize);
  const { width, height } = atlasLevelSize({ tileSize, columns, rows }, 0);
  const fill = (value: readonly number[]): Uint8Array => {
    const pixels = new Uint8Array(width * height * 4);
    for (let at = 0; at < pixels.length; at += 4) pixels.set(value, at);
    return pixels;
  };
  const normal = fill(FLAT_NORMAL);
  const material = fill(DEFAULT_MATERIAL);
  const skipped: SkippedTextureSet[] = [];
  let sets = 0;

  for (const { source, tile } of placed) {
    const found = await stack.textureSet(source.path);
    if (found === undefined) continue;
    if ("reason" in found) {
      skipped.push({ pack: found.pack.info, file: found.file, reason: found.reason });
      continue;
    }
    const layer = async (
      value: TextureSetLayer | undefined,
    ): Promise<PackImage | readonly number[] | undefined> =>
      value === undefined
        ? undefined
        : "value" in value
          ? value.value
          : stack.readPackImage(found.pack, value.image);
    let normalLayer: PackImage | undefined;
    let materialLayer: PackImage | readonly number[] | undefined;
    try {
      const normalImage = await layer(found.set.normal);
      if (normalImage !== undefined && !Array.isArray(normalImage))
        normalLayer = normalImage as PackImage;
      else {
        const heights = await layer(found.set.heightmap);
        if (heights !== undefined && !Array.isArray(heights)) {
          const image = heights as PackImage;
          normalLayer = { ...image, rgba: heightToNormals(image) };
        }
      }
      materialLayer = await layer(found.set.mer);
    } catch (error) {
      if (error instanceof ResourcePackChangedError) throw error;
      skipped.push({
        pack: found.pack.info,
        file: found.file,
        reason: error instanceof ResourcePackError ? error.reason : (error as Error).message,
      });
      continue;
    }
    sets += 1;
    for (const [order, wanted] of source.frames.entries()) {
      const x0 = ((tile + order) % columns) * cell + gutter;
      const y0 = Math.floor((tile + order) / columns) * cell + gutter;
      if (normalLayer !== undefined) {
        drawFrame(normalLayer, wanted, tileSize, normal, width, x0, y0);
        if (!NORMAL_GREEN_DOWN) flipGreen(normal, width, x0, y0, tileSize);
        normalize(normal, width, x0, y0, tileSize, tileSize);
        wrapGutter(normal, width, x0, y0, tileSize, gutter);
      }
      if (materialLayer !== undefined) {
        if (Array.isArray(materialLayer))
          fillTile(material, width, x0, y0, tileSize, materialLayer);
        else drawFrame(materialLayer as PackImage, wanted, tileSize, material, width, x0, y0);
        // The subsurface channel is not used: the alpha stays opaque.
        for (let y = 0; y < tileSize; y++)
          for (let x = 0; x < tileSize; x++) material[((y0 + y) * width + x0 + x) * 4 + 3] = 255;
        wrapGutter(material, width, x0, y0, tileSize, gutter);
      }
    }
  }

  const plain = (): boolean => false;
  const normalLevels: Uint8Array[] = [normal];
  const materialLevels: Uint8Array[] = [material];
  for (let level = 1; level < atlasLevelCount(tileSize); level++) {
    const size = atlasLevelSize({ tileSize, columns, rows }, level - 1);
    const next = halve(normalLevels[level - 1]!, size, cell >> (level - 1), plain);
    // Averaged normals are shorter than one: each level is renormalized.
    const { width: levelWidth, height: levelHeight } = atlasLevelSize(
      { tileSize, columns, rows },
      level,
    );
    normalize(next, levelWidth, 0, 0, levelWidth, levelHeight);
    normalLevels.push(next);
    materialLevels.push(halve(materialLevels[level - 1]!, size, cell >> (level - 1), plain));
  }
  const normalAtlas: TextureAtlas = {
    tileSize,
    columns,
    rows,
    tiles: color.tiles,
    levels: normalLevels,
  };
  const materialAtlas: TextureAtlas = { ...normalAtlas, levels: materialLevels };
  return {
    tileSize,
    requestedTileSize: options.tileSize,
    normal: normalAtlas,
    material: materialAtlas,
    normalBytes: encodeTextureAtlas(normalAtlas),
    materialBytes: encodeTextureAtlas(materialAtlas),
    gpuBytes: 2 * atlasBytes(normalAtlas),
    sets,
    skipped,
  };
}

/** One square frame of a layer image, scaled to the tile; frames past the image's repeat. */
function drawFrame(
  image: PackImage,
  wanted: number,
  tileSize: number,
  out: Uint8Array,
  outWidth: number,
  x0: number,
  y0: number,
): void {
  const side = Math.min(image.width, image.height);
  const available = Math.max(1, Math.floor(image.height / side));
  // Layers have no transparency: plain averages, alpha kept opaque.
  resample(image, side, wanted % available, tileSize, out, outWidth, x0, y0, false);
  for (let y = 0; y < tileSize; y++)
    for (let x = 0; x < tileSize; x++) out[((y0 + y) * outWidth + x0 + x) * 4 + 3] = 255;
}

function fillTile(
  out: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  tileSize: number,
  value: readonly number[],
): void {
  for (let y = 0; y < tileSize; y++)
    for (let x = 0; x < tileSize; x++) out.set(value.slice(0, 4), ((y0 + y) * width + x0 + x) * 4);
}

function flipGreen(out: Uint8Array, width: number, x0: number, y0: number, tileSize: number): void {
  for (let y = 0; y < tileSize; y++)
    for (let x = 0; x < tileSize; x++) {
      const at = ((y0 + y) * width + x0 + x) * 4 + 1;
      out[at] = 255 - out[at]!;
    }
}

/** Rescales the normals of a rectangle to unit length; a zero normal becomes flat. */
function normalize(
  out: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): void {
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const at = ((y0 + y) * width + x0 + x) * 4;
      let nx = out[at]! / 127.5 - 1;
      let ny = out[at + 1]! / 127.5 - 1;
      // Normals never point into the face.
      let nz = Math.max(0, out[at + 2]! / 127.5 - 1);
      const length = Math.hypot(nx, ny, nz);
      if (length < 1e-3) [nx, ny, nz] = [0, 0, 1];
      else [nx, ny, nz] = [nx / length, ny / length, nz / length];
      out[at] = Math.round((nx + 1) * 127.5);
      out[at + 1] = Math.round((ny + 1) * 127.5);
      out[at + 2] = Math.round((nz + 1) * 127.5);
    }
}

/** Fills the gutter around the tile at `(x0, y0)` with the tile repeated. */
function wrapGutter(
  pixels: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  tileSize: number,
  gutter: number,
): void {
  const wrap = (value: number): number => ((value % tileSize) + tileSize) % tileSize;
  for (let y = -gutter; y < tileSize + gutter; y++) {
    for (let x = -gutter; x < tileSize + gutter; x++) {
      if (x >= 0 && x < tileSize && y >= 0 && y < tileSize) continue;
      const from = ((y0 + wrap(y)) * width + x0 + wrap(x)) * 4;
      pixels.copyWithin(((y0 + y) * width + x0 + x) * 4, from, from + 4);
    }
  }
}

/**
 * Writes one square frame of `image`, scaled to `tileSize`, into the atlas at `(x0, y0)`.
 * Larger frames are averaged by alpha-weighted boxes, smaller ones repeat their pixels.
 * `weighted` false averages colors alone, for overlay masks. Returns the frame's average color
 * and coverage.
 */
function resample(
  image: PackImage,
  side: number,
  frame: number,
  tileSize: number,
  out: Uint8Array,
  outWidth: number,
  x0: number,
  y0: number,
  weighted = true,
): { average: number; coverage: number } {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumA = 0;
  for (let y = 0; y < tileSize; y++) {
    const fromY = Math.floor((y * side) / tileSize);
    const toY = Math.max(fromY + 1, Math.floor(((y + 1) * side) / tileSize));
    for (let x = 0; x < tileSize; x++) {
      const fromX = Math.floor((x * side) / tileSize);
      const toX = Math.max(fromX + 1, Math.floor(((x + 1) * side) / tileSize));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let plainR = 0;
      let plainG = 0;
      let plainB = 0;
      for (let sy = fromY; sy < toY; sy++) {
        const row = (frame * side + sy) * image.width;
        for (let sx = fromX; sx < toX; sx++) {
          const at = (row + sx) * 4;
          const alpha = image.rgba[at + 3]!;
          r += image.rgba[at]! * alpha;
          g += image.rgba[at + 1]! * alpha;
          b += image.rgba[at + 2]! * alpha;
          a += alpha;
          plainR += image.rgba[at]!;
          plainG += image.rgba[at + 1]!;
          plainB += image.rgba[at + 2]!;
        }
      }
      const samples = (toY - fromY) * (toX - fromX);
      const at = ((y0 + y) * outWidth + x0 + x) * 4;
      const byAlpha = weighted && a > 0;
      out[at] = Math.round(byAlpha ? r / a : plainR / samples);
      out[at + 1] = Math.round(byAlpha ? g / a : plainG / samples);
      out[at + 2] = Math.round(byAlpha ? b / a : plainB / samples);
      out[at + 3] = Math.round(a / samples);
      const weight = weighted ? out[at + 3]! : 255;
      sumR += out[at]! * weight;
      sumG += out[at + 1]! * weight;
      sumB += out[at + 2]! * weight;
      sumA += weight;
    }
  }
  const pixels = tileSize * tileSize;
  const channel = (sum: number): number => (sumA > 0 ? Math.round(sum / sumA) : 0);
  return {
    average: (channel(sumR) << 16) | (channel(sumG) << 8) | channel(sumB),
    coverage: Math.round(sumA / pixels),
  };
}

/**
 * The next mipmap level: alpha-weighted 2×2 averages, which never cross a tile border; plain
 * averages in cells where `weighted` is false. `cell` is the cell side at the source level.
 */
function halve(
  pixels: Uint8Array,
  size: { width: number; height: number },
  cell: number,
  weighted: (cellX: number, cellY: number) => boolean,
): Uint8Array {
  const width = size.width / 2;
  const height = size.height / 2;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byAlpha = weighted(Math.floor((2 * x) / cell), Math.floor((2 * y) / cell));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let plain = [0, 0, 0];
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        const at = ((2 * y + dy) * size.width + 2 * x + dx) * 4;
        const alpha = pixels[at + 3]!;
        r += pixels[at]! * alpha;
        g += pixels[at + 1]! * alpha;
        b += pixels[at + 2]! * alpha;
        a += alpha;
        plain = [plain[0]! + pixels[at]!, plain[1]! + pixels[at + 1]!, plain[2]! + pixels[at + 2]!];
      }
      const at = (y * width + x) * 4;
      out[at] = Math.round(byAlpha && a > 0 ? r / a : plain[0]! / 4);
      out[at + 1] = Math.round(byAlpha && a > 0 ? g / a : plain[1]! / 4);
      out[at + 2] = Math.round(byAlpha && a > 0 ? b / a : plain[2]! / 4);
      out[at + 3] = Math.round(a / 4);
    }
  }
  return out;
}
