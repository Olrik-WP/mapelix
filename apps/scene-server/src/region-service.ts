import type { Dimension, RegionRequest } from "@mapelix/scene-prototype";
import {
  EMPTY_HEIGHT,
  MAX_REGION_LEVEL,
  decodeSceneRegion,
  encodeSceneRegion,
  regionGridSize,
  regionSpan,
} from "@mapelix/scene-prototype/format";

import { WORLD_LIMIT, type BlockBounds } from "./config.js";
import { regionTouches } from "./extent.js";

export type CacheStatus = "memory" | "disk" | "build" | "empty";

export interface RegionResult {
  readonly bytes: Uint8Array;
  readonly cacheStatus: CacheStatus;
  readonly milliseconds: number;
}

export interface BuiltBytes {
  readonly bytes: Uint8Array;
  readonly milliseconds: number;
}

export type BuildRegion = (
  dimension: Dimension,
  request: RegionRequest,
  signal: AbortSignal,
) => Promise<BuiltBytes>;

export interface RegionStore {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, bytes: Uint8Array): Promise<void>;
  discard(key: string): Promise<void>;
}

export interface RegionServiceOptions {
  /** Served dimensions and their stored area; undefined means the dimension stores nothing. */
  readonly dimensions: ReadonlyMap<Dimension, BlockBounds | undefined>;
  readonly build: BuildRegion;
  readonly store: RegionStore | undefined;
  readonly memoryBytes: number;
  readonly maxPending: number;
  readonly onEvent?: (event: string, detail: Record<string, unknown>) => void;
}

export interface RegionServiceStats {
  readonly inFlight: number;
  readonly maxPending: number;
  readonly memoryEntries: number;
  readonly memoryBytes: number;
  readonly built: number;
  readonly rejected: number;
  readonly failed: number;
}

/** Too many distinct builds are already waiting. The client should retry later. */
export class OverloadedError extends Error {
  override readonly name = "OverloadedError";
}

/** The request names a dimension, level, or position this server never serves. */
export class InvalidRegionError extends Error {
  override readonly name = "InvalidRegionError";
}

interface InFlight {
  readonly controller: AbortController;
  readonly promise: Promise<RegionResult>;
  waiters: number;
}

/**
 * Serves scene regions from memory, the disk cache, or a bounded set of builds.
 * Regions outside the stored area are answered with an empty region without any
 * build or disk write, so a camera looking at the horizon costs nothing, and a
 * client cannot fill the cache with regions far from the world.
 */
export class RegionService {
  private readonly options: RegionServiceOptions;
  private readonly memory = new Map<string, Uint8Array>();
  private readonly inFlight = new Map<string, InFlight>();
  private memoryBytes = 0;
  private built = 0;
  private rejected = 0;
  private failed = 0;

  constructor(options: RegionServiceOptions) {
    this.options = options;
  }

  get stats(): RegionServiceStats {
    return {
      inFlight: this.inFlight.size,
      maxPending: this.options.maxPending,
      memoryEntries: this.memory.size,
      memoryBytes: this.memoryBytes,
      built: this.built,
      rejected: this.rejected,
      failed: this.failed,
    };
  }

  async load(
    dimension: Dimension,
    request: RegionRequest,
    signal: AbortSignal,
  ): Promise<RegionResult> {
    const startedAt = performance.now();
    const { level, x, z } = request;
    if (!this.options.dimensions.has(dimension)) {
      throw new InvalidRegionError(`Dimension ${dimension} is not served`);
    }
    validateRegion(level, x, z);
    const bounds = this.options.dimensions.get(dimension);
    if (bounds === undefined || !regionTouches(bounds, regionSpan(level), x, z)) {
      return {
        bytes: emptyRegionBytes(level, x, z),
        cacheStatus: "empty",
        milliseconds: performance.now() - startedAt,
      };
    }

    const key = `${dimension}/${level}/${x}/${z}`;
    const remembered = this.memory.get(key);
    if (remembered !== undefined) {
      this.memory.delete(key);
      this.memory.set(key, remembered);
      return {
        bytes: remembered,
        cacheStatus: "memory",
        milliseconds: performance.now() - startedAt,
      };
    }

    let flight = this.inFlight.get(key);
    // A build every earlier caller abandoned is being dropped: start a fresh one.
    if (flight?.controller.signal.aborted === true) flight = undefined;
    if (flight === undefined) {
      if (this.inFlight.size >= this.options.maxPending) {
        this.rejected += 1;
        throw new OverloadedError("Too many regions are being built; retry shortly");
      }
      const controller = new AbortController();
      const promise = this.readOrBuild(key, dimension, request, controller.signal);
      flight = { controller, promise, waiters: 0 };
      this.inFlight.set(key, flight);
      const settled = flight;
      void promise
        .catch(() => undefined)
        .finally(() => {
          if (this.inFlight.get(key) === settled) this.inFlight.delete(key);
        });
    }
    return this.wait(flight, signal);
  }

  /** Resolves with the shared build, or rejects for this caller alone when it aborts. */
  private wait(flight: InFlight, signal: AbortSignal): Promise<RegionResult> {
    if (signal.aborted) return Promise.reject(abortError());
    flight.waiters += 1;
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        flight.waiters -= 1;
        // Nobody wants it any more: drop the build if no worker has started it.
        if (flight.waiters === 0) flight.controller.abort();
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (result) => {
          signal.removeEventListener("abort", onAbort);
          flight.waiters -= 1;
          resolve(result);
        },
        (cause: unknown) => {
          signal.removeEventListener("abort", onAbort);
          flight.waiters -= 1;
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        },
      );
    });
  }

  private async readOrBuild(
    key: string,
    dimension: Dimension,
    request: RegionRequest,
    signal: AbortSignal,
  ): Promise<RegionResult> {
    const startedAt = performance.now();
    const store = this.options.store;
    const stored = await store?.read(key);
    if (stored !== undefined) {
      const bytes = aligned(stored);
      if (isValidRegion(bytes, request)) {
        this.remember(key, bytes);
        return { bytes, cacheStatus: "disk", milliseconds: performance.now() - startedAt };
      }
      this.options.onEvent?.("cache.discarded", { key });
      await store?.discard(key);
    }

    let built: BuiltBytes;
    try {
      built = await this.options.build(dimension, request, signal);
    } catch (cause) {
      if (!isAbort(cause)) {
        this.failed += 1;
        this.options.onEvent?.("region.build-failed", { key, message: String(cause) });
      }
      throw cause;
    }
    this.built += 1;
    const bytes = aligned(built.bytes);
    await store?.write(key, bytes);
    this.remember(key, bytes);
    return { bytes, cacheStatus: "build", milliseconds: built.milliseconds };
  }

  private remember(key: string, bytes: Uint8Array): void {
    const budget = this.options.memoryBytes;
    if (bytes.byteLength > budget) return;
    const previous = this.memory.get(key);
    if (previous !== undefined) this.memoryBytes -= previous.byteLength;
    this.memory.delete(key);
    this.memory.set(key, bytes);
    this.memoryBytes += bytes.byteLength;
    for (const [oldest, value] of this.memory) {
      if (this.memoryBytes <= budget) break;
      this.memory.delete(oldest);
      this.memoryBytes -= value.byteLength;
    }
  }
}

/** Rejects levels and positions the viewer never asks for, before any work. */
export function validateRegion(level: number, x: number, z: number): void {
  if (!Number.isSafeInteger(level) || level < 0 || level > MAX_REGION_LEVEL) {
    throw new InvalidRegionError(`Region level must be 0 through ${MAX_REGION_LEVEL}`);
  }
  const limit = Math.ceil(WORLD_LIMIT / regionSpan(level));
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(z) ||
    Math.abs(x) > limit ||
    Math.abs(z) > limit
  ) {
    throw new InvalidRegionError("Region coordinates lie beyond the world border");
  }
}

/** A region with no blocks, which the viewer treats as already loaded and empty. */
export function emptyRegionBytes(level: number, x: number, z: number): Uint8Array {
  const empty = new Uint32Array(0);
  return encodeSceneRegion({
    level,
    x,
    z,
    heights: new Int16Array(regionGridSize(level) ** 2).fill(EMPTY_HEIGHT),
    minY: 0,
    maxY: 0,
    opaque: empty,
    plants: empty,
    translucent: empty,
  });
}

function isValidRegion(bytes: Uint8Array, request: RegionRequest): boolean {
  try {
    const region = decodeSceneRegion(bytes);
    return region.level === request.level && region.x === request.x && region.z === request.z;
  } catch {
    return false;
  }
}

/** Region decoding needs a four-byte aligned start. */
function aligned(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset % 4 === 0) return bytes;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function abortError(): Error {
  return new DOMException("The region request was cancelled", "AbortError");
}

export function isAbort(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}
