import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";

class UnsupportedTexture extends Error {}

const [samplesDirectory, outputArgument, reportArgument] = process.argv.slice(2);
if (samplesDirectory === undefined) {
  throw new Error(
    "Usage: node scripts/generate-scene-palette.mjs <extracted-bedrock-samples> [output.ts] [coverage.json]",
  );
}

const manifest = await json(new URL("./scene-palette-sources.json", import.meta.url));
const blocks = await json(resolve(samplesDirectory, "resource_pack/blocks.json"));
const terrain = await json(
  resolve(samplesDirectory, "resource_pack/textures/terrain_texture.json"),
);
const metadata = await json(
  resolve(samplesDirectory, "metadata/vanilladata_modules/mojang-blocks.json"),
);
const knownBlocks = new Set(metadata.data_items.map((item) => item.name));
const images = new Map();
const fingerprints = new Map();
const palette = new Map();
const colorStates = new Map();
const unresolved = [];

for (const name of [...knownBlocks].sort(compare)) {
  const block = name.replace(/^minecraft:/, "");
  if (manifest.exclusions[block] !== undefined) {
    unresolved.push({ block, reason: manifest.exclusions[block] });
    continue;
  }
  const override = manifest.overrides[block] ?? {};
  const textures = override.textures ?? blocks[block]?.textures;
  try {
    if (textures === undefined) throw new UnsupportedTexture("No resource texture binding");
    const colors = await faces(textures, 0);
    const variants = [];
    for (const variant of override.variants ?? []) {
      variants.push({
        states: variant.states,
        colors: await faces(variant.textures ?? textures, variant.textureIndex ?? 0),
      });
    }
    palette.set(block, { colors, variants });
    if (variants.length > 0) {
      colorStates.set(
        block,
        [...new Set(variants.flatMap((v) => Object.keys(v.states)))].sort(compare),
      );
    }
  } catch (error) {
    if (!(error instanceof UnsupportedTexture)) throw error;
    unresolved.push({ block, reason: error.message });
  }
}

const fingerprint = createHash("sha256").update(
  JSON.stringify({ manifest, blocks, terrain, metadata }),
);
for (const [path, hash] of [...fingerprints].sort(([a], [b]) => compare(a, b))) {
  fingerprint.update(`${path}\0${hash}\n`);
}
const lines = [
  `// Generated from Mojang Bedrock samples ${manifest.source.version}; do not edit by hand.`,
  "// Source bindings: ../mapelix-prototype/scripts/scene-palette-sources.json (from the package root).",
  `// Inputs SHA-256: ${fingerprint.digest("hex")}`,
  "// Alpha-weighted sRGB texture means; lateral faces receive equal weight. No texture assets included.",
  "",
  "export type BlockFaceColors = readonly [top: number, side: number, bottom: number];",
  "export interface SampledBlockColors {",
  "  readonly colors: BlockFaceColors;",
  "  readonly variants?: readonly {",
  "    readonly states: Readonly<Record<string, string | number>>;",
  "    readonly colors: BlockFaceColors;",
  "  }[];",
  "}",
  "",
  "export const BEDROCK_BLOCK_COLORS: Readonly<Record<string, SampledBlockColors>> = {",
];
for (const [block, entry] of palette) {
  const variants =
    entry.variants.length === 0
      ? ""
      : `, variants: [${entry.variants.map((v) => `{ states: ${JSON.stringify(v.states)}, colors: ${literal(v.colors)} }`).join(", ")}]`;
  lines.push(`  ${block}: { colors: ${literal(entry.colors)}${variants} },`);
}
lines.push(
  "};",
  "",
  "export const BEDROCK_COLOR_STATES: Readonly<Record<string, readonly string[]>> = {",
);
for (const [block, keys] of colorStates) lines.push(`  ${block}: ${JSON.stringify(keys)},`);
lines.push("};", "");
const output =
  outputArgument === undefined
    ? fileURLToPath(
        new URL("../../mapelix-scene-prototype/src/blocks/bedrock-colors.ts", import.meta.url),
      )
    : resolve(outputArgument);
await writeFile(output, lines.join("\n"));
if (reportArgument !== undefined) {
  await writeFile(
    resolve(reportArgument),
    JSON.stringify(
      {
        version: manifest.source.version,
        total: knownBlocks.size,
        sampled: palette.size,
        unresolved,
      },
      null,
      2,
    ) + "\n",
  );
}
console.log(
  `Wrote ${palette.size}/${knownBlocks.size} block palettes from ${images.size} textures; ${unresolved.length} unresolved`,
);

async function json(path) {
  // Mojang's terrain catalog has a leading line comment.
  return JSON.parse((await readFile(path, "utf8")).replace(/^\s*\/\/.*$/gm, ""));
}

async function faces(textures, index) {
  if (typeof textures === "string" || Array.isArray(textures)) {
    const color = await textureMean(textures, index);
    return [color, color, color];
  }
  const side = textures.side;
  const laterals =
    side === undefined
      ? ["north", "south", "east", "west"].map((face) => {
          if (textures[face] === undefined) throw new UnsupportedTexture(`Missing ${face} face`);
          return textures[face];
        })
      : [side];
  const top = await textureMean(textures.up ?? side, index);
  const sides = [];
  // Fixed traversal also makes missing-texture reports and input fingerprints reproducible.
  for (const key of laterals) sides.push(unpack(await textureMean(key, index)));
  return [top, pack(average(sides)), await textureMean(textures.down ?? side, index)];
}

async function textureMean(keys, index) {
  const names = Array.isArray(keys) ? keys : [keys];
  const colors = [];
  for (const binding of names) {
    const key = typeof binding === "string" ? binding : binding.key;
    const selectedIndex = typeof binding === "string" ? index : binding.index;
    const definition = terrain.texture_data[key]?.textures;
    const path = Array.isArray(definition) ? definition[selectedIndex] : definition;
    if (typeof path !== "string")
      throw new UnsupportedTexture(`Unsupported texture ${key} at index ${selectedIndex}`);
    let color = images.get(path);
    if (color === undefined) {
      let bytes;
      try {
        bytes = await readFile(resolve(samplesDirectory, "resource_pack", `${path}.png`));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        throw new UnsupportedTexture(`PNG unavailable: ${path}`);
      }
      fingerprints.set(path, createHash("sha256").update(bytes).digest("hex"));
      const { data } = PNG.sync.read(bytes);
      const total = [0, 0, 0];
      let weight = 0;
      for (let pixel = 0; pixel < data.length; pixel += 4) {
        const alpha = data[pixel + 3];
        weight += alpha;
        for (let channel = 0; channel < 3; channel++)
          total[channel] += data[pixel + channel] * alpha;
      }
      if (weight === 0) throw new UnsupportedTexture(`Fully transparent texture: ${path}`);
      color = total.map((sum) => sum / weight);
      images.set(path, color);
    }
    colors.push(color);
  }
  return pack(average(colors));
}

function average(colors) {
  return [0, 1, 2].map((channel) => colors.reduce((sum, c) => sum + c[channel], 0) / colors.length);
}

function pack(color) {
  return (Math.round(color[0]) << 16) | (Math.round(color[1]) << 8) | Math.round(color[2]);
}

function unpack(color) {
  return [(color >>> 16) & 255, (color >>> 8) & 255, color & 255];
}

function literal(colors) {
  return `[${colors.map((color) => `0x${color.toString(16).padStart(6, "0")}`).join(", ")}]`;
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
