import { beforeEach, describe, expect, it, vi } from "vitest";
import { sceneContext } from "@mapelix/scene-prototype/dimensions";

const mocks = vi.hoisted(() => ({
  disk: new Map<string, Uint8Array>(),
  opened: vi.fn(),
  built: vi.fn(),
}));

vi.mock("@mapelix/scene-prototype", () => ({ openSceneWorld: mocks.opened }));
vi.mock("node:fs/promises", () => ({
  readdir: async () => ["000001.ldb"],
  stat: async () => ({ size: 100n, mtimeNs: 123n }),
  readFile: async (path: string) => {
    const bytes = mocks.disk.get(path);
    if (!bytes) throw new Error("ENOENT");
    return bytes;
  },
  mkdir: async () => {},
  writeFile: async (path: string, bytes: Uint8Array) => {
    mocks.disk.set(path, bytes);
  },
  rename: async (from: string, to: string) => {
    mocks.disk.set(to, mocks.disk.get(from)!);
    mocks.disk.delete(from);
  },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.disk.clear();
  mocks.opened.mockReset();
  mocks.built.mockReset();
  mocks.opened.mockImplementation(async ({ dimension }: { dimension: string }) => ({
    info: { name: "Cache fixture", spawn: { x: -61, y: 69, z: 25 } },
    buildRegion: async (request: { ceilingY: number }) => {
      mocks.built(dimension, request);
      const id = dimension === "overworld" ? 0 : dimension === "nether" ? 1 : 2;
      return { bytes: new Uint8Array([id, request.ceilingY / 16]), milliseconds: 1 };
    },
    close: async () => {},
  }));
});

describe("dimension server caches", () => {
  it("isolates memory, workers and persisted regions, including after a server restart", async () => {
    const server = await import("./scene-world");
    const request = { level: 0, x: -1, z: 0 };
    const signal = new AbortController().signal;
    const contexts = [
      sceneContext(),
      sceneContext("nether"),
      sceneContext("the-end"),
      sceneContext("nether", 128),
    ];
    const outputs: string[] = [];
    for (const context of contexts) {
      const first = await server.loadRegion(request, signal, context);
      expect(first.cacheStatus).toBe("build");
      outputs.push(Array.from(first.bytes).join(","));
      const second = await server.loadRegion(request, signal, context);
      expect(second.cacheStatus).toBe("memory");
      expect(second.bytes).toEqual(first.bytes);
    }
    expect(new Set(outputs).size).toBe(4);
    expect(mocks.opened.mock.calls.map(([options]) => options.dimension)).toEqual([
      "overworld",
      "nether",
      "the-end",
    ]);
    expect(mocks.disk.size).toBe(4);
    vi.resetModules();
    const restarted = await import("./scene-world");
    for (const [index, context] of contexts.entries()) {
      const stored = await restarted.loadRegion(request, signal, context);
      expect(stored.cacheStatus).toBe("disk");
      expect(Array.from(stored.bytes).join(",")).toBe(outputs[index]);
    }
    expect(mocks.built).toHaveBeenCalledTimes(4);
  });

  it("provides dimension entry points without treating them as stored portal positions", async () => {
    const server = await import("./scene-world");
    expect((await server.getWorldMetadata()).spawn).toEqual({ x: -61, y: 69, z: 25 });
    expect((await server.getWorldMetadata(sceneContext("nether"))).spawn).toEqual({
      x: -8,
      y: 64,
      z: 3,
    });
    expect((await server.getWorldMetadata(sceneContext("the-end"))).spawn).toEqual({
      x: 100,
      y: 64,
      z: 0,
    });
  });
});
