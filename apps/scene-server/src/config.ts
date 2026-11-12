import { isAbsolute, relative, resolve } from "node:path";

import type { Dimension } from "@mapelix/scene-prototype";

export const DIMENSIONS: readonly Dimension[] = ["overworld", "nether", "the-end"];

/** Where the server listens. TCP is restricted to loopback addresses. */
export type ListenTarget =
  | { readonly kind: "unix"; readonly path: string; readonly mode: number }
  | { readonly kind: "tcp"; readonly host: string; readonly port: number };

/** Block bounds, inclusive on both ends. */
export interface BlockBounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface ServerConfig {
  readonly worldDirectory: string;
  readonly cacheDirectory: string;
  readonly listen: ListenTarget;
  readonly dimensions: readonly Dimension[];
  /** Region builder threads per opened dimension. */
  readonly workers: number;
  /** Distinct region builds that may be queued or running at once. */
  readonly maxPending: number;
  readonly memoryCacheBytes: number;
  readonly diskCacheBytes: number;
  /** Replaces the scanned world extent for every dimension. */
  readonly bounds: BlockBounds | undefined;
}

const MIB = 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
/** Minecraft's world border: no block exists beyond 30 million in x or z. */
export const WORLD_LIMIT = 30_000_000;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Reads the server settings from the environment. Every path comes from here,
 * never from an HTTP request, and every limit has a conservative default.
 */
export function readConfig(env: Environment): ServerConfig {
  const worldDirectory = absolutePath(env, "MAPELIX_WORLD_DIRECTORY");
  const cacheDirectory = absolutePath(env, "MAPELIX_CACHE_DIRECTORY");
  if (isInside(cacheDirectory, worldDirectory) || isInside(worldDirectory, cacheDirectory)) {
    throw new ConfigError("MAPELIX_CACHE_DIRECTORY and the world directory must not overlap");
  }
  return {
    worldDirectory,
    cacheDirectory,
    listen: parseListen(env.MAPELIX_LISTEN ?? "tcp:127.0.0.1:5180", env.MAPELIX_SOCKET_MODE),
    dimensions: parseDimensions(env.MAPELIX_DIMENSIONS ?? "overworld"),
    workers: integer(env, "MAPELIX_SCENE_WORKERS", 1, 1, 16),
    maxPending: integer(env, "MAPELIX_MAX_PENDING", 32, 1, 1024),
    memoryCacheBytes: integer(env, "MAPELIX_MEMORY_CACHE_MB", 64, 0, 4096) * MIB,
    diskCacheBytes: integer(env, "MAPELIX_CACHE_MAX_MB", 1024, 16, 1024 * 1024) * MIB,
    bounds: parseBounds(env.MAPELIX_BOUNDS),
  };
}

function absolutePath(env: Environment, name: string): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") throw new ConfigError(`${name} is required`);
  if (!isAbsolute(raw)) throw new ConfigError(`${name} must be an absolute path`);
  return resolve(raw);
}

function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function integer(
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new ConfigError(`${name} must be a whole number`);
  const value = Number(raw);
  if (value < minimum || value > maximum) {
    throw new ConfigError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function parseListen(raw: string, modeText: string | undefined): ListenTarget {
  if (raw.startsWith("unix:")) {
    const path = raw.slice("unix:".length);
    if (!isAbsolute(path)) throw new ConfigError("MAPELIX_LISTEN unix socket must be absolute");
    const text = modeText === undefined || modeText.trim() === "" ? "660" : modeText.trim();
    const mode = Number.parseInt(text, 8);
    if (!/^[0-7]{3,4}$/.test(text) || (mode & 0o007) !== 0) {
      throw new ConfigError("MAPELIX_SOCKET_MODE must be octal and give others no access");
    }
    return { kind: "unix", path, mode };
  }
  const match = /^tcp:(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(raw);
  if (match === null) throw new ConfigError("MAPELIX_LISTEN must be unix:/path or tcp:host:port");
  const host = match[1]!.replace(/^\[|\]$/g, "");
  const port = Number(match[2]);
  if (!LOOPBACK.has(host)) {
    throw new ConfigError("MAPELIX_LISTEN may only use a loopback address; put a proxy in front");
  }
  if (port < 1 || port > 65535) throw new ConfigError("MAPELIX_LISTEN port is out of range");
  return { kind: "tcp", host, port };
}

export function parseDimensions(raw: string): Dimension[] {
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0) throw new ConfigError("MAPELIX_DIMENSIONS lists no dimension");
  const dimensions: Dimension[] = [];
  for (const name of names) {
    const known = DIMENSIONS.find((candidate) => candidate === name);
    if (known === undefined)
      throw new ConfigError(`Unknown dimension in MAPELIX_DIMENSIONS: ${name}`);
    if (!dimensions.includes(known)) dimensions.push(known);
  }
  return dimensions;
}

export function parseBounds(raw: string | undefined): BlockBounds | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parts = raw.split(",").map((part) => part.trim());
  if (parts.length !== 4 || parts.some((part) => !/^-?\d{1,8}$/.test(part))) {
    throw new ConfigError("MAPELIX_BOUNDS must be minX,minZ,maxX,maxZ in blocks");
  }
  const [minX, minZ, maxX, maxZ] = parts.map(Number) as [number, number, number, number];
  if (minX > maxX || minZ > maxZ) throw new ConfigError("MAPELIX_BOUNDS minimum exceeds maximum");
  if ([minX, minZ, maxX, maxZ].some((value) => Math.abs(value) > WORLD_LIMIT)) {
    throw new ConfigError("MAPELIX_BOUNDS lies beyond the world border");
  }
  return { minX, minZ, maxX, maxZ };
}
