import { chmod, lstat, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";

import { openSceneWorld, type Dimension } from "@mapelix/scene-prototype";
import { CAVE_LIMITS } from "@mapelix/scene-prototype/dimensions";
import {
  DISCOVERY_SCHEMA_VERSION,
  DISCOVERY_TILE_SPAN,
} from "@mapelix/scene-prototype/discoveries";
import { MAX_REGION_LEVEL, REGION_FORMAT_VERSION } from "@mapelix/scene-prototype/format";

import {
  ConfigError,
  readConfig,
  type BlockBounds,
  type ListenTarget,
  type ServerConfig,
} from "./config.js";
import { DiscoveryService, discoveryTiles } from "./discovery-service.js";
import { DiskCache } from "./disk-cache.js";
import { parseExtent, scanWorldExtent, type WorldExtent } from "./extent.js";
import {
  API_VERSION,
  createSceneServer,
  type RegionLoader,
  type WorldDescription,
} from "./http-server.js";
import { log } from "./log.js";
import { DimensionPools } from "./pools.js";
import { describeDimension } from "./world-description.js";
import { Prewarmer, prewarmPlan, type PrewarmJob } from "./prewarm.js";
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

  const cacheEvents = {
    onEvent: (event: string, detail: Record<string, unknown>) => log("info", event, detail),
  };
  const disk = await DiskCache.open(
    config.cacheDirectory,
    revision,
    config.diskCacheBytes,
    cacheEvents,
  );
  // Caves and discoveries keep their own folders and budgets: they never evict the surface.
  const caveDisk = await DiskCache.open(
    join(config.cacheDirectory, "caves"),
    revision,
    config.caves.diskBytes,
    cacheEvents,
  );
  const discoveryFolder = `discoveries-v${DISCOVERY_SCHEMA_VERSION}`;
  await removeOldDiscoveryFolders(config.cacheDirectory, discoveryFolder);
  const discoveryDisk = await DiskCache.open(
    join(config.cacheDirectory, discoveryFolder),
    revision,
    config.discoveries.diskBytes,
    cacheEvents,
  );
  const extent = await loadExtent(config, revision);

  const pools = new DimensionPools({
    open: (dimension) =>
      openSceneWorld({ directory: config.worldDirectory, dimension, workers: config.workers }),
    permits: config.workers,
    idleMilliseconds: config.poolIdleSeconds * 1000,
    onEvent: (event, detail) => log("info", event, detail),
  });
  // Opening the first dimension now proves the snapshot is readable before listening.
  const first = await pools.world(config.dimensions[0]!);

  const bounds = new Map<Dimension, BlockBounds | undefined>(
    config.dimensions.map((dimension) => [dimension, config.bounds ?? extent[dimension]]),
  );
  const surface = new RegionService({
    mode: "surface",
    dimensions: bounds,
    build: (dimension, request, signal, background) =>
      pools.build(dimension, request, signal, background),
    store: disk,
    memoryBytes: config.memoryCacheBytes,
    maxPending: config.maxPending,
    onEvent: (event, detail) => log("warn", event, detail),
  });
  const caves = new RegionService({
    mode: "caves",
    dimensions: bounds,
    build: (dimension, request, signal, background) =>
      pools.build(dimension, request, signal, background),
    store: caveDisk,
    memoryBytes: config.caves.memoryBytes,
    maxPending: config.caves.maxPending,
    onEvent: (event, detail) => log("warn", event, detail),
  });
  const regions: RegionLoader = {
    load: (dimension, request, signal, options) =>
      (request.mode === "caves" ? caves : surface).load(dimension, request, signal, options),
  };
  const discoveries = new DiscoveryService({
    dimensions: bounds,
    build: (dimension, tile, signal, background) =>
      pools.discoveries(dimension, tile, signal, background),
    store: discoveryDisk,
    memoryBytes: config.discoveries.memoryBytes,
    memoryEntries: 256,
    maxPending: config.discoveries.maxPending,
    onEvent: (event, detail) => log("warn", event, detail),
  });

  const world: WorldDescription = {
    apiVersion: API_VERSION,
    name: first.info.name,
    spawn: first.info.spawn,
    revision,
    snapshotRevision: revision,
    regionFormatVersion: REGION_FORMAT_VERSION,
    maxRegionLevel: MAX_REGION_LEVEL,
    dimensions: config.dimensions.map((id) =>
      describeDimension(id, bounds.get(id), first.info.spawn),
    ),
    caves: {
      thicknesses: [...CAVE_LIMITS.thicknesses],
      defaultThickness: CAVE_LIMITS.defaultThickness,
      maxLevel: CAVE_LIMITS.maxLevel,
    },
    discoveries: { schemaVersion: DISCOVERY_SCHEMA_VERSION, tileSpan: DISCOVERY_TILE_SPAN },
  };
  const prewarmer = new Prewarmer(
    surface,
    config.prewarm ? prewarmPlan(bounds, config.prewarmMaxRegions) : [],
    () => disk.stats.bytes > disk.stats.maxBytes * 0.85,
    (event, detail) => log("info", event, detail),
  );
  // Every discovery index after the surface: a few kilobytes per tile, and it lets
  // a cache-only front end show discoveries without building anything.
  const discoveryJobs: PrewarmJob[] =
    config.prewarm && config.prewarmDiscoveries
      ? [...bounds].flatMap(([dimension, stored]) =>
          stored === undefined
            ? []
            : discoveryTiles(stored).map((tile) => ({ dimension, level: 0, ...tile })),
        )
      : [];
  const discoveryPrewarmer = new Prewarmer(
    {
      load: (dimension, request, signal, options) =>
        discoveries.load(dimension, { x: request.x, z: request.z }, signal, options),
    },
    discoveryJobs,
    () => discoveryDisk.stats.bytes > discoveryDisk.stats.maxBytes * 0.85,
    (event, detail) => log("info", `discoveries.${event}`, detail),
  );
  const health = (): Record<string, unknown> => ({
    apiVersion: API_VERSION,
    revision,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    workers: config.workers,
    builds: surface.stats,
    cache: disk.stats,
    prewarm: prewarmer.progress,
    caves: { builds: caves.stats, cache: caveDisk.stats },
    discoveries: {
      builds: discoveries.stats,
      cache: discoveryDisk.stats,
      prewarm: discoveryPrewarmer.progress,
    },
    dimensions: config.dimensions,
    openDimensions: pools.openDimensions,
  });
  const onEvent = (event: string, detail: Record<string, unknown>): void =>
    log("warn", event, detail);
  const server = createSceneServer({ world, regions, discoveries, health, onEvent });
  await listen(server, config.listen);
  // Anonymous front ends get their own socket. It never builds a surface region, and
  // builds cave slices and discoveries only when allowed, a few at a time.
  const publicServer =
    config.publicListen === undefined
      ? undefined
      : createSceneServer({
          world,
          regions,
          discoveries,
          health,
          onEvent,
          cacheOnly: true,
          publicBuilds: config.publicBuilds ? config.publicMaxBuilds : 0,
        });
  if (publicServer !== undefined && config.publicListen !== undefined) {
    await listen(publicServer, config.publicListen);
  }
  log("info", "server.ready", {
    revision,
    name: world.name,
    dimensions: world.dimensions,
    publicListener: publicServer !== undefined,
    publicBuilds: config.publicBuilds,
    prewarm: config.prewarm,
  });
  const stopPrewarm = new AbortController();
  if (config.prewarm) {
    void prewarmer
      .run(stopPrewarm.signal)
      .then(() =>
        stopPrewarm.signal.aborted ? undefined : discoveryPrewarmer.run(stopPrewarm.signal),
      );
  }

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
    void pools.close().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

/** Discovery folders of an older index schema can never be read again. */
async function removeOldDiscoveryFolders(root: string, current: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      /^discoveries-v\d{1,4}$/.test(entry.name) &&
      entry.name !== current
    ) {
      await rm(join(root, entry.name), { recursive: true, force: true });
      log("info", "cache.schema-removed", { folder: entry.name });
    }
  }
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
