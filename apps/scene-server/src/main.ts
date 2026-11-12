import { chmod, lstat, readFile, stat, unlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";

import { openSceneWorld, type Dimension, type SceneWorld } from "@mapelix/scene-prototype";
import { MAX_REGION_LEVEL, REGION_FORMAT_VERSION } from "@mapelix/scene-prototype/format";

import {
  ConfigError,
  readConfig,
  type BlockBounds,
  type ListenTarget,
  type ServerConfig,
} from "./config.js";
import { DiskCache } from "./disk-cache.js";
import { parseExtent, scanWorldExtent, type WorldExtent } from "./extent.js";
import { API_VERSION, createSceneServer, type WorldDescription } from "./http-server.js";
import { log } from "./log.js";
import { Prewarmer, prewarmPlan } from "./prewarm.js";
import { RegionService } from "./region-service.js";
import { engineFingerprint, worldRevision } from "./revision.js";

const startedAt = Date.now();

async function main(): Promise<void> {
  const config = readConfig(process.env);
  await requireWorld(config.worldDirectory);
  const engine = await engineFingerprint();
  const revision = await worldRevision(config.worldDirectory, engine);
  log("info", "server.starting", {
    revision,
    dimensions: config.dimensions,
    workers: config.workers,
    maxPending: config.maxPending,
    diskCacheMb: config.diskCacheBytes / 1024 / 1024,
    memoryCacheMb: config.memoryCacheBytes / 1024 / 1024,
    listen: config.listen.kind === "unix" ? "unix" : `${config.listen.host}:${config.listen.port}`,
  });

  const disk = await DiskCache.open(config.cacheDirectory, revision, config.diskCacheBytes, {
    onEvent: (event, detail) => log("info", event, detail),
  });
  const extent = await loadExtent(config, revision);

  const worlds = new Map<Dimension, Promise<SceneWorld>>();
  const openWorld = (dimension: Dimension): Promise<SceneWorld> => {
    let opened = worlds.get(dimension);
    if (opened === undefined) {
      opened = openSceneWorld({
        directory: config.worldDirectory,
        dimension,
        workers: config.workers,
      });
      worlds.set(dimension, opened);
      opened.catch(() => worlds.delete(dimension));
    }
    return opened;
  };
  // Opening the first dimension now proves the snapshot is readable before listening.
  const first = await openWorld(config.dimensions[0]!);

  const bounds = new Map<Dimension, BlockBounds | undefined>(
    config.dimensions.map((dimension) => [dimension, config.bounds ?? extent[dimension]]),
  );
  const regions = new RegionService({
    dimensions: bounds,
    build: async (dimension, request, signal) =>
      (await openWorld(dimension)).buildRegion(request, signal),
    store: disk,
    memoryBytes: config.memoryCacheBytes,
    maxPending: config.maxPending,
    onEvent: (event, detail) => log("warn", event, detail),
  });

  const world: WorldDescription = {
    apiVersion: API_VERSION,
    name: first.info.name,
    spawn: first.info.spawn,
    revision,
    regionFormatVersion: REGION_FORMAT_VERSION,
    maxRegionLevel: MAX_REGION_LEVEL,
    dimensions: config.dimensions.map((id) => ({ id, bounds: bounds.get(id) ?? null })),
  };
  const prewarmer = new Prewarmer(
    regions,
    config.prewarm ? prewarmPlan(bounds, config.prewarmMaxRegions) : [],
    () => disk.stats.bytes > disk.stats.maxBytes * 0.85,
    (event, detail) => log("info", event, detail),
  );
  const health = (): Record<string, unknown> => ({
    apiVersion: API_VERSION,
    revision,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    workers: config.workers,
    builds: regions.stats,
    cache: disk.stats,
    prewarm: prewarmer.progress,
    dimensions: config.dimensions,
  });
  const onEvent = (event: string, detail: Record<string, unknown>): void =>
    log("warn", event, detail);
  const server = createSceneServer({ world, regions, health, onEvent });
  await listen(server, config.listen);
  // Anonymous front ends get their own socket, which can never start a build.
  const publicServer =
    config.publicListen === undefined
      ? undefined
      : createSceneServer({ world, regions, health, onEvent, cacheOnly: true });
  if (publicServer !== undefined && config.publicListen !== undefined) {
    await listen(publicServer, config.publicListen);
  }
  log("info", "server.ready", {
    revision,
    name: world.name,
    dimensions: world.dimensions,
    publicListener: publicServer !== undefined,
    prewarm: config.prewarm,
  });
  const stopPrewarm = new AbortController();
  if (config.prewarm) void prewarmer.run(stopPrewarm.signal);

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log("info", "server.stopping", { signal });
    stopPrewarm.abort();
    const forced = setTimeout(() => process.exit(0), 10_000);
    forced.unref();
    for (const running of [server, publicServer]) {
      running?.close();
      running?.closeIdleConnections();
    }
    void Promise.allSettled(
      [...worlds.values()].map(async (opened) => (await opened).close()),
    ).then(() => process.exit(0));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

/** A missing or partial snapshot is a configuration error: restarting cannot fix it. */
async function requireWorld(directory: string): Promise<void> {
  const [level, database] = await Promise.all([
    stat(join(directory, "level.dat")).catch(() => undefined),
    stat(join(directory, "db")).catch(() => undefined),
  ]);
  if (level?.isFile() !== true || database?.isDirectory() !== true) {
    throw new ConfigError("MAPELIX_WORLD_DIRECTORY holds no Bedrock world (level.dat and db/)");
  }
}

/** Uses MAPELIX_BOUNDS, the extent saved for this revision, or a fresh key scan. */
async function loadExtent(config: ServerConfig, revision: string): Promise<WorldExtent> {
  const empty: WorldExtent = { overworld: undefined, nether: undefined, "the-end": undefined };
  if (config.bounds !== undefined) return empty;
  const saved = join(config.cacheDirectory, revision, "extent.json");
  const cached = await readFile(saved, "utf8")
    .then(parseExtent)
    .catch(() => undefined);
  if (cached !== undefined) return cached;
  const scanStarted = performance.now();
  const extent = await scanWorldExtent(config.worldDirectory);
  log("info", "world.extent-scanned", {
    milliseconds: Math.round(performance.now() - scanStarted),
    extent,
  });
  await writeFile(saved, JSON.stringify(extent), { mode: 0o640 }).catch((cause: unknown) =>
    log("warn", "world.extent-not-saved", { message: String(cause) }),
  );
  return extent;
}

async function listen(server: Server, target: ListenTarget): Promise<void> {
  if (target.kind === "unix") {
    // Remove a socket left by an earlier process, but never any other kind of file.
    const existing = await lstat(target.path).catch(() => undefined);
    if (existing?.isSocket() === true) await unlink(target.path);
    else if (existing !== undefined)
      throw new ConfigError(`${target.path} exists and is not a socket`);
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    if (target.kind === "unix") server.listen(target.path, resolve);
    else server.listen(target.port, target.host, resolve);
  });
  if (target.kind === "unix") await chmod(target.path, target.mode);
}

main().catch((cause: unknown) => {
  log("error", "server.failed", {
    message: cause instanceof Error ? cause.message : String(cause),
    configuration: cause instanceof ConfigError,
  });
  process.exit(cause instanceof ConfigError ? 78 : 1);
});
