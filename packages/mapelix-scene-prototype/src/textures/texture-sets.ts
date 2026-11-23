import { packPath } from "./pack-limits.js";

/**
 * Texture sets: the `<texture>.texture_set.json` files that physically based packs put next to a
 * block texture. Each adds layers to the color image: a normal map or a height map, and the
 * metalness, emissive and roughness of every texel (MER, or MERS with subsurface, which is read
 * and ignored). A layer is an image of the same pack, or one value for the whole texture.
 */

/**
 * Texture set formats known; the layers they hold are the same. Later versions are read too, as
 * long as they keep these layers; versions before the first are refused.
 */
export const TEXTURE_SET_FORMATS = ["1.16.100", "1.21.30"] as const;

/** Whether a `format_version` is read: `1.16.100` or later. */
function readableFormat(format: string): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(format)?.slice(1).map(Number);
  if (parts === undefined) return false;
  const [major, minor, patch] = parts as [number, number, number];
  return major > 1 || (major === 1 && (minor > 16 || (minor === 16 && patch >= 100)));
}

export const TEXTURE_SET_SUFFIX = ".texture_set.json";

/** One layer: an image of the pack (path without extension), or one RGBA value, 0 to 255. */
export type TextureSetLayer =
  | { readonly image: string }
  | { readonly value: readonly [number, number, number, number] };

export interface TextureSet {
  /** Normal map, tangent space. */
  readonly normal?: TextureSetLayer;
  /** Height map, gray levels; turned into normals when there is no normal map. */
  readonly heightmap?: TextureSetLayer;
  /** Metalness (red), emissive (green), roughness (blue); the subsurface alpha is ignored. */
  readonly mer?: TextureSetLayer;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A uniform value: `[r, g, b(, a)]` from 0 to 255, or `#RRGGBB(AA)`. */
function uniformValue(value: unknown): [number, number, number, number] | undefined {
  if (Array.isArray(value)) {
    if (value.length !== 3 && value.length !== 4) return undefined;
    if (!value.every((part) => typeof part === "number" && part >= 0 && part <= 255))
      return undefined;
    const [r, g, b, a = 255] = (value as number[]).map(Math.round);
    return [r!, g!, b!, a];
  }
  if (typeof value === "string" && /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
    const number = (at: number) => Number.parseInt(value.slice(at, at + 2), 16);
    return [number(1), number(3), number(5), value.length === 9 ? number(7) : 255];
  }
  return undefined;
}

/**
 * Parses a texture set file found at `file` (a pack path). Layer images are names in the same
 * folder. Returns the set, or why it cannot be used.
 */
export function parseTextureSet(json: unknown, file: string): TextureSet | string {
  const root = record(json);
  const format = root?.["format_version"];
  if (typeof format !== "string" || !readableFormat(format)) {
    return `has format ${typeof format === "string" ? format : "(none)"}, which is not read`;
  }
  const set = record(root?.["minecraft:texture_set"]);
  if (set === undefined) return "has no minecraft:texture_set";
  const folder = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  const layer = (key: string, uniform: boolean): TextureSetLayer | string | undefined => {
    const value = set[key];
    if (value === undefined) return undefined;
    if (typeof value === "string" && !value.startsWith("#")) {
      let path: string | undefined;
      try {
        path = packPath(`${folder}${value}`);
      } catch {
        path = undefined;
      }
      return path === undefined ? `names an unsafe ${key} image` : { image: path };
    }
    const parsed = uniform ? uniformValue(value) : undefined;
    return parsed === undefined ? `has an invalid ${key} value` : { value: parsed };
  };
  const normal = layer("normal", false);
  const heightmap = layer("heightmap", false);
  const mer =
    set["metalness_emissive_roughness_subsurface"] !== undefined
      ? layer("metalness_emissive_roughness_subsurface", true)
      : layer("metalness_emissive_roughness", true);
  for (const found of [normal, heightmap, mer]) if (typeof found === "string") return found;
  if (normal === undefined && heightmap === undefined && mer === undefined)
    return "has no normal, heightmap or metalness_emissive_roughness layer";
  return {
    ...(normal === undefined ? {} : { normal: normal as TextureSetLayer }),
    ...(heightmap === undefined ? {} : { heightmap: heightmap as TextureSetLayer }),
    ...(mer === undefined ? {} : { mer: mer as TextureSetLayer }),
  };
}

/**
 * Normals from a height map's gray levels (red channel), with a Sobel filter that wraps at the
 * texture edges as the texture repeats. Each frame of an animation is its own square, so the
 * filter wraps inside it. `strength` scales the slopes.
 */
export function heightToNormals(
  image: { readonly width: number; readonly height: number; readonly rgba: Uint8Array },
  strength = 2,
): Uint8Array {
  const { width, height, rgba } = image;
  const side = Math.min(width, height);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const frameTop = Math.floor(y / side) * side;
    const frameHeight = Math.min(side, height - frameTop);
    for (let x = 0; x < width; x++) {
      const at = (dx: number, dy: number): number => {
        const sx = (((x + dx) % width) + width) % width;
        const sy = frameTop + ((((y - frameTop + dy) % frameHeight) + frameHeight) % frameHeight);
        return rgba[(sy * width + sx) * 4]! / 255;
      };
      const gx = at(1, -1) + 2 * at(1, 0) + at(1, 1) - (at(-1, -1) + 2 * at(-1, 0) + at(-1, 1));
      const gy = at(-1, 1) + 2 * at(0, 1) + at(1, 1) - (at(-1, -1) + 2 * at(0, -1) + at(1, -1));
      // Height rises toward +x: the surface faces -x. Rows go down the texture, as `gy` does.
      let nx = -gx * strength;
      let ny = -gy * strength;
      let nz = 1;
      const length = Math.hypot(nx, ny, nz);
      nx /= length;
      ny /= length;
      nz /= length;
      const o = (y * width + x) * 4;
      out[o] = Math.round((nx * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      out[o + 3] = 255;
    }
  }
  return out;
}
