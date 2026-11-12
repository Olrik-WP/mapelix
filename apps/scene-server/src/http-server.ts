import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Dimension } from "@mapelix/scene-prototype";

import { DIMENSIONS, type BlockBounds } from "./config.js";
import {
  InvalidRegionError,
  NotCachedError,
  OverloadedError,
  isAbort,
  type LoadOptions,
  type RegionResult,
} from "./region-service.js";

/** Bumped whenever a response shape or a route changes incompatibly. */
export const API_VERSION = 1;

export interface WorldDescription {
  readonly apiVersion: number;
  readonly name: string;
  readonly spawn: { readonly x: number; readonly y: number; readonly z: number };
  readonly revision: string;
  readonly regionFormatVersion: number;
  readonly maxRegionLevel: number;
  readonly dimensions: readonly {
    readonly id: Dimension;
    /** Stored blocks, or null when the dimension holds no chunks in this world. */
    readonly bounds: BlockBounds | null;
  }[];
}

export interface RegionLoader {
  load(
    dimension: Dimension,
    request: { readonly level: number; readonly x: number; readonly z: number },
    signal: AbortSignal,
    options?: LoadOptions,
  ): Promise<RegionResult>;
}

export interface SceneHandlerOptions {
  readonly world: WorldDescription;
  readonly regions: RegionLoader;
  readonly health: () => Record<string, unknown>;
  readonly onEvent?: (event: string, detail: Record<string, unknown>) => void;
  /**
   * For an anonymous front end: regions come only from the cache, a missing one
   * answers 404, and the health route is not offered.
   */
  readonly cacheOnly?: boolean;
}

const REGION_ROUTE = /^\/v1\/dimensions\/([a-z-]{1,16})\/regions\/(\d)\/(-?\d{1,9})\/(-?\d{1,9})$/;
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

    const match = REGION_ROUTE.exec(url.pathname);
    if (match === null) return sendJson(response, 404, { error: "not-found" });
    const dimension = DIMENSIONS.find((candidate) => candidate === match[1]);
    if (dimension === undefined || !served.has(dimension)) {
      return sendJson(response, 404, { error: "dimension-not-served" });
    }
    const revision = url.searchParams.get("revision");
    if (revision !== null && revision !== options.world.revision) {
      // The client holds a view of an older snapshot and must reload the world.
      return sendJson(response, 409, {
        error: "revision-changed",
        revision: options.world.revision,
      });
    }

    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
    const region = { level: Number(match[2]), x: Number(match[3]), z: Number(match[4]) };
    const loadOptions = options.cacheOnly === true ? { cacheOnly: true } : {};
    options.regions.load(dimension, region, controller.signal, loadOptions).then(
      (result) => sendRegion(response, result, revision !== null),
      (cause: unknown) => {
        if (isAbort(cause) || response.destroyed) return;
        if (cause instanceof InvalidRegionError) {
          return sendJson(response, 400, { error: "invalid-region", message: cause.message });
        }
        if (cause instanceof NotCachedError) {
          return sendJson(response, 404, { error: "not-cached" });
        }
        if (cause instanceof OverloadedError) {
          response.setHeader("retry-after", "2");
          return sendJson(response, 503, { error: "overloaded" });
        }
        options.onEvent?.("http.region-failed", { region, message: String(cause) });
        return sendJson(response, 500, { error: "build-failed" });
      },
    );
  };
}

function sendRegion(response: ServerResponse, result: RegionResult, pinned: boolean): void {
  if (response.destroyed) return;
  response.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": result.bytes.byteLength,
    // A region URL with its revision never changes; without one it may.
    "cache-control": pinned ? "public, max-age=31536000, immutable" : "no-store",
    "server-timing": `region;dur=${result.milliseconds.toFixed(1)}`,
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
