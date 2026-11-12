/** Vanilla Bedrock dimensions. This module is safe to import in the browser. */
export type Dimension = "overworld" | "nether" | "the-end";
export type GeometryMode = "surface" | "interior" | "islands";

export interface DimensionConfig {
  readonly dimension: Dimension;
  readonly label: string;
  readonly storageId: number;
  readonly minY: number;
  /** Exclusive upper block bound. */
  readonly maxY: number;
  readonly geometry: GeometryMode;
  /** Exclusive mesh ceiling, applied before face culling and LOD reduction. */
  readonly defaultCeilingY: number;
  readonly atmosphere: {
    readonly zenith: number;
    readonly horizon: number;
    readonly light: number;
    readonly ground: number;
    readonly ambient: number;
    readonly hazeDistance: number;
  };
}

export const DIMENSIONS: Readonly<Record<Dimension, DimensionConfig>> = {
  overworld: {
    dimension: "overworld",
    label: "Overworld",
    storageId: 0,
    minY: -64,
    maxY: 320,
    geometry: "surface",
    defaultCeilingY: 320,
    atmosphere: {
      zenith: 0x3d7ad8,
      horizon: 0xb9d3ec,
      light: 0xfff1dc,
      ground: 0x8a7a62,
      ambient: 0.9,
      hazeDistance: 2400,
    },
  },
  nether: {
    dimension: "nether",
    label: "Nether",
    storageId: 1,
    minY: 0,
    maxY: 128,
    geometry: "interior",
    defaultCeilingY: 96,
    atmosphere: {
      zenith: 0x240909,
      horizon: 0x63201a,
      light: 0xffb6a0,
      ground: 0x89544a,
      ambient: 0.65,
      hazeDistance: 700,
    },
  },
  "the-end": {
    dimension: "the-end",
    label: "The End",
    storageId: 2,
    minY: 0,
    maxY: 256,
    geometry: "islands",
    defaultCeilingY: 256,
    atmosphere: {
      zenith: 0x080610,
      horizon: 0x20152f,
      light: 0xc6b5df,
      ground: 0x6c5d80,
      ambient: 0.7,
      hazeDistance: 3200,
    },
  },
};

export interface SceneContext {
  readonly dimension: Dimension;
  readonly ceilingY: number;
}

export function parseDimension(value: unknown): Dimension {
  if (value === undefined || value === null) return "overworld";
  if (value === "overworld" || value === "nether" || value === "the-end") return value;
  throw new RangeError(
    `Unsupported dimension: ${typeof value === "string" ? value : "invalid value"}`,
  );
}

/** Ceilings align to 16 blocks so every LOD has the same exact cut boundary. */
export function sceneContext(dimension: Dimension = "overworld", ceilingY?: number): SceneContext {
  const config = DIMENSIONS[parseDimension(dimension)];
  const ceiling = ceilingY ?? config.defaultCeilingY;
  if (
    !Number.isSafeInteger(ceiling) ||
    ceiling % 16 !== 0 ||
    ceiling <= config.minY ||
    ceiling > config.maxY
  ) {
    throw new RangeError(
      `ceilingY must be a multiple of 16 above ${config.minY} and at most ${config.maxY}`,
    );
  }
  return { dimension, ceilingY: ceiling };
}

export function contextFromSearch(params: URLSearchParams): SceneContext {
  const ceiling = params.get("ceilingY");
  return sceneContext(
    parseDimension(params.get("dimension")),
    ceiling === null ? undefined : Number(ceiling),
  );
}

export function contextKey(context: SceneContext): string {
  return `${context.dimension}/${context.ceilingY}`;
}

export function contextSearch(context: SceneContext): URLSearchParams {
  return new URLSearchParams({ dimension: context.dimension, ceilingY: String(context.ceilingY) });
}

export function regionCacheKey(
  context: SceneContext,
  region: { readonly level: number; readonly x: number; readonly z: number },
): string {
  return `${contextKey(context)}/${region.level}/${region.x}/${region.z}`;
}
