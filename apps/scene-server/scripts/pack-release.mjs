// Assembles a self-contained Mapelix 3D release from a built checkout:
//
//   release.json                       commit, API versions, and a SHA-256 for every file
//   server/                            the scene server (node server/main.js)
//   node_modules/@mapelix/...          only the engine modules the server imports
//   node_modules/pako/, pngjs/         the two third-party runtime dependencies
//   viewer/mapelix-viewer-3d.js        the browser viewer module (three.js included)
//   notices/                           licenses of the bundled code
//
// Usage: node scripts/pack-release.mjs <empty output directory> [--allow-dirty]
// Build first: pnpm turbo run build --filter=@mapelix/scene-server... and
// pnpm --filter @mapelix/prototype-viewer-3d build:embed.
// Nothing here records a time or a machine path, so the same commit packs the same bytes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(app, "../..");
const args = process.argv.slice(2);
const allowDirty = args.includes("--allow-dirty");
const output = args.find((arg) => !arg.startsWith("--"));
if (output === undefined)
  throw new Error("Usage: pack-release.mjs <output directory> [--allow-dirty]");
const target = resolve(output);

const git = (...parameters) =>
  execFileSync("git", ["-C", repository, ...parameters], { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
if (dirty && !allowDirty) {
  throw new Error("The checkout has uncommitted changes; a release must come from a commit");
}

const existing = await readdir(target).catch(() => []);
if (existing.length > 0) throw new Error(`${target} must be empty`);

const pnpmModules = join(repository, "node_modules", ".pnpm");
const pakoDirectory = (await readdir(pnpmModules)).find((name) => /^pako@2\.1\.0$/.test(name));
if (pakoDirectory === undefined) throw new Error("pako 2.1.0 is not installed; run pnpm install");
const pako = join(pnpmModules, pakoDirectory, "node_modules", "pako");
const pngjsDirectory = (await readdir(pnpmModules)).find((name) => /^pngjs@7\.0\.0$/.test(name));
if (pngjsDirectory === undefined) throw new Error("pngjs 7.0.0 is not installed; run pnpm install");
const pngjs = join(pnpmModules, pngjsDirectory, "node_modules", "pngjs");

/** Copies files under `from` whose relative path passes `keep`, into `to`. */
async function copyTree(from, to, keep, root = from) {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    if (entry.isDirectory()) {
      await copyTree(source, join(to, entry.name), keep, root);
    } else if (entry.isFile() && keep(relative(root, source))) {
      await mkdir(to, { recursive: true });
      await copyFile(source, join(to, entry.name));
    }
  }
}

async function requireFile(path, hint) {
  const details = await stat(path).catch(() => undefined);
  if (details?.isFile() !== true) throw new Error(`${path} is missing: ${hint}`);
}

const serverDist = join(app, "dist");
const scenePackage = join(repository, "packages", "mapelix-scene-prototype");
const prototypePackage = join(repository, "packages", "mapelix-prototype");
const viewer = join(
  repository,
  "apps",
  "prototype-viewer-3d",
  "dist-embed",
  "mapelix-viewer-3d.js",
);
await requireFile(join(serverDist, "main.js"), "build @mapelix/scene-server");
await requireFile(join(scenePackage, "dist", "index.js"), "build @mapelix/scene-prototype");
await requireFile(
  join(prototypePackage, "dist", "bedrock", "index.js"),
  "build @mapelix/prototype",
);
await requireFile(viewer, "run build:embed in apps/prototype-viewer-3d");

const javascript = (path) => path.endsWith(".js") && !path.endsWith(".test.js");
await copyTree(serverDist, join(target, "server"), javascript);
await writeFile(
  join(target, "server", "package.json"),
  `${JSON.stringify({ type: "module" }, null, 2)}\n`,
);

const modules = join(target, "node_modules");
const scene = join(modules, "@mapelix", "scene-prototype");
await copyTree(join(scenePackage, "dist"), join(scene, "dist"), javascript);
await copyFile(join(scenePackage, "package.json"), join(scene, "package.json"));
// The scene engine imports the Bedrock decoders and the block and biome colors of the
// 2D package. Its entry module also loads the tile renderer, so the whole dist ships;
// the 2D renderer is library code here, never a running service.
const prototype = join(modules, "@mapelix", "prototype");
await copyTree(join(prototypePackage, "dist"), join(prototype, "dist"), javascript);
await copyFile(join(prototypePackage, "package.json"), join(prototype, "package.json"));
await copyTree(pako, join(modules, "pako"), (path) =>
  ["package.json", "LICENSE", join("dist", "pako.esm.mjs")].includes(path),
);
await copyTree(
  pngjs,
  join(modules, "pngjs"),
  (path) =>
    ["package.json", "LICENSE"].includes(path) ||
    (path.startsWith(`lib${sep}`) && path.endsWith(".js")),
);

await mkdir(join(target, "viewer"), { recursive: true });
await copyFile(viewer, join(target, "viewer", "mapelix-viewer-3d.js"));

const notices = join(target, "notices");
await mkdir(notices, { recursive: true });
await copyFile(join(repository, "THIRD_PARTY_NOTICES.md"), join(notices, "MAPELIX-THIRD-PARTY.md"));
await copyFile(join(pako, "LICENSE"), join(notices, "pako-LICENSE"));
await copyFile(join(pngjs, "LICENSE"), join(notices, "pngjs-LICENSE"));
const three = (await readdir(pnpmModules)).find((name) => name.startsWith("three@"));
if (three !== undefined) {
  await copyFile(
    join(pnpmModules, three, "node_modules", "three", "LICENSE"),
    join(notices, "three-LICENSE"),
  );
}

const { API_VERSION } = await import(new URL("../dist/http-server.js", import.meta.url).href);
const { REGION_FORMAT_VERSION } = await import(
  new URL(`file:///${join(scenePackage, "dist", "format.js").replaceAll(sep, "/")}`).href
);
const embedSource = await readFile(
  join(repository, "apps", "prototype-viewer-3d", "src", "lib", "embed.ts"),
  "utf8",
);
const embedVersion = /EMBED_API_VERSION = (\d+)/.exec(embedSource)?.[1];
if (embedVersion === undefined) throw new Error("EMBED_API_VERSION is missing from embed.ts");
const mise = await readFile(join(repository, "mise.toml"), "utf8");
const nodeVersion = /node = "([^"]+)"/.exec(mise)?.[1];

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files;
}
const files = {};
for (const path of (await listFiles(target)).sort()) {
  const name = relative(target, path).split(sep).join("/");
  files[name] = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

const release = {
  name: "mapelix-scene",
  commit,
  dirty,
  apiVersion: API_VERSION,
  embedApiVersion: Number(embedVersion),
  regionFormatVersion: REGION_FORMAT_VERSION,
  node: nodeVersion ?? ">=24",
  entry: "server/main.js",
  viewer: "viewer/mapelix-viewer-3d.js",
  files: Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => (left < right ? -1 : 1)),
  ),
};
await writeFile(join(target, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
console.log(
  `Packed Mapelix ${commit}${dirty ? " (dirty)" : ""}: ${Object.keys(files).length} files in ${target}`,
);
