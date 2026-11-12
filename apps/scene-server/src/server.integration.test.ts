import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
      expect(description.apiVersion).toBe(1);
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

      const far = await get(target, "/v1/dimensions/overworld/regions/0/100000/100000");
      expect(far.headers["x-mapelix-cache"]).toBe("empty");
      expect((await get(target, "/v1/dimensions/nether/regions/0/0/0")).status).toBe(404);
      expect((await get(target, "/v1/dimensions/overworld/regions/7/0/0")).status).toBe(400);
      expect((await get(target, "/v1/dimensions/overworld/regions/0/0/0?revision=0")).status).toBe(
        409,
      );
      expect((await get(target, "/v1/world", "DELETE")).status).toBe(405);
      expect((await get(target, "/v1/../../etc/passwd")).status).toBe(404);

      const health = JSON.parse((await get(target, "/v1/health")).body.toString());
      expect(health).toMatchObject({ status: "ok", builds: { built: 1 }, cache: { entries: 1 } });
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
      expect(health.cache.entries).toBe(1);
    } finally {
      again.child.kill("SIGTERM");
      await again.exited;
    }
    expect((await readdir(cache)).length).toBe(1);
  }, 60_000);

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
