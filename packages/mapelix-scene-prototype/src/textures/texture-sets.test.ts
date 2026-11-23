import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  makePng,
  makeTga,
  makeZip,
  packFiles,
  type ZipFileSpec,
} from "../../test/synthetic-pack.js";
import { atlasCellSize, atlasGutter, type TextureAtlas } from "./atlas-format.js";
import { openResourcePackStack } from "./resource-pack.js";
import { buildTextureAtlas, textureRevision, type BuiltTextureAtlas } from "./texture-atlas.js";
import { heightToNormals, parseTextureSet } from "./texture-sets.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mapelix-sets-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function zip(name: string, specs: readonly ZipFileSpec[]): Promise<string> {
  const path = join(root, name);
  await writeFile(path, makeZip(specs));
  return path;
}

const set = (layers: Record<string, unknown>, format = "1.21.30") =>
  JSON.stringify({ format_version: format, "minecraft:texture_set": { color: "x", ...layers } });

/** A height map rising to the right: a ramp of gray levels, 16 pixels. */
function ramp(): Uint8Array {
  const rgba = new Uint8Array(16 * 16 * 4);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) rgba.set([x * 8, x * 8, x * 8, 255], (y * 16 + x) * 4);
  return rgba;
}

const terrain = {
  stone: { textures: "textures/blocks/stone" },
  dirt: { textures: "textures/blocks/dirt" },
  sand: { textures: "textures/blocks/sand" },
};
const blocks = {
  stone: { textures: "stone" },
  dirt: { textures: "dirt" },
  sand: { textures: "sand" },
};

/** A pack with texture sets: stone with a normal map and uniform MER, dirt and sand too. */
function lower(): ZipFileSpec[] {
  return packFiles({
    name: "Lower",
    uuid: "00000000-0000-4000-8000-0000000000a1",
    terrain,
    blocks,
    images: {
      "textures/blocks/stone.png": makePng(16, [120, 120, 120, 255]),
      // Every normal leans toward the texture's right.
      "textures/blocks/stone_n.png": makePng(16, [218, 128, 218, 255]),
      "textures/blocks/stone.texture_set.json": new TextEncoder().encode(
        set({ normal: "stone_n", metalness_emissive_roughness_subsurface: [255, 128, 0, 40] }),
      ),
      "textures/blocks/dirt.png": makePng(16, [110, 80, 50, 255]),
      "textures/blocks/dirt_mer.png": makePng(16, [0, 255, 64, 255]),
      "textures/blocks/dirt.texture_set.json": new TextEncoder().encode(
        set({ metalness_emissive_roughness: "dirt_mer" }, "1.16.100"),
      ),
      "textures/blocks/sand.png": makePng(16, [220, 210, 160, 255]),
      "textures/blocks/sand_h.tga": makeTga(16, 16, ramp()),
      "textures/blocks/sand.texture_set.json": new TextEncoder().encode(
        set({ heightmap: "sand_h", metalness_emissive_roughness: "#00000080" }),
      ),
    },
  });
}

/** The texel at the middle of a tile, level 0. */
function texel(atlas: TextureAtlas, built: BuiltTextureAtlas, path: string): number[] {
  const tile = built.index.tiles[path]!;
  const cell = atlasCellSize(atlas.tileSize);
  const width = atlas.columns * cell;
  const x = (tile % atlas.columns) * cell + atlasGutter(atlas.tileSize) + atlas.tileSize / 2;
  const y = Math.floor(tile / atlas.columns) * cell + atlasGutter(atlas.tileSize) + 1;
  const at = (y * width + x) * 4;
  return [...atlas.levels[0]!.subarray(at, at + 4)];
}

describe("texture sets", () => {
  it("parses both formats, image and uniform layers, and refuses what it cannot use", () => {
    const file = "textures/blocks/stone.texture_set.json";
    const parse = (text: string) => parseTextureSet(JSON.parse(text), file);
    expect(parse(set({ normal: "stone_n", metalness_emissive_roughness: "stone_mer" }))).toEqual({
      normal: { image: "textures/blocks/stone_n" },
      mer: { image: "textures/blocks/stone_mer" },
    });
    expect(parse(set({ metalness_emissive_roughness: [0, 255, 128] }, "1.16.100"))).toEqual({
      mer: { value: [0, 255, 128, 255] },
    });
    expect(parse(set({ metalness_emissive_roughness_subsurface: "#10203040" }))).toEqual({
      mer: { value: [16, 32, 48, 64] },
    });
    expect(parse(set({ heightmap: "stone_h" }, "1.26.0"))).toEqual({
      heightmap: { image: "textures/blocks/stone_h" },
    });
    expect(parse(set({ normal: "stone_n" }, "1.14.0"))).toMatch(/format 1\.14\.0/);
    expect(parse(set({ normal: "../../escape" }))).toMatch(/unsafe normal/);
    expect(parse(set({ metalness_emissive_roughness: [0, 300, 0] }))).toMatch(/invalid/);
    expect(parse(set({ normal: [1, 2, 3] }))).toMatch(/invalid normal/);
    expect(parse(set({}))).toMatch(/no normal, heightmap/);
    expect(parseTextureSet({ format_version: "1.21.30" }, file)).toMatch(/minecraft:texture_set/);
  });

  it("turns a height map into normals that lean away from the slope", () => {
    const flat = heightToNormals({ width: 4, height: 4, rgba: new Uint8Array(64).fill(90) });
    expect([...flat.subarray(0, 4)]).toEqual([128, 128, 255, 255]);
    const sloped = heightToNormals({ width: 16, height: 16, rgba: ramp() });
    // Inside the ramp (away from the wrapping edge) the surface faces left, not up or down.
    const at = (5 * 16 + 8) * 4;
    expect(sloped[at]!).toBeLessThan(128);
    expect(sloped[at + 1]).toBe(128);
    expect(sloped[at + 2]!).toBeGreaterThan(200);
  });

  it("builds normal and material atlases aligned with the color atlas", async () => {
    const stack = await openResourcePackStack([await zip("lower.zip", lower())]);
    expect(stack.hasTextureSets).toBe(true);
    const plain = await buildTextureAtlas(stack);
    const built = await buildTextureAtlas(stack, { pbr: { tileSize: 16 } });
    // The color atlas does not change; its revision does, with the PBR options.
    expect(built.bytes).toEqual(plain.bytes);
    expect(built.fingerprint).not.toBe(plain.fingerprint);
    const pbr = built.pbr!;
    expect(pbr).toMatchObject({ tileSize: 16, requestedTileSize: 16, sets: 3, skipped: [] });
    expect(pbr.normal.columns).toBe(built.atlas.columns);
    expect(pbr.normal.tiles).toBe(built.atlas.tiles);
    const normal = texel(pbr.normal, built, "textures/blocks/stone");
    // Renormalized: (0.71, 0, 0.71).
    expect(normal[0]).toBeGreaterThan(210);
    expect(normal[1]).toBe(128);
    expect(normal[2]).toBeGreaterThan(210);
    // Uniform MERS: subsurface dropped, opaque.
    expect(texel(pbr.material, built, "textures/blocks/stone")).toEqual([255, 128, 0, 255]);
    // MER image without normals: flat normals.
    expect(texel(pbr.normal, built, "textures/blocks/dirt")).toEqual([128, 128, 255, 255]);
    expect(texel(pbr.material, built, "textures/blocks/dirt")).toEqual([0, 255, 64, 255]);
    // A TGA height map gives normals; the hex MER value applies to the whole tile.
    expect(texel(pbr.normal, built, "textures/blocks/sand")[0]!).toBeLessThan(128);
    expect(texel(pbr.material, built, "textures/blocks/sand")).toEqual([0, 0, 0, 255]);
  });

  it("takes a set only from the pack the color comes from", async () => {
    const upper = packFiles({
      name: "Upper",
      uuid: "00000000-0000-4000-8000-0000000000a2",
      images: { "textures/blocks/stone.png": makePng(16, [200, 0, 0, 255]) },
    });
    const stack = await openResourcePackStack([
      await zip("upper.zip", upper),
      await zip("lower.zip", lower()),
    ]);
    const built = await buildTextureAtlas(stack, { pbr: {} });
    // The upper pack's stone has no set: the lower pack's normals do not apply to it.
    expect(texel(built.pbr!.normal, built, "textures/blocks/stone")).toEqual([128, 128, 255, 255]);
    expect(texel(built.pbr!.material, built, "textures/blocks/stone")).toEqual([0, 0, 255, 255]);
    expect(built.pbr!.sets).toBe(2);
  });

  it("reports a set whose image is missing and keeps its tiles flat", async () => {
    const files = lower().map((spec) =>
      spec.name === "textures/blocks/stone_n.png"
        ? { ...spec, name: "textures/blocks/x.png" }
        : spec,
    );
    const built = await buildTextureAtlas(
      await openResourcePackStack([await zip("broken.zip", files)]),
      { pbr: { tileSize: 16 } },
    );
    expect(built.pbr!.skipped).toEqual([
      expect.objectContaining({
        file: "textures/blocks/stone.texture_set.json",
        reason: expect.stringMatching(/missing/),
      }),
    ]);
    expect(texel(built.pbr!.normal, built, "textures/blocks/stone")).toEqual([128, 128, 255, 255]);
  });

  it("leaves stacks without texture sets exactly as before", async () => {
    const stack = await openResourcePackStack([
      await zip(
        "plain.zip",
        packFiles({
          terrain,
          blocks,
          images: {
            "textures/blocks/stone.png": makePng(16, [120, 120, 120, 255]),
          },
        }),
      ),
    ]);
    expect(stack.hasTextureSets).toBe(false);
    const plain = await buildTextureAtlas(stack);
    const asked = await buildTextureAtlas(stack, { pbr: { tileSize: 64 } });
    expect(asked.pbr).toBeUndefined();
    expect(asked.fingerprint).toBe(plain.fingerprint);
    expect(asked.bytes).toEqual(plain.bytes);
    expect(textureRevision(stack.fingerprint)).toBe(plain.fingerprint);
    expect(() => textureRevision(stack.fingerprint, { pbr: { tileSize: 24 } })).toThrow(RangeError);
  });

  it("shrinks the PBR tiles to fit the budget", async () => {
    const stack = await openResourcePackStack([await zip("lower.zip", lower())]);
    const built = await buildTextureAtlas(stack, { pbr: { tileSize: 64, budgetBytes: 20_000 } });
    expect(built.pbr!.requestedTileSize).toBe(64);
    expect(built.pbr!.tileSize).toBeLessThan(64);
    expect(built.pbr!.gpuBytes).toBeLessThanOrEqual(20_000);
  });
});
