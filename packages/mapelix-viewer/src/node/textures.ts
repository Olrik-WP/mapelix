import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

import { removeFolder } from "./disk-cache.js";

import {
  ATLAS_FORMAT_VERSION,
  buildTextureAtlas,
  decodeTextureAtlas,
  openResourcePackStack,
  packFingerprint,
  textureRevision,
  type PackLimits,
  type ResourcePackInfo,
  type ResourcePackStack,
  type SkippedImage,
  type SkippedTextureSet,
  type TextureAtlasOptions,
  type TextureIndex,
  type TextureNotice,
  type TextureStackSource,
} from "@mapelix/scene-prototype/textures";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/** An encoded file and its gzip and Brotli encodings, served as they are. */
export interface EncodedFile {
  readonly bytes: Uint8Array;
  readonly gzip: Uint8Array;
  readonly brotli: Uint8Array;
}

/** The normal (`normal.bin`) and material (`mer.bin`) atlases of a stack with texture sets. */
export interface ScenePbrAtlases {
  readonly tileSize: number;
  /** The tile size asked for; the budget or the largest atlas side may have made it smaller. */
  readonly requestedTileSize: number;
  readonly sets: number;
  /** GPU bytes of both atlases with their mipmaps. */
  readonly gpuBytes: number;
  readonly normal: EncodedFile;
  readonly mer: EncodedFile;
  /** Texture sets the atlases could not use; their tiles stay flat. */
  readonly skipped: readonly SkippedTextureSet[];
}

/** A built atlas, ready to serve and to build regions with. */
export interface SceneAtlas {
  readonly revision: string;
  readonly tileSize: number;
  readonly tiles: number;
  /** GPU bytes of the atlas with its mipmaps. */
  readonly gpuBytes: number;
  /** The encoded atlas and its gzip and Brotli encodings, served as they are. */
  readonly bytes: Uint8Array;
  readonly gzip: Uint8Array;
  readonly brotli: Uint8Array;
  readonly index: TextureIndex;
  readonly notices: readonly TextureNotice[];
  /** Images the packs hold but the atlas could not use; the next pack's took their place. */
  readonly skipped: readonly SkippedImage[];
  /** Present when the stack holds texture sets. */
  readonly pbr?: ScenePbrAtlases;
}

export interface SceneTextureOptions {
  readonly maxTileSize: number;
  readonly budgetBytes: number;
  /** Largest atlas side, 2048 (default) or 4096. */
  readonly maxAtlasSide?: number;
  /** The PBR atlases' tile size and budget; used only by stacks with texture sets. */
  readonly pbr?: { readonly tileSize: number; readonly budgetBytes: number };
  readonly limits?: Partial<PackLimits>;
}

/** The atlas options of `stack`: `pbr` only when a pack holds texture sets. */
function atlasSettings(
  stack: ResourcePackStack,
  options: SceneTextureOptions,
): TextureAtlasOptions {
  return {
    maxTileSize: options.maxTileSize,
    budgetBytes: options.budgetBytes,
    ...(options.maxAtlasSide === undefined ? {} : { maxAtlasSide: options.maxAtlasSide }),
    ...(options.pbr !== undefined && stack.hasTextureSets ? { pbr: options.pbr } : {}),
  };
}

async function encodeFile(bytes: Uint8Array): Promise<EncodedFile> {
  const [gzipped, brotli] = await Promise.all([
    gzipAsync(bytes, { level: 9 }),
    brotliAsync(bytes, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 9,
        [constants.BROTLI_PARAM_SIZE_HINT]: bytes.byteLength,
      },
    }),
  ]);
  return { bytes, gzip: new Uint8Array(gzipped), brotli: new Uint8Array(brotli) };
}

type Event = (name: string, detail: Record<string, unknown>) => void;

const ATLAS_FILES = [
  "atlas.bin",
  "atlas.bin.gz",
  "atlas.bin.br",
  "index.json",
  "notices.json",
  "skipped.json",
];
const PBR_FILES = [
  "normal.bin",
  "normal.bin.gz",
  "normal.bin.br",
  "mer.bin",
  "mer.bin.gz",
  "mer.bin.br",
  "pbr.json",
];

/**
 * The textures of one resource pack stack. Opening reads the packs' JSON and names the texture
 * revision; the atlas is read from `<cache>/textures/atlas-v<n>/<revision>/` or built on first
 * use, once, and stored there. `removeOtherRevisions` clears the atlases of other stacks, and
 * `retire` the atlas of a stack another one replaced.
 */
export class SceneTextures {
  readonly revision: string;
  readonly packs: readonly ResourcePackInfo[];
  /** Whether the atlas comes with PBR atlases: a pack holds texture sets. */
  readonly pbr: boolean;
  private readonly stack: ResourcePackStack;
  private readonly options: SceneTextureOptions;
  private readonly folder: string;
  private readonly event: Event;
  private atlas: SceneAtlas | undefined;
  private building: Promise<SceneAtlas> | undefined;
  private failure: string | undefined;
  private retired = false;

  private constructor(
    stack: ResourcePackStack,
    revision: string,
    folder: string,
    options: SceneTextureOptions,
    event: Event,
  ) {
    this.stack = stack;
    this.revision = revision;
    this.packs = stack.packs.map((pack) => pack.info);
    this.pbr = atlasSettings(stack, options).pbr !== undefined;
    this.folder = folder;
    this.options = options;
    this.event = event;
  }

  static async open(
    source: TextureStackSource,
    cacheDirectory: string,
    options: SceneTextureOptions,
    event: Event,
  ): Promise<SceneTextures> {
    const stack = await openResourcePackStack(source, options.limits);
    const revision = textureRevision(stack.fingerprint, atlasSettings(stack, options));
    const root = atlasRoot(cacheDirectory);
    const textures = new SceneTextures(stack, revision, join(root, revision), options, event);
    const startedAt = performance.now();
    textures.atlas = await readStored(textures.folder, revision, textures.pbr).catch(
      () => undefined,
    );
    if (textures.atlas !== undefined) {
      event("textures.cache-hit", {
        revision,
        milliseconds: Math.round(performance.now() - startedAt),
      });
    }
    return textures;
  }

  /** Removes the stored atlases of every revision but `keep`. */
  static async removeOtherRevisions(
    cacheDirectory: string,
    keep: string | undefined,
    event: Event,
  ): Promise<void> {
    const root = atlasRoot(cacheDirectory);
    for (const entry of await readdir(root).catch(() => [] as string[])) {
      if (entry !== keep) {
        await rm(join(root, entry), { recursive: true, force: true });
        event("textures.cache-removed", { revision: entry });
      }
    }
  }

  /**
   * Removes this revision's stored atlas, for a stack another one replaced: a build still
   * running finishes in memory only.
   */
  async retire(): Promise<void> {
    this.retired = true;
    try {
      await removeFolder(this.folder);
      this.event("textures.cache-removed", { revision: this.revision });
    } catch (cause) {
      this.event("textures.retire-failed", { revision: this.revision, message: String(cause) });
    }
  }

  /** What `validateTextureStack` reports for this stack; builds the atlas when needed. */
  async report(): Promise<TextureStackReport> {
    const atlas = (await this.load())!;
    return stackReport(this.stack, atlas.revision, {
      tileSize: atlas.tileSize,
      tiles: atlas.tiles,
      gpuBytes: atlas.gpuBytes,
      bytes: atlas.bytes.byteLength,
      gzipBytes: atlas.gzip.byteLength,
      brotliBytes: atlas.brotli.byteLength,
      notices: atlas.notices,
      skipped: atlas.skipped,
      ...(atlas.pbr === undefined ? {} : { pbr: pbrReport(atlas.pbr) }),
    });
  }

  /** The atlas once built or read, without building it. */
  get ready(): SceneAtlas | undefined {
    return this.atlas;
  }

  /** Why the last build failed, until one succeeds. */
  get error(): string | undefined {
    return this.failure;
  }

  /** The atlas, built once when it is not stored; `cacheOnly` never builds. */
  async load(cacheOnly = false): Promise<SceneAtlas | undefined> {
    if (this.atlas !== undefined || cacheOnly) return this.atlas;
    this.building ??= this.build().finally(() => {
      this.building = undefined;
    });
    return this.building;
  }

  private async build(): Promise<SceneAtlas> {
    const startedAt = performance.now();
    try {
      const built = await buildTextureAtlas(this.stack, atlasSettings(this.stack, this.options));
      const encoded = await encodeFile(built.bytes);
      const pbr: ScenePbrAtlases | undefined =
        built.pbr === undefined
          ? undefined
          : {
              tileSize: built.pbr.tileSize,
              requestedTileSize: built.pbr.requestedTileSize,
              sets: built.pbr.sets,
              gpuBytes: built.pbr.gpuBytes,
              normal: await encodeFile(built.pbr.normalBytes),
              mer: await encodeFile(built.pbr.materialBytes),
              skipped: built.pbr.skipped,
            };
      const atlas: SceneAtlas = {
        revision: built.fingerprint,
        tileSize: built.atlas.tileSize,
        tiles: built.atlas.tiles.length,
        gpuBytes: built.gpuBytes,
        ...encoded,
        index: built.index,
        notices: built.notices,
        skipped: built.skipped,
        ...(pbr === undefined ? {} : { pbr }),
      };
      const names = [...ATLAS_FILES];
      const contents: (Uint8Array | string)[] = [
        atlas.bytes,
        atlas.gzip,
        atlas.brotli,
        JSON.stringify(atlas.index),
        JSON.stringify(atlas.notices),
        JSON.stringify(atlas.skipped),
      ];
      if (pbr !== undefined) {
        const { normal, mer, ...summary } = pbr;
        names.push(...PBR_FILES);
        contents.push(normal.bytes, normal.gzip, normal.brotli, mer.bytes, mer.gzip, mer.brotli);
        contents.push(JSON.stringify(summary));
      }
      if (!this.retired) {
        await mkdir(this.folder, { recursive: true });
        for (const [index, name] of names.entries()) {
          const temporary = join(this.folder, `${name}.${process.pid}.tmp`);
          await writeFile(temporary, contents[index]!);
          await rename(temporary, join(this.folder, name));
        }
        // Retired while writing: nothing of this revision stays on disk.
        if (this.retired) await removeFolder(this.folder);
      }
      this.atlas = atlas;
      this.failure = undefined;
      this.event("textures.built", {
        revision: atlas.revision,
        tileSize: atlas.tileSize,
        tiles: atlas.tiles,
        gpuBytes: atlas.gpuBytes,
        bytes: atlas.bytes.byteLength,
        brotliBytes: atlas.brotli.byteLength,
        gzipBytes: atlas.gzip.byteLength,
        milliseconds: Math.round(performance.now() - startedAt),
        ...(pbr === undefined
          ? {}
          : {
              pbrTileSize: pbr.tileSize,
              pbrSets: pbr.sets,
              pbrGpuBytes: pbr.gpuBytes,
              pbrSkipped: pbr.skipped.length,
            }),
      });
      if (atlas.skipped.length > 0) {
        this.event("textures.images-skipped", {
          revision: atlas.revision,
          images: atlas.skipped.map(({ pack, file, reason }) => `${pack.name} ${file}: ${reason}`),
        });
      }
      return atlas;
    } catch (cause) {
      this.failure = cause instanceof Error ? cause.message : String(cause);
      this.event("textures.failed", { message: this.failure });
      throw cause;
    }
  }
}

function atlasRoot(cacheDirectory: string): string {
  return join(cacheDirectory, "textures", `atlas-v${ATLAS_FORMAT_VERSION}`);
}

async function readStored(folder: string, revision: string, pbr: boolean): Promise<SceneAtlas> {
  const [bytes, gzipped, brotli, indexText, noticesText, skippedText] = await Promise.all(
    ATLAS_FILES.map((name) => readFile(join(folder, name))),
  );
  const view = new Uint8Array(bytes!.buffer, bytes!.byteOffset, bytes!.byteLength);
  const atlas = decodeTextureAtlas(view);
  const index = JSON.parse(indexText!.toString("utf8")) as TextureIndex;
  if (index.fingerprint !== revision) throw new Error("Stored texture index is damaged");
  let pbrAtlases: ScenePbrAtlases | undefined;
  if (pbr) {
    const files = await Promise.all(PBR_FILES.map((name) => readFile(join(folder, name))));
    const file = (at: number) => new Uint8Array(files[at]!);
    const normal = decodeTextureAtlas(file(0));
    decodeTextureAtlas(file(3));
    const summary = JSON.parse(files[6]!.toString("utf8")) as Omit<
      ScenePbrAtlases,
      "normal" | "mer"
    >;
    if (normal.tileSize !== summary.tileSize) throw new Error("Stored PBR atlases are damaged");
    pbrAtlases = {
      ...summary,
      normal: { bytes: file(0), gzip: file(1), brotli: file(2) },
      mer: { bytes: file(3), gzip: file(4), brotli: file(5) },
    };
  }
  return {
    revision,
    tileSize: atlas.tileSize,
    tiles: atlas.tiles.length,
    gpuBytes: atlas.levels.reduce((sum, level) => sum + level.byteLength, 0),
    bytes: view,
    gzip: new Uint8Array(gzipped!),
    brotli: new Uint8Array(brotli!),
    index,
    notices: JSON.parse(noticesText!.toString("utf8")) as TextureNotice[],
    skipped: JSON.parse(skippedText!.toString("utf8")) as SkippedImage[],
    ...(pbrAtlases === undefined ? {} : { pbr: pbrAtlases }),
  };
}

/** What a report says of the PBR atlases. */
export interface PbrReport {
  readonly tileSize: number;
  readonly requestedTileSize: number;
  /** Texture sets read and used. */
  readonly sets: number;
  readonly gpuBytes: number;
  readonly normalBytes: number;
  readonly merBytes: number;
  /** Texture sets ignored, with why: a missing image, an unknown format, an invalid value. */
  readonly skipped: readonly SkippedTextureSet[];
}

function pbrReport(pbr: ScenePbrAtlases): PbrReport {
  return {
    tileSize: pbr.tileSize,
    requestedTileSize: pbr.requestedTileSize,
    sets: pbr.sets,
    gpuBytes: pbr.gpuBytes,
    normalBytes: pbr.normal.bytes.byteLength,
    merBytes: pbr.mer.bytes.byteLength,
    skipped: pbr.skipped,
  };
}

/** What `validateTextureStack` finds. */
export interface TextureStackReport {
  readonly ok: boolean;
  readonly errors: readonly string[];
  /** The texture revision a server would serve with the same options. */
  readonly revision?: string;
  readonly stackFingerprint?: string;
  /** Each pack with the fingerprint `mapelix-stack.json` may pin. */
  readonly packs?: readonly (ResourcePackInfo & { readonly fingerprint: string })[];
  readonly atlas?: {
    readonly tileSize: number;
    readonly tiles: number;
    readonly gpuBytes: number;
    readonly bytes: number;
    readonly gzipBytes: number;
    readonly brotliBytes: number;
  };
  readonly notices?: readonly TextureNotice[];
  /**
   * Images a pack holds but the atlas could not use, too large or damaged: each is replaced by
   * the same image of the next pack, or left untextured when no pack has a usable one.
   */
  readonly skipped?: readonly SkippedImage[];
  /** The PBR atlases, for a stack with texture sets. */
  readonly pbr?: PbrReport;
}

/**
 * Checks a stack without a server: opens every pack, builds the atlas in memory and reports
 * its revision, the packs' fingerprints and sizes, or what is wrong. Never writes anything.
 */
export async function validateTextureStack(
  source: TextureStackSource,
  options: Partial<SceneTextureOptions> = {},
): Promise<TextureStackReport> {
  const settings: SceneTextureOptions = {
    maxTileSize: options.maxTileSize ?? 32,
    budgetBytes: options.budgetBytes ?? 32 * 1024 * 1024,
    ...(options.maxAtlasSide === undefined ? {} : { maxAtlasSide: options.maxAtlasSide }),
    pbr: options.pbr ?? { tileSize: 32, budgetBytes: 48 * 1024 * 1024 },
  };
  try {
    const stack = await openResourcePackStack(source, options.limits);
    const built = await buildTextureAtlas(stack, atlasSettings(stack, settings));
    const [gzipped, brotli] = await Promise.all([
      gzipAsync(built.bytes, { level: 9 }),
      brotliAsync(built.bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
      }),
    ]);
    return await stackReport(stack, built.fingerprint, {
      tileSize: built.atlas.tileSize,
      tiles: built.atlas.tiles.length,
      gpuBytes: built.gpuBytes,
      bytes: built.bytes.byteLength,
      gzipBytes: gzipped.byteLength,
      brotliBytes: brotli.byteLength,
      notices: built.notices,
      skipped: built.skipped,
      ...(built.pbr === undefined
        ? {}
        : {
            pbr: {
              tileSize: built.pbr.tileSize,
              requestedTileSize: built.pbr.requestedTileSize,
              sets: built.pbr.sets,
              gpuBytes: built.pbr.gpuBytes,
              normalBytes: built.pbr.normalBytes.byteLength,
              merBytes: built.pbr.materialBytes.byteLength,
              skipped: built.pbr.skipped,
            },
          }),
    });
  } catch (cause) {
    return failedReport(cause);
  }
}

/** The report of a stack that could not be read or built. */
export function failedReport(cause: unknown): TextureStackReport {
  return { ok: false, errors: [cause instanceof Error ? cause.message : String(cause)] };
}

async function stackReport(
  stack: ResourcePackStack,
  revision: string,
  {
    notices,
    skipped,
    pbr,
    ...atlas
  }: NonNullable<TextureStackReport["atlas"]> & {
    readonly notices: readonly TextureNotice[];
    readonly skipped: readonly SkippedImage[];
    readonly pbr?: PbrReport;
  },
): Promise<TextureStackReport> {
  const packs = [];
  for (const pack of stack.packs) {
    packs.push({ ...pack.info, fingerprint: await packFingerprint(pack) });
  }
  return {
    ok: true,
    errors: [],
    revision,
    stackFingerprint: stack.fingerprint,
    packs,
    atlas,
    notices,
    skipped,
    ...(pbr === undefined ? {} : { pbr }),
  };
}
