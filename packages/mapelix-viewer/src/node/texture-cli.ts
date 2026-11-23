#!/usr/bin/env node
/**
 * Checks a texture stack without a server and prints a JSON report: the texture revision, each
 * pack's fingerprint (to pin in `mapelix-stack.json`), the atlas sizes and the notices, and for
 * packs with texture sets the PBR atlases (sets used and ignored, sizes), or what is wrong.
 * Exits 1 when the stack cannot be used. Reads only; writes nothing.
 *
 *   mapelix-textures <stack folder> [--max-tile-size 32] [--budget-mib 32]
 *   mapelix-textures --packs <pack> [<pack> ...] [--max-tile-size 32] [--budget-mib 32]
 *   PBR atlases: [--pbr-tile-size 16|32|64] [--pbr-budget-mib 48]
 */
import { validateTextureStack } from "./textures.js";

const args = process.argv.slice(2);
const option = (name: string): number | undefined => {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = Number(args[at + 1]);
  args.splice(at, 2);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} needs a positive integer`);
  }
  return value;
};
const maxTileSize = option("--max-tile-size");
const budgetMiB = option("--budget-mib");
const maxAtlasSide = option("--max-atlas-side");
const pbrTileSize = option("--pbr-tile-size");
const pbrBudgetMiB = option("--pbr-budget-mib");
const packs = args[0] === "--packs";
const paths = packs ? args.slice(1) : args;
if (paths.length === 0 || (!packs && paths.length !== 1) || paths.some((p) => p.startsWith("--"))) {
  process.stderr.write(
    "Usage: mapelix-textures <stack folder> | --packs <pack>... [--max-tile-size n] [--budget-mib n] [--max-atlas-side 2048|4096] [--pbr-tile-size n] [--pbr-budget-mib n]\n",
  );
  process.exit(2);
}
const report = await validateTextureStack(packs ? { packs: paths } : { stack: paths[0]! }, {
  ...(maxTileSize === undefined ? {} : { maxTileSize }),
  ...(budgetMiB === undefined ? {} : { budgetBytes: budgetMiB * 1024 * 1024 }),
  ...(maxAtlasSide === undefined ? {} : { maxAtlasSide }),
  pbr: {
    tileSize: pbrTileSize ?? 32,
    budgetBytes: (pbrBudgetMiB ?? 48) * 1024 * 1024,
  },
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.ok ? 0 : 1;
