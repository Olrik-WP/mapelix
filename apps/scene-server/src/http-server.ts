import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Dimension, RegionRequest } from "@mapelix/scene-prototype";
import { parseDimension } from "@mapelix/scene-prototype/dimensions";
import {
  DISCOVERY_SCHEMA_VERSION,
  type DiscoveryRequest,
} from "@mapelix/scene-prototype/discoveries";

import { DIMENSIONS, type BlockBounds } from "./config.js";
import {
  InvalidRegionError,
  NotCachedError,
  OverloadedError,
  isAbort,
  type LoadOptions,
  type RegionResult,
} from "./region-service.js";

/**
 * Bumped whenever a response shape or a route changes incompatibly.
 * 2: per-dimension profiles in /v1/world and the `ceilingY` region parameter.
 * 3: cave slices (`mode=caves`, `minY`, `maxY`), discovery indexes, and
 *    `snapshotRevision`, `caves` and `discoveries` in /v1/world.
 */
export const API_VERSION = 3;

export interface DimensionDescription {
  readonly id: Dimension;
  readonly label: string;
  /** Stored blocks, or null when the dimension holds no chunks in this world. */
  readonly bounds: BlockBounds | null;
  readonly minY: number;
  /** Exclusive. */
  readonly maxY: number;
  /** Exclusive mesh ceiling used when a request names none, and by the prewarm. */
  readonly defaultCeilingY: number;
  /** Where a viewer starts: a navigation default, not a discovered portal or player. */
  readonly spawn: { readonly x: number; readonly y: number; readonly z: number };
}

export interface WorldDescription {
  readonly apiVersion: number;
  readonly name: string;
  readonly spawn: { readonly x: number; readonly y: number; readonly z: number };
  readonly revision: string;
  /**
   * The revision discovery requests carry. It is the region revision itself, so a
   * new engine also rebuilds the indexes and no cache keeps an older detector.
   */
  readonly snapshotRevision: string;
  readonly regionFormatVersion: number;
  readonly maxRegionLevel: number;
  readonly dimensions: readonly DimensionDescription[];
  /** Cave slices this server builds: thicknesses in blocks and the finest levels. */
  readonly caves: {
    readonly thicknesses: readonly number[];
    readonly defaultThickness: number;
    readonly maxLevel: number;
  };
  readonly discoveries: { readonly schemaVersion: number; readonly tileSpan: number } | null;
}

export interface RegionLoader {
  load(
    dimension: Dimension,
    request: RegionRequest,
    signal: AbortSignal,
    options?: LoadOptions,
  ): Promise<RegionResult>;
}

export interface DiscoveryLoader {
  load(
    dimension: Dimension,
    tile: DiscoveryRequest,
    signal: AbortSignal,
    options?: LoadOptions,
  ): Promise<RegionResult>;
}

export interface SceneHandlerOptions {
  readonly world: WorldDescription;
  readonly regions: RegionLoader;
  readonly discoveries?: DiscoveryLoader;
  readonly health: () => Record<string, unknown>;
  readonly onEvent?: (event: string, detail: Record<string, unknown>) => void;
  /**
   * For an anonymous front end: regions come only from the cache, a missing one
   * answers 404, and the health route is not offered.
   */
  readonly cacheOnly?: boolean;
  /**
   * With `cacheOnly`: cave slices and discovery indexes may still be built, with at
   * most this many such requests waiting at once (503 beyond). Surface regions stay
   * cache-only: the prewarm builds them all.
   */
  readonly publicBuilds?: number;
}

const REGION_ROUTE = /^\/v1\/dimensions\/([a-z-]{1,16})\/regions\/(\d)\/(-?\d{1,9})\/(-?\d{1,9})$/;
const DISCOVERY_ROUTE = /^\/v1\/dimensions\/([a-z-]{1,16})\/discoveries\/(-?\d{1,9})\/(-?\d{1,9})$/;
const HEIGHT = /^-?\d{1,3}$/;
const MAX_URL_LENGTH = 256;

/**
 * Read-only routes. Nothing in a request names a file: the dimension is checked
 * against a fixed list and coordinates are bounded integers. Responses carry no
 * filesystem paths.
 */
export function createSceneHandler(
  options: SceneHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  const served = new Set(options.world.dimensions.map((entry) => entry.id));
  // Public cave and discovery requests waiting on a build, across every connection.
  let publicBuilding = 0;
  return (request, response) => {
    response.setHeader("x-content-type-options", "nosniff");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      return sendJson(response, 405, { error: "method-not-allowed" });
    }
    const raw = request.url ?? "/";
    if (raw.length > MAX_URL_LENGTH) return sendJson(response, 414, { error: "uri-too-long" });
    let url: URL;
    try {
      url = new URL(raw, "http://scene.invalid");
    } catch {
      return sendJson(response, 400, { error: "bad-request" });
    }

    if (url.pathname === "/v1/health" && options.cacheOnly !== true) {
      return sendJson(response, 200, { status: "ok", ...options.health() });
    }
    if (url.pathname === "/v1/world") return sendJson(response, 200, options.world);

    const regionMatch = REGION_ROUTE.exec(url.pathname);
    const discoveryMatch = regionMatch === null ? DISCOVERY_ROUTE.exec(url.pathname) : null;
    const match = regionMatch ?? discoveryMatch;
    if (match === null || (discoveryMatch !== null && options.discoveries === undefined)) {
      return sendJson(response, 404, { error: "not-found" });
    }
    const dimension = DIMENSIONS.find((candidate) => candidate === match[1]);
    if (dimension === undefined || !served.has(dimension)) {
      return sendJson(response, 404, { error: "dimension-not-served" });
    }
    // The viewer repeats the dimension in the query; it must agree with the path.
    const named = url.searchParams.get("dimension");
    let sameDimension = true;
    try {
      sameDimension = named === null || parseDimension(named) === dimension;
    } catch {
      sameDimension = false;
    }
    if (!sameDimension) return sendJson(response, 400, { error: "invalid-context" });

    let job: (signal: AbortSignal, loadOptions: LoadOptions) => Promise<RegionResult>;
    let label: string;
    let mayBuildInPublic: boolean;
    let expectedRevision: string;
    if (regionMatch !== null) {
      const heights: Record<string, number> = {};
      for (const name of ["ceilingY", "minY", "maxY"]) {
        const text = url.searchParams.get(name);
        if (text === null) continue;
        if (!HEIGHT.test(text)) return sendJson(response, 400, { error: "invalid-context" });
        heights[name] = Number(text);
      }
      const mode = url.searchParams.get("mode");
      if (mode !== null && mode !== "surface" && mode !== "caves") {
        return sendJson(response, 400, { error: "invalid-context" });
      }
      const region: RegionRequest = {
        level: Number(regionMatch[2]),
        x: Number(regionMatch[3]),
        z: Number(regionMatch[4]),
        ...(mode === null ? {} : { mode }),
        ...heights,
      };
      job = (signal, loadOptions) => options.regions.load(dimension, region, signal, loadOptions);
      label = "region";
      mayBuildInPublic = mode === "caves";
      expectedRevision = options.world.revision;
    } else {
      const schema = url.searchParams.get("schema");
      if (schema !== null && schema !== String(DISCOVERY_SCHEMA_VERSION)) {
        return sendJson(response, 400, { error: "unsupported-schema" });
      }
      const tile = { x: Number(match[2]), z: Number(match[3]) };
      const loader = options.discoveries!;
      job = (signal, loadOptions) => loader.load(dimension, tile, signal, loadOptions);
      label = "discoveries";
      mayBuildInPublic = true;
      expectedRevision = options.world.snapshotRevision;
    }
    const revision = url.searchParams.get("revision");
    if (revision !== null && revision !== expectedRevision) {
      // The client holds a view of an older snapshot and must reload the world.
      return sendJson(response, 409, { error: "revision-changed", revision: expectedRevision });
    }

    let loadOptions: LoadOptions = {};
    let release = (): void => undefined;
    if (options.cacheOnly === true) {
      const limit = options.publicBuilds ?? 0;
      if (!mayBuildInPublic || limit < 1) {
        loadOptions = { cacheOnly: true };
      } else if (publicBuilding >= limit) {
        response.setHeader("retry-after", "2");
        return sendJson(response, 503, { error: "overloaded" });
      } else {
        publicBuilding += 1;
        let released = false;
        release = () => {
          if (released) return;
          released = true;
          publicBuilding -= 1;
        };
      }
    }

    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    job(controller.signal, loadOptions)
      .then(
        (result) => sendBinary(response, label, result, revision !== null),
        (cause: unknown) => {
          if (isAbort(cause) || response.destroyed) return;
          if (cause instanceof InvalidRegionError) {
            return sendJson(response, 400, { error: `invalid-${label}`, message: cause.message });
          }
          if (cause instanceof NotCachedError) {
            return sendJson(response, 404, { error: "not-cached" });
          }
          if (cause instanceof OverloadedError) {
            response.setHeader("retry-after", "2");
            return sendJson(response, 503, { error: "overloaded" });
          }
          options.onEvent?.(`http.${label}-failed`, {
            path: url.pathname,
            message: String(cause),
          });
          return sendJson(response, 500, { error: "build-failed" });
        },
      )
      .finally(release);
  };
}

function sendBinary(
  response: ServerResponse,
  label: string,
  result: RegionResult,
  pinned: boolean,
): void {
  if (response.destroyed) return;
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": result.bytes.byteLength,
    // A URL with its revision never changes; without one it may.
    "cache-control": pinned ? "public, max-age=31536000, immutable" : "no-store",
    "server-timing": `${label};dur=${result.milliseconds.toFixed(1)}`,
    "x-mapelix-cache": result.cacheStatus,
  });
  response.end(result.bytes);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed) return;
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

/** Creates the HTTP server with conservative timeouts for a private socket. */
export function createSceneServer(options: SceneHandlerOptions): Server {
  const server = createServer(createSceneHandler(options));
  server.headersTimeout = 10_000;
  // The coarsest regions can take tens of seconds on a large world behind a queue.
  server.requestTimeout = 180_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}
