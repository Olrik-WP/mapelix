# Source light colors

Block light can keep its original warm appearance or use the dominant source's
color. Both modes work with and without textures, on Surface and in Caves, at
LOD 0 and 1. LOD 2–5 retain their previous geometry. Optional
[corner smoothing](smooth-block-lighting.md) is disabled by default.

## Bounded computation

The existing six-neighbor propagation carries an intensity (low four bits) and
one of sixteen fixed color families (high four bits) in the same byte. There are
no additional volume arrays, propagation passes, dynamic point lights, or
per-frame light calculations. The strongest source wins; equal intensities choose
the lower family index before the next intensity level is processed. This rule
is independent of source iteration order and region boundaries. Colors do not
accumulate brightness. Sources retain their existing 0–15 intensities and states.

The palette is a visual convention, independent of a resource pack: ordinary
torches and lanterns retain the original warm fill, soul sources use cyan,
Nether portals use violet, lava uses orange and redstone uses red. Sea lanterns,
froglights and other known sources have their own families. The table is shared
by the serializer and viewer through the browser-safe format entry.

## Color layout, introduced in region format 5

The current format is **6**; flat color planes retain the layout below. Smooth
planes use four bytes per quad as described in the smoothing contract.

Header, geometry, texture words, alignment and the optional byte plane keep
their sizes. Header byte 7 bit 2 (`REGION_FLAG_BLOCK_LIGHT_COLORS = 4`) means
that light bytes carry families as well as levels. Bit 1 still denotes the plane;
bit 2 without bit 1 is invalid. A zero-intensity byte must be zero. Without bit 2,
all bytes remain scalar levels 0–15. Decoded light arrays still view the payload
without copying. `SceneRegion.blockLightColors` exposes the flag.

Both light modes cost one byte per quad when the plane is present. Different
families can split merged faces; actual region size must therefore be measured.
Emissive faces, including lava, still store zero unused local fill.

Earlier readers reject version 6, and this reader rejects earlier versions.
Upgrade server and browser bundle together. Engine fingerprints and world
revisions invalidate prior derived regions automatically. Atlas format 2,
texture pipeline 10 and embed API version 5 are unchanged.

## GPU

Layers with non-warm light add a `uint32` light attribute. Plain lit layers replace
their former auxiliary word (still 16 GPU bytes per quad); textured layers retain
their texture word and add four bytes (20 total). Warm-only layers retain their
previous layout. Neither the color nor the level overwrites any atlas, rotation,
tint, cutout or sheet-offset bit.

Color families use bits 23–26 of the existing flat inter-stage integer; levels
retain bits 27–30. Texture flags use bits 0–18, while sheet offsets retain their
existing separate transport. No additional varying is allocated. Only colored
layouts read the small uniform palette; warm layouts keep their constant color.
Pools distinguish all four combinations of texture/light attributes and share
their previous total capacity. Streaming budgets count the added GPU buffers.

The original intensity curve, daylight modulation and corner occlusion remain.
Source glow, weather, lightning, wet surfaces and reflections retain their paths.

## Host settings

- `WorldSettings.blockLightColors` and `WorldViewerOptions.blockLightColors` are
  per-dimension boolean maps, defaulting to false. The existing `blockLight` map
  still defaults to true and takes precedence when disabled.
- `MapelixViewer.setBlockLightColors(enabled, dimension?)` and the corresponding
  `WorldViewer` method retain the camera and atlas while replacing near regions.
- Default controls add **Source light colors**, disabled when block light is off.
  The demo stores the setting alongside existing preferences.
- Viewer addresses use `blockLightColors=overworld,nether` for chosen dimensions.
  Region requests use `blockLightColors=1`; `blockLight=0` still requests genuinely
  lighter geometry. Distant requests omit color variants.
- Memory and disk caches isolate warm, `colored/` and `unlit/` variants, including
  textured, cutout and cave contexts. Existing quotas and shared build limits apply.
- Cache-only hosts can use `prewarm({ blockLightModes: [true, false, "colored"] })`.
  The default stays `[true]`; distant regions are prepared only once.

## Measurements

[Paired regional results](benchmarks/colored-block-lighting-2026-11-21.json)
compare the preserved current implementation with source colors on the same
read-only copied snapshot. Seven builds alternate order, two warmups are dropped,
and warm times are medians of five. First-build times are not cold-disk guarantees.
Gzip sizes are estimates, separate from actual HTTP transfer measurements.

Desktop Edge at 1280×900, DPR 1, stayed near its 144 FPS display cap in the same
Overworld and Nether views, with and without textures. Median frame intervals
were about 6.9 ms and p95 about 7 ms in those samples. These capped measurements
do not establish spare GPU capacity or physical-phone performance. Live streaming
cache sizes also vary with retained parent regions and are not peak-memory bounds.

The generated showcase includes separated families on neutral pads at
X 12/40/68/96, Z 116/144, with white walls for checking contact occlusion. Existing
foliage, banner and model samples remain. Targeted checks cover levels, ties,
states, dimensions, both near LODs, cave margins, byte validation, cache variants,
HTTP, prewarming, URL settings, GPU buffer layouts and rendering on both backends.
