# Bedrock block color palette

The palette is generated from the complete official Bedrock samples 1.26.60.5 registry,
not from a particular world's inventory. The source is the supplied
`bedrock-samples-v1.26.60.5-full.zip`. No texture images or third-party source code are
included in the generated module. PNG decoding uses the existing `pngjs` dependency.

## Generation and coverage

Extract the samples into an ignored development directory, then run from the repository root:

```sh
pnpm --filter @mapelix/prototype exec node scripts/generate-scene-palette.mjs \
  <absolute-path-to-extracted-bedrock-samples> \
  ../mapelix-scene-prototype/src/blocks/bedrock-colors.ts \
  ../../docs/block-colors-coverage.json
```

The relative output paths account for `pnpm --filter ... exec` changing the working
directory to `packages/mapelix-prototype`. Format the generated TypeScript with that
package's existing `oxfmt` tool afterwards.

The generator joins `mojang-blocks.json`, `blocks.json` and `terrain_texture.json`.
It samples 1,254 of the 1,466 official identifiers using 953 PNG textures. The
[coverage report](block-colors-coverage.json) explicitly lists the other 212 identifiers:
191 have no resource texture binding, 19 have no supported PNG at the declared path,
one uses an unsupported atlas entry, and beds require block-entity data. These are
texture-binding counts, including technical and Education blocks, not fidelity scores.

Colors are alpha-weighted sRGB means. Fully transparent pixels contribute no black fringe;
the four lateral faces receive equal weight. Animated image strips produce a stable mean,
not an animation. The input fingerprint is recorded in the generated file. Explicit source
bindings handle atlas indexes, modern identifiers, barrel/cauldron faces, and decorated pots.
State variants cover mushroom growth, copper-bulb lit/powered states, trial spawners and vaults.

## Rendering policy

The existing shapes, material flags, shaders, meshing, AO and LOD policies remain in place.
Sampled colors override broad ore/copper rules and distinguish lava from magma, retaining
their emissive material. Other existing 3D colors and biome tint policies take priority;
the generated catalog then replaces inherited generic or gray fallback colors. Fixed cherry,
azalea, pale-oak and poplar foliage is retained. Sampled variants participate in palette cache
identity only for the blocks that use them. The Bedrock `fence_gate` alias reuses oak's
existing appearance. The 2D block-style palette is unchanged.

The client biome definitions supply explicit grass/foliage/water for dappled forest (195),
and grass/water for sulfur caves (194). Unspecified sulfur-cave foliage retains the default.
Existing biome IDs retain their previous behavior.

## Validation and limitations

The read-only Overworld/Nether snapshot used for validation prioritizes visible failures,
without defining the generated catalog. Of its 35 distinct vanilla identifiers previously
using gray fallback, 34 now resolve to explicit colors or the existing oak appearance.
The remaining `minecraft:bed` has no blanket color in the palette states currently read;
its resource binding points to oak planks for the underside, so it is deliberately excluded.
The snapshot's `tac_guns:workbench` is outside the vanilla ZIP and keeps its fallback.

Generator tests cover alpha, lateral-face weighting, unresolved entries and reproducibility.
Appearance tests cover ore hosts, oxidation, axes, state-cache separation and namespace isolation.
Generated-region tests check colors in all three dimensions at all six LODs. The four
committed fixture byte fingerprints intentionally change with the palette; no historical
2D reference image is regenerated. Real End validation still requires an explored End world.
An isolated pre-color palette reproduces all four original fixture hashes; comparison with
the recolored fixture retains the height grids and surface area by face/material at those LODs.

Completed checks: 150 prototype tests, 104 scene tests, six viewer tests, engine/viewer builds,
type checks and focused formatting checks. Lint has no errors and retains two pre-existing
sort warnings in `foliage-region.test.ts`. Four browser tests pass on generated fixtures and
four on the read-only snapshot, covering WebGPU and forced WebGL. Snapshot database bytes
remain unchanged. The complete patch also passes `git apply --cached --check`
against `f622e3a` using an isolated temporary index.

Geometry approximations, hidden blocks, block-entity colors, additional conditional texture
variants, resource-pack meshes, local block-light propagation and fluid animation remain
outside this color change. No underground exploration path is added.

## Bedrock Control integration

The color work starts from generic engine commit `d726cfc`, separately from Bedrock Control.
Its patch applies to integration revision `f622e3a` without modifying `apps/scene-server`,
the embedded interface, configurable base paths, `.bin` suffixes, dimensions or ceilings.
API/viewer version 2 and region format 2 remain compatible; no embedded-interface change
requires a version increment.

The prototype's mesh revision is bumped to invalidate its old color caches. The existing
server at `f622e3a` fingerprints compiled engine JavaScript, including the new palette module,
so rebuilding the engine produces a different server/world revision and separate cache entries.
Do not reuse an old compiled release or its old revision when validating the new colors.
No panel, updater or deployment changes are part of this patch.
