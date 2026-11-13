# Cosmetic clouds and weather (embed 3)

Viewer-only additions following `cf1082b`. Keep `EMBED_API_VERSION=3` and existing
HTTP/region/discovery versions. Terrain, source indexes, server routes, URL bases,
`.bin` suffixes, cache identities and generation budgets are unchanged.

## Host interface

Optional `WorldViewerOptions` additions:

```ts
clouds?: boolean;              // default true
weather?: WeatherMode;         // default "clear"
type WeatherMode = "clear" | "rain" | "thunderstorm";
```

Optional methods on newer embed 3 viewers:

```ts
viewer.setClouds?.(enabled);
viewer.setWeather?.("rain");
viewer.setWeather?.("thunderstorm");
viewer.setWeather?.("clear");
```

`WeatherMode` is re-exported as a type by `world-viewer.ts`. Invalid runtime
weather modes throw before changing the current choice. Existing methods,
callbacks, selections, discovery filters and depth contracts are preserved.
Hosts can detect the methods when supporting older embed 3 releases and provide
their own translated controls.

Both effects are eligible **only in Overworld Surface**. Switching to Caves,
Nether or End immediately hides their geometry and resets weather fog, wetness
and lightning. Returning to Overworld Surface restores the requested choices.
They do not affect terrain picking or collision.

The local viewer provides English Clouds, Rain and Thunderstorm checkboxes.
Clouds start enabled; weather starts clear. User choices persist under
`mapelix-clouds-v1` and `mapelix-weather-v1`. Invalid/unavailable storage falls
back to these defaults. Shared geographic URLs and saved discovery preferences,
including Search all heights, retain their existing meaning and defaults.

## Appearance

Clouds form deterministic block patches around Y 192 and drift slowly. Shared
internal sides are masked, avoiding translucent grid artifacts. Day/night and
weather tint their color. Distance fades hide the bounded layer's edges;
reduced opacity above the layer and high-altitude fading keep overview maps
readable.

Weather is manually selected cosmetic styling, independent of saved/server
weather and biomes. Procedural rain streaks fall around the camera. Loaded
terrain/roof heights clip them; no additional terrain requests are issued.
When exact geometry is unavailable, existing coarse heights or a bounded local
fallback are used. This is a visual approximation of roof shelter.

Rain progressively darkens the sky and lights, thickens distance fog and adds
a modest wet appearance to upward-facing non-foliage, non-emissive terrain.
Thunderstorms further darken the sky and increase fog and rain visibility.
Infrequent 0.24-second lightning pulses briefly affect the sky, fog and existing
lights. The initial pulse waits 14 seconds; following intervals are 16–24 seconds.
Lightning is suppressed when reduced motion is requested at viewer creation.

All assets are procedural. The implementation uses existing PBR lighting and
bloom, with no added post-processing pass, ray tracing, reflection capture,
Minecraft textures, sounds or network weather service.

## Bounded work and lifecycle

- Clouds use one shadow-free instanced draw with at most 2,304 boxes, one small
  box geometry and one material. Matrix/face-mask buffers total 156,672 bytes;
  there are no cloud textures. Geometry uploads occur only when a cloud cell or
  wind cell changes; normal drift changes only the object position.
- Rain uses one shadow-free line draw with at most 1,024 streaks. Its fixed
  attributes total 65,536 bytes. Roof sampling reuses loaded terrain and is
  refreshed on terrain revisions or two blocks of horizontal camera travel.
- A two-second rolling frame-rate window reduces rain to 256 streaks below
  32 fps and suppresses cosmetic weather below 18 fps. Eight seconds above
  48 fps restore one quality stage, preserving the requested mode. The measured
  frame delta includes slow frames; suspended/invalid deltas are ignored.
- Small geometry/material objects are intentionally reused while views are
  hidden. Disposing the viewer releases their geometry, materials and cloud
  instance resources. No pool or cache grows with explored coordinates.

The frame-rate thresholds are viewer heuristics, not a hardware benchmark or a
guaranteed frame rate. Production measurements remain the integrator's responsibility.

## Validation

Build, type and lint checks pass, with 64 viewer unit tests and the unchanged
engine's 182 tests reused from the verified Turbo cache. All 54 browser cases
pass on WebGPU and WebGL, including 104 Surface/Caves/Nether/End switches per
backend with cosmetic thunderstorms requested. Resource counters stay within
the existing lifecycle limits; disposal removes the owned canvas and overlays.
See [measurements](benchmarks/clouds-weather-2026-11-14.json) for exact counters,
buffer budgets and test duration. These checks use generated disposable worlds;
they do not measure production VM RSS, physical GPU residency or mobile FPS.
