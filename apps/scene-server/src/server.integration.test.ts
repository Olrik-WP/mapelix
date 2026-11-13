import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { decodeDiscoveryTile } from "@mapelix/scene-prototype/discoveries";
import { decodeSceneRegion } from "@mapelix/scene-prototype/format";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const fixture = fileURLToPath(
  new URL("../../../packages/mapelix-prototype/test/fixtures/2000world.mcworld", import.meta.url),
);
const fixtureHash = "9f102af4e5ba617820c8da723956745450b4ebf7c31d676d8db038038367b35b";
const main = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const unixSockets = process.platform !== "win32";

let work: string;
let world: string;

interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Buffer;
}

function get(target: { socketPath: string } | { port: number }, path: string, method = "GET") {
  return new Promise<Reply>((resolve, reject) => {
    const options =
      "socketPath" in target
        ? { socketPath: target.socketPath, path, method }
        : { host: "127.0.0.1", port: target.port, path, method };
    const request = httpRequest(options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(),
      );
    });
  });
}

/** Starts the built server as a child process, the way systemd does. */
async function startServer(env: Record<string, string>) {
  const child = spawn(process.execPath, [main], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  const deadline = Date.now() + 20_000;
  while (!output.includes('"server.ready"')) {
    if (child.exitCode !== null) throw new Error(`Server exited early:\n${output}`);
    if (Date.now() > deadline) throw new Error(`Server did not start:\n${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { child, exited, output: () => output };
}

beforeAll(async () => {
  const archive = await readFile(fixture);
  expect(createHash("sha256").update(archive).digest("hex")).toBe(fixtureHash);
  work = await mkdtemp(join(tmpdir(), "mapelix-server-"));
  world = join(work, "world");
  await run("unzip", ["-qq", fixture, "-d", world]);
}, 30_000);

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("scene server process", () => {
  it("serves a real world, bounds requests, and stops cleanly", async () => {
    const cache = join(work, "cache");
    const target = unixSockets
      ? { socketPath: join(work, "scene.sock") }
      : { port: await freePort() };
    const listen =
      "socketPath" in target ? `unix:${target.socketPath}` : `tcp:127.0.0.1:${target.port}`;
    const server = await startServer({
      MAPELIX_WORLD_DIRECTORY: world,
      MAPELIX_CACHE_DIRECTORY: cache,
      MAPELIX_LISTEN: listen,
      MAPELIX_SCENE_WORKERS: "1",
      MAPELIX_MAX_PENDING: "4",
    });
    try {
      const description = JSON.parse((await get(target, "/v1/world")).body.toString());
      expect(description.apiVersion).toBe(3);
      expect(description.snapshotRevision).toBe(description.revision);
      expect(description.caves).toEqual({
        thicknesses: [16, 32],
        defaultThickness: 32,
        maxLevel: 1,
      });
      expect(description.discoveries).toEqual({ schemaVersion: 1, tileSpan: 32 });
      expect(description.dimensions.map((entry: { id: string }) => entry.id)).toEqual([
        "overworld",
        "nether",
        "the-end",
      ]);
      expect(description.dimensions[1]).toMatchObject({ defaultCeilingY: 96, maxY: 128 });
      expect(description.revision).toMatch(/^[0-9a-f]{20}$/);
      expect(JSON.stringify(description)).not.toContain(work.replaceAll("\\", "\\\\"));
      const bounds = description.dimensions[0].bounds;
      expect(bounds.minX).toBeLessThanOrEqual(bounds.maxX);

      // A region at the stored area's corner is built, then served from memory.
      const x = Math.floor(bounds.minX / 64);
      const z = Math.floor(bounds.minZ / 64);
      const path = `/v1/dimensions/overworld/regions/0/${x}/${z}?revision=${description.revision}`;
      const built = await get(target, path);
      expect(built.status).toBe(200);
      expect(built.headers["x-mapelix-cache"]).toBe("build");
      expect(built.headers["cache-control"]).toContain("immutable");
      expect(decodeSceneRegion(new Uint8Array(built.body))).toMatchObject({ level: 0, x, z });
      expect((await get(target, path)).headers["x-mapelix-cache"]).toBe("memory");
      // The viewer's own query: same region, same cache entry.
      const withContext = `/v1/dimensions/overworld/regions/0/${x}/${z}?dimension=overworld&ceilingY=320&revision=${description.revision}`;
      expect((await get(target, withContext)).headers["x-mapelix-cache"]).toBe("memory");
      // Another ceiling is another region.
      const lower = `/v1/dimensions/overworld/regions/0/${x}/${z}?ceilingY=64`;
      expect((await get(target, lower)).headers["x-mapelix-cache"]).toBe("build");
      for (const query of ["ceilingY=100", "ceilingY=abc", "ceilingY=1600", "dimension=nether"]) {
        const refused = await get(target, `/v1/dimensions/overworld/regions/0/${x}/${z}?${query}`);
        expect(refused.status, query).toBe(400);
      }

      const far = await get(target, "/v1/dimensions/overworld/regions/0/100000/100000");
      expect(far.headers["x-mapelix-cache"]).toBe("empty");
      // The fixture stores no Nether: its regions are empty, never built.
      const nether = await get(target, "/v1/dimensions/nether/regions/0/0/0?ceilingY=128");
      expect(nether.headers["x-mapelix-cache"]).toBe("empty");
      expect((await get(target, "/v1/dimensions/nether/regions/0/0/0?ceilingY=320")).status).toBe(
        400,
      );
      expect((await get(target, "/v1/dimensions/the-sky/regions/0/0/0")).status).toBe(404);
      expect((await get(target, "/v1/dimensions/overworld/regions/7/0/0")).status).toBe(400);
      expect((await get(target, "/v1/dimensions/overworld/regions/0/0/0?revision=0")).status).toBe(
        409,
      );
      expect((await get(target, "/v1/world", "DELETE")).status).toBe(405);
      expect((await get(target, "/v1/../../etc/passwd")).status).toBe(404);

      // A cave slice is its own region, cached apart from the surface.
      const slice = `/v1/dimensions/overworld/regions/0/${x}/${z}?dimension=overworld&mode=caves&minY=0&maxY=32&revision=${description.revision}`;
      const cave = await get(target, slice);
      expect(cave.status).toBe(200);
      expect(cave.headers["x-mapelix-cache"]).toBe("build");
      expect(decodeSceneRegion(new Uint8Array(cave.body))).toMatchObject({ level: 0, x, z });
      expect((await get(target, slice)).headers["x-mapelix-cache"]).toBe("memory");
      for (const query of [
        "mode=caves&minY=0&maxY=48",
        "mode=caves&minY=8&maxY=40",
        "mode=caves&minY=-96&maxY=-64",
        "mode=caves&minY=0&maxY=32&ceilingY=16",
        "mode=tunnels",
        "minY=0",
      ]) {
        const refused = await get(target, `/v1/dimensions/overworld/regions/0/${x}/${z}?${query}`);
        expect(refused.status, query).toBe(400);
      }
      const coarse = `/v1/dimensions/overworld/regions/2/0/0?mode=caves&minY=0&maxY=32`;
      expect((await get(target, coarse)).status).toBe(400);

      // Discovery indexes: one per 32-block tile, keyed by the snapshot revision.
      const tileX = Math.floor(bounds.minX / 32);
      const tileZ = Math.floor(bounds.minZ / 32);
      const tilePath = `/v1/dimensions/overworld/discoveries/${tileX}/${tileZ}?dimension=overworld&revision=${description.snapshotRevision}&schema=1`;
      const tile = await get(target, tilePath);
      expect(tile.status).toBe(200);
      expect(tile.headers["x-mapelix-cache"]).toBe("build");
      expect(tile.headers["cache-control"]).toContain("immutable");
      expect(decodeDiscoveryTile(new Uint8Array(tile.body))).toMatchObject({
        dimension: "overworld",
        x: tileX,
        z: tileZ,
      });
      expect((await get(target, tilePath)).headers["x-mapelix-cache"]).toBe("memory");
      const farTile = await get(target, "/v1/dimensions/overworld/discoveries/900000/900000");
      expect(farTile.headers["x-mapelix-cache"]).toBe("empty");
      expect((await get(target, `${tilePath.replace("schema=1", "schema=2")}`)).status).toBe(400);
      expect(
        (await get(target, `/v1/dimensions/overworld/discoveries/0/0?revision=${"f".repeat(20)}`))
          .status,
      ).toBe(409);
      expect((await get(target, "/v1/dimensions/overworld/discoveries/99999999/0")).status).toBe(
        400,
      );

      const health = JSON.parse((await get(target, "/v1/health")).body.toString());
      expect(health).toMatchObject({ status: "ok", builds: { built: 2 }, cache: { entries: 2 } });
      expect(health.caves).toMatchObject({ builds: { built: 1 }, cache: { entries: 1 } });
      expect(health.discoveries).toMatchObject({ builds: { built: 1 }, cache: { entries: 1 } });
      expect(health.openDimensions).toEqual(["overworld"]);
    } finally {
      server.child.kill("SIGTERM");
    }
    // Windows has no SIGTERM handler; there the process is simply ended.
    const code = await server.exited;
    if (unixSockets) expect(code).toBe(0);

    // A restart on the same snapshot reuses the disk cache and the saved extent.
    const again = await startServer({
      MAPELIX_WORLD_DIRECTORY: world,
      MAPELIX_CACHE_DIRECTORY: cache,
      MAPELIX_LISTEN: listen,
    });
    try {
      expect(again.output()).not.toContain("world.extent-scanned");
      const health = JSON.parse((await get(target, "/v1/health")).body.toString());
      expect(health.cache.entries).toBe(2);
      expect(health.caves.cache.entries).toBe(1);
      expect(health.discoveries.cache.entries).toBe(1);
    } finally {
      again.child.kill("SIGTERM");
      await again.exited;
    }
    // One revision folder for the surface, and the caves and discoveries partitions.
    const folders = await readdir(cache);
    expect(folders.filter((name) => /^[0-9a-f]{20}$/.test(name))).toHaveLength(1);
    expect(folders.filter((name) => !/^[0-9a-f]{20}$/.test(name)).sort()).toEqual([
      "caves",
      "discoveries-v1",
    ]);
  }, 60_000);

  it("serves anonymous front ends from the cache only, filled by the prewarm", async () => {
    const privateTarget = unixSockets
      ? { socketPath: join(work, "private.sock") }
      : { port: await freePort() };
    const publicTarget = unixSockets
      ? { socketPath: join(work, "public.sock") }
      : { port: await freePort() };
    const address = (target: { socketPath: string } | { port: number }) =>
      "socketPath" in target ? `unix:${target.socketPath}` : `tcp:127.0.0.1:${target.port}`;
    const environment = {
      MAPELIX_WORLD_DIRECTORY: world,
      MAPELIX_LISTEN: address(privateTarget),
      MAPELIX_PUBLIC_LISTEN: address(publicTarget),
      MAPELIX_PUBLIC_SOCKET_MODE: "666",
    };

    // Without a prewarm, the public socket refuses what is not built yet.
    const cold = await startServer({ ...environment, MAPELIX_CACHE_DIRECTORY: join(work, "cold") });
    try {
      const description = JSON.parse((await get(publicTarget, "/v1/world")).body.toString());
      const bounds = description.dimensions[0].bounds;
      const path = `/v1/dimensions/overworld/regions/2/${Math.floor(bounds.minX / 256)}/${Math.floor(bounds.minZ / 256)}`;
      expect((await get(publicTarget, path)).status).toBe(404);
      expect((await get(publicTarget, "/v1/health")).status).toBe(404);
      expect((await get(privateTarget, path)).headers["x-mapelix-cache"]).toBe("build");
      const cached = await get(publicTarget, path);
      expect(cached.status).toBe(200);
      expect(decodeSceneRegion(new Uint8Array(cached.body)).level).toBe(2);
      // Builds are off for the public socket by default: caves and discoveries too.
      const slice = `/v1/dimensions/overworld/regions/0/${Math.floor(bounds.minX / 64)}/${Math.floor(bounds.minZ / 64)}?mode=caves&minY=0&maxY=32`;
      expect((await get(publicTarget, slice)).status).toBe(404);
      const tile = `/v1/dimensions/overworld/discoveries/${Math.floor(bounds.minX / 32)}/${Math.floor(bounds.minZ / 32)}`;
      expect((await get(publicTarget, tile)).status).toBe(404);
      if ("socketPath" in publicTarget) {
        const { stat } = await import("node:fs/promises");
        expect((await stat(publicTarget.socketPath)).mode & 0o777).toBe(0o666);
      }
    } finally {
      cold.child.kill("SIGTERM");
      await cold.exited;
    }

    // With a prewarm, every region of the stored area is ready for the public socket,
    // then every discovery index; public builds let it build cave slices too.
    const warm = await startServer({
      ...environment,
      MAPELIX_CACHE_DIRECTORY: join(work, "warm"),
      MAPELIX_PREWARM: "1",
      MAPELIX_PUBLIC_BUILDS: "1",
    });
    try {
      const deadline = Date.now() + 40_000;
      let prewarm: { state: string; done: number; total: number } = {
        state: "",
        done: 0,
        total: 1,
      };
      while (prewarm.state !== "done" && Date.now() < deadline) {
        prewarm = JSON.parse((await get(privateTarget, "/v1/health")).body.toString()).prewarm;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(prewarm.state).toBe("done");
      expect(prewarm.done).toBe(prewarm.total);
      let discoveries = { state: "", done: 0, total: 1 };
      while (discoveries.state !== "done" && Date.now() < deadline) {
        const health = JSON.parse((await get(privateTarget, "/v1/health")).body.toString());
        discoveries = health.discoveries.prewarm;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(discoveries.state).toBe("done");
      expect(discoveries.total).toBeGreaterThan(0);
      const description = JSON.parse((await get(publicTarget, "/v1/world")).body.toString());
      const bounds = description.dimensions[0].bounds;
      const tile = await get(
        publicTarget,
        `/v1/dimensions/overworld/discoveries/${Math.floor(bounds.maxX / 32)}/${Math.floor(bounds.maxZ / 32)}?revision=${description.snapshotRevision}`,
      );
      expect(tile.status).toBe(200);
      const slice = `/v1/dimensions/overworld/regions/0/${Math.floor(bounds.maxX / 64)}/${Math.floor(bounds.maxZ / 64)}?mode=caves&minY=-32&maxY=0`;
      const cave = await get(publicTarget, slice);
      expect(cave.status).toBe(200);
      expect(cave.headers["x-mapelix-cache"]).toBe("build");
      // The surface stays cache-only even with public builds on.
      const lower = `/v1/dimensions/overworld/regions/0/${Math.floor(bounds.maxX / 64)}/${Math.floor(bounds.maxZ / 64)}?ceilingY=64`;
      expect((await get(publicTarget, lower)).status).toBe(404);
      for (let level = 0; level <= 5; level += 1) {
        const span = 64 << level;
        const path = `/v1/dimensions/overworld/regions/${level}/${Math.floor(bounds.maxX / span)}/${Math.floor(bounds.maxZ / span)}`;
        expect((await get(publicTarget, path)).status, path).toBe(200);
      }
    } finally {
      warm.child.kill("SIGTERM");
      await warm.exited;
    }
  }, 90_000);

  it("treats a missing world as a configuration error", async () => {
    const child = spawn(process.execPath, [main], {
      env: {
        ...process.env,
        MAPELIX_WORLD_DIRECTORY: join(work, "missing-world"),
        MAPELIX_CACHE_DIRECTORY: join(work, "cache3"),
      },
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(78);
  }, 20_000);

  it("refuses to start with an unsafe configuration", async () => {
    const child = spawn(process.execPath, [main], {
      env: {
        ...process.env,
        MAPELIX_WORLD_DIRECTORY: world,
        MAPELIX_CACHE_DIRECTORY: join(work, "cache2"),
        MAPELIX_LISTEN: "tcp:0.0.0.0:5999",
      },
      stdio: "ignore",
    });
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    expect(code).toBe(78);
  }, 20_000);
});
