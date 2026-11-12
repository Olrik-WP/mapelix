import { afterEach, describe, expect, it, vi } from "vitest";
import { Group, PerspectiveCamera } from "three/webgpu";
import { EMPTY_HEIGHT, encodeSceneRegion } from "@mapelix/scene-prototype/format";
import { sceneContext } from "@mapelix/scene-prototype/dimensions";
import type { SceneMaterials } from "./shaders/materials";
import { RegionStreamer } from "./region-streamer";

const constructed = vi.hoisted(() => vi.fn());
vi.mock("./region-mesh", () => ({
  RegionMesh: class {
    readonly isEmpty = false;
    readonly byteLength = 12;
    readonly group = new Group();
    constructor(readonly region: unknown) {
      constructed(region);
    }
    dispose() {}
    setFade() {}
  },
}));

function stream(
  dimension: "overworld" | "nether",
  transport: { regionBase?: string; regionSuffix?: string } = {},
) {
  return new RegionStreamer({
    ...transport,
    context: sceneContext(dimension),
    revision: "test-revision",
    materials: {} as SceneMaterials,
    voxelPixels: 2.2,
    blockPixels: 4.4,
    viewDistance: 1,
    maxRequests: 1,
    memoryBudget: 1024,
    onRegion: vi.fn(),
  });
}

function request(streamer: RegionStreamer) {
  const camera = new PerspectiveCamera(50, 1, 1, 1000);
  camera.position.set(0, 80, 0);
  camera.lookAt(0, 64, -10);
  streamer.update(camera, 600);
}

function response() {
  const empty = new Uint32Array(0);
  const bytes = encodeSceneRegion({
    level: 0,
    x: 0,
    z: 0,
    minY: 0,
    maxY: 0,
    heights: new Int16Array(64 * 64).fill(EMPTY_HEIGHT),
    opaque: empty,
    plants: empty,
    translucent: empty,
  });
  return new Response(new Uint8Array(bytes).buffer);
}

afterEach(() => {
  vi.unstubAllGlobals();
  constructed.mockClear();
});

describe("dimension streaming lifecycle", () => {
  it("qualifies region requests by dimension, ceiling and revision", () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const streamer = stream("nether");
    request(streamer);
    const url = new URL(fetcher.mock.calls[0]![0] as string, "http://localhost");
    expect(url.searchParams.get("dimension")).toBe("nether");
    expect(url.searchParams.get("ceilingY")).toBe("96");
    expect(url.searchParams.get("revision")).toBe("test-revision");
    streamer.dispose();
  });

  it("keeps a host's region path and suffix in front of the scene context", () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const streamer = stream("nether", { regionBase: "/map/scene/regions", regionSuffix: ".bin" });
    request(streamer);
    const url = new URL(fetcher.mock.calls[0]![0] as string, "http://localhost");
    expect(url.pathname).toMatch(/^\/map\/scene\/regions\/\d\/-?\d+\/-?\d+\.bin$/);
    expect([...url.searchParams.keys()]).toEqual(["dimension", "ceilingY", "revision"]);
    expect(url.searchParams.get("ceilingY")).toBe("96");
    streamer.dispose();
  });

  it("aborts the previous dimension and ignores its late response after switching", async () => {
    let finishOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => {
      finishOld = resolve;
    });
    const fetcher = vi.fn().mockReturnValueOnce(oldResponse).mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetcher);
    const overworld = stream("overworld");
    request(overworld);
    overworld.dispose();
    const nether = stream("nether");
    request(nether);
    await vi.waitFor(() => expect(nether.stats.cached).toBe(1));
    const oldSignal = (fetcher.mock.calls[0]![1] as RequestInit).signal;
    expect(oldSignal?.aborted).toBe(true);
    finishOld(response());
    await oldResponse;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overworld.stats.cached).toBe(0);
    expect(constructed).toHaveBeenCalledTimes(1);
    nether.dispose();
  });
});
