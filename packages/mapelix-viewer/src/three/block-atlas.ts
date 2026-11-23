import {
  atlasCellSize,
  atlasGutter,
  atlasLevelSize,
  decodeTextureAtlas,
  fitAtlasSide,
  MAX_ATLAS_SIDE,
  type TextureAtlas,
} from "@mapelix/scene-prototype/texture-format";
import {
  DataTexture,
  LinearMipmapLinearFilter,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from "three/webgpu";

/**
 * The largest atlas side to load: what the device samples, and at most 2048 in mobile mode so
 * a 4096 atlas loads at half size there. Unknown limits count as 2048.
 */
export function atlasMaxSide(backend: unknown, mobile: boolean): number {
  const gpu = backend as {
    readonly device?: { readonly limits?: { readonly maxTextureDimension2D?: number } };
    readonly gl?: WebGL2RenderingContext;
  };
  const side =
    gpu.device?.limits?.maxTextureDimension2D ?? gpu.gl?.getParameter(gpu.gl.MAX_TEXTURE_SIZE);
  const device = typeof side === "number" && side > MAX_ATLAS_SIDE ? side : MAX_ATLAS_SIDE;
  return mobile ? MAX_ATLAS_SIDE : device;
}

/**
 * The block texture atlas on the GPU: the atlas image with its own mipmaps, which stop where
 * the gutter around each tile is one texel wide, and a small table of tile animations.
 */
export class BlockAtlas {
  readonly tileSize: number;
  readonly gutter: number;
  readonly cellSize: number;
  readonly columns: number;
  readonly rows: number;
  readonly width: number;
  readonly height: number;
  /** Atlas pixels, sRGB, with `levels` mipmaps. */
  readonly image: DataTexture;
  /**
   * One texel per tile, at the tile's cell: frames (low, high byte), ticks per frame, and 255
   * for an overlay tile, whose alpha masks the pixels that take the block's color.
   */
  readonly animation: DataTexture;
  /** GPU bytes of both textures. */
  readonly gpuBytes: number;
  /** Largest side of the atlas as served, before levels were dropped to fit. */
  readonly fullSide: number;

  /** Loads `served` without as many first levels as it takes to fit `maxSide`. */
  constructor(served: TextureAtlas, maxSide = MAX_ATLAS_SIDE) {
    const full = atlasLevelSize(served, 0);
    this.fullSide = Math.max(full.width, full.height);
    const atlas = fitAtlasSide(served, maxSide);
    this.tileSize = atlas.tileSize;
    this.gutter = atlasGutter(atlas.tileSize);
    this.cellSize = atlasCellSize(atlas.tileSize);
    this.columns = atlas.columns;
    this.rows = atlas.rows;
    const top = atlasLevelSize(atlas, 0);
    this.width = top.width;
    this.height = top.height;

    const image = new DataTexture(atlas.levels[0], top.width, top.height);
    image.mipmaps = atlas.levels.map((data, level) => ({ data, ...atlasLevelSize(atlas, level) }));
    image.format = RGBAFormat;
    image.type = UnsignedByteType;
    image.colorSpace = SRGBColorSpace;
    // Crisp texels up close, filtered mipmaps farther out. The gutters keep both inside a tile.
    image.magFilter = NearestFilter;
    image.minFilter = LinearMipmapLinearFilter;
    image.generateMipmaps = false;
    image.flipY = false;
    image.needsUpdate = true;
    this.image = image;

    const table = new Uint8Array(atlas.columns * atlas.rows * 4);
    for (const [index, tile] of atlas.tiles.entries()) {
      table[index * 4] = tile.frames & 0xff;
      table[index * 4 + 1] = tile.frames >> 8;
      table[index * 4 + 2] = tile.ticksPerFrame;
      table[index * 4 + 3] = tile.overlay === true ? 255 : 0;
    }
    const animation = new DataTexture(table, atlas.columns, atlas.rows);
    animation.magFilter = NearestFilter;
    animation.minFilter = NearestFilter;
    animation.generateMipmaps = false;
    animation.needsUpdate = true;
    this.animation = animation;

    let bytes = table.byteLength;
    for (const level of atlas.levels) bytes += level.byteLength;
    this.gpuBytes = bytes;
  }

  /**
   * Fetches and decodes `atlas.bin`; the browser caches it under its immutable URL. A server
   * answers 404 while it builds the atlas, so a missing atlas is asked again after 0.5, 1, 2...
   * seconds, at most 30 between tries, before the load fails. `onMissing` hears each 404, so the
   * caller can check whether the revision is still current; aborting stops the waits. An atlas
   * wider than `maxSide` loads without its first mipmap levels.
   */
  static async load(
    url: string,
    signal?: AbortSignal,
    onMissing?: () => void,
    maxSide = MAX_ATLAS_SIDE,
  ): Promise<BlockAtlas> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, signal === undefined ? {} : { signal });
      if (response.ok)
        return new BlockAtlas(
          decodeTextureAtlas(new Uint8Array(await response.arrayBuffer())),
          maxSide,
        );
      if (response.status !== 404 || attempt >= ATLAS_RETRIES)
        throw new Error(`Texture atlas: HTTP ${response.status}`);
      onMissing?.();
      await wait(Math.min(500 * 2 ** attempt, 30_000), signal);
    }
  }

  dispose(): void {
    this.image.dispose();
    this.animation.dispose();
  }
}

/**
 * One PBR layer on the GPU, normals or materials: the same cells and tiles as the color atlas at
 * its own tile size, linear values, with its own mipmaps.
 */
export interface PbrLayer {
  readonly image: DataTexture;
  readonly tileSize: number;
  readonly gutter: number;
  readonly cellSize: number;
  readonly width: number;
  readonly height: number;
}

/** The normal and material atlases of a stack with texture sets. */
export class PbrAtlas {
  readonly normal: PbrLayer;
  readonly material: PbrLayer;
  readonly tileSize: number;
  readonly gpuBytes: number;
  /** Largest side of the atlases as served, before levels were dropped to fit. */
  readonly fullSide: number;

  constructor(
    servedNormal: TextureAtlas,
    servedMaterial: TextureAtlas,
    color: BlockAtlas,
    maxSide = MAX_ATLAS_SIDE,
  ) {
    const full = atlasLevelSize(servedNormal, 0);
    this.fullSide = Math.max(full.width, full.height);
    const normal = fitAtlasSide(servedNormal, maxSide);
    const material = fitAtlasSide(servedMaterial, maxSide);
    if (
      normal.columns !== color.columns ||
      normal.rows !== color.rows ||
      material.columns !== color.columns ||
      material.rows !== color.rows ||
      material.tileSize !== normal.tileSize
    )
      throw new Error("PBR atlases do not match the color atlas");
    this.normal = pbrLayer(normal);
    this.material = pbrLayer(material);
    this.tileSize = normal.tileSize;
    let bytes = 0;
    for (const level of [...normal.levels, ...material.levels]) bytes += level.byteLength;
    this.gpuBytes = bytes;
  }

  /**
   * Fetches `normal.bin` and `mer.bin` beside the color atlas, waiting and fitting `maxSide` as
   * `BlockAtlas.load`.
   */
  static async load(
    base: string,
    color: BlockAtlas,
    signal?: AbortSignal,
    onMissing?: () => void,
    maxSide = MAX_ATLAS_SIDE,
  ): Promise<PbrAtlas> {
    const [normal, material] = await Promise.all(
      ["normal.bin", "mer.bin"].map((file) => fetchAtlas(`${base}/${file}`, signal, onMissing)),
    );
    return new PbrAtlas(normal!, material!, color, maxSide);
  }

  dispose(): void {
    this.normal.image.dispose();
    this.material.image.dispose();
  }
}

function pbrLayer(atlas: TextureAtlas): PbrLayer {
  const top = atlasLevelSize(atlas, 0);
  const image = new DataTexture(atlas.levels[0], top.width, top.height);
  image.mipmaps = atlas.levels.map((data, level) => ({ data, ...atlasLevelSize(atlas, level) }));
  image.format = RGBAFormat;
  image.type = UnsignedByteType;
  // Normals and material values are data, not colors.
  image.colorSpace = NoColorSpace;
  image.magFilter = NearestFilter;
  image.minFilter = LinearMipmapLinearFilter;
  image.generateMipmaps = false;
  image.flipY = false;
  image.needsUpdate = true;
  return {
    image,
    tileSize: atlas.tileSize,
    gutter: atlasGutter(atlas.tileSize),
    cellSize: atlasCellSize(atlas.tileSize),
    width: top.width,
    height: top.height,
  };
}

async function fetchAtlas(
  url: string,
  signal: AbortSignal | undefined,
  onMissing: (() => void) | undefined,
): Promise<TextureAtlas> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, signal === undefined ? {} : { signal });
    if (response.ok) return decodeTextureAtlas(new Uint8Array(await response.arrayBuffer()));
    if (response.status !== 404 || attempt >= ATLAS_RETRIES)
      throw new Error(`Texture atlas: HTTP ${response.status}`);
    onMissing?.();
    await wait(Math.min(500 * 2 ** attempt, 30_000), signal);
  }
}

/** Tries after the first 404, about a minute and a half in all. */
const ATLAS_RETRIES = 8;

function wait(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, milliseconds);
    const stop = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}
