# Optional smooth block lighting

`blockLightSmooth` enables corner interpolation at LOD 0 and 1, on Surface and
in Caves, with or without textures and source colors. It defaults to false in
every dimension. Turning off `blockLight` still requests lighter geometry and
overrides both color and smoothing settings. Distant LODs remain unchanged.

The existing light field and propagation are reused. Four corner samples read
neighboring transmitting cells; two touching opaque sides exclude the diagonal
sample to prevent light leaking through a closed corner. Shared grid vertices
use identical cells and deterministic source-color ties. Small model parts and
plants retain their cell lighting. Occlusion is still applied independently.

The optional meshing path merges uniform fields and consistent linear intensity
gradients of one color family. It checks interior grid vertices before widening
a quad, and retains nonlinear peaks or color transitions instead of stretching
them. Self-emissive faces, including lava, keep zero unused local fill. The
default path allocates no corner masks and keeps its original merge criteria.

## Region format 6

Header flag **8** (`REGION_FLAG_BLOCK_LIGHT_SMOOTH`) changes the optional light
plane from one byte to one little-endian `uint32` per quad. Its four bytes follow
the existing corner order: (0,0), (1,0), (1,1), (0,1). Each byte has a low-nibble
intensity and, when flag 4 is set, a high-nibble color family. Zero intensity has
no color. Flag 8 requires the light-plane flag 2. Geometry and texture words keep
their sizes, flags and alignment. No plane is stored when all receiving faces
are unlit.

`RegionBlockLight` layers are `Uint8Array` for flat light or `Uint32Array` for
smooth light. Both decode without copying. `SceneRegion.blockLightSmooth`
identifies the encoding. Lava partitioning and water/glass separation retain
complete words with their faces. Smooth storage costs four bytes per quad
instead of one, before compression or changes in quad count.

Version 5 and 6 readers are incompatible. Upgrade the server and browser bundle
together. Engine fingerprints invalidate old derived regions. Embed API 5,
atlas format 2, texture pipeline 10 and snapshot validation 1 remain unchanged.

## GPU and settings

Varying corner words reuse one four-byte GPU attribute per quad; uniform layers
retain the flat layouts. Smooth words view decoded data directly. Vertex shaders
decode the four samples and interpolate level-weighted RGB plus intensity.
Fragment shading multiplies these terms, preserving the existing quadratic
response for a single color family and smoothly blending different families.
Only smooth layouts pack material, cover and height into one flat integer,
freeing varying space for interpolation on WebGPU and WebGL 2. Texture flags and
sheet offsets retain their transport. Pool layouts and memory accounting include
the optional attribute. Existing sunlight, weather, lightning and reflections
retain their paths.

- Optional per-dimension maps: `WorldSettings.blockLightSmooth` and
  `WorldViewerOptions.blockLightSmooth`.
- Methods: `MapelixViewer.setBlockLightSmooth(enabled, dimension?)` and the
  matching `WorldViewer` method. Camera and atlas are retained on changes.
- Default control: **Smooth block lighting**, disabled when block light is off.
  Demo preferences persist the setting per dimension.
- Viewer URL: `blockLightSmooth=overworld,nether`. Region URL:
  `blockLightSmooth=1`, independent of `blockLightColors=1`.
- Caches isolate flat, smooth, colored/smooth and unlit near variants. Distant
  requests normalize to the existing shared geometry.
- Cache-only hosts can add `"smooth"` and `"colored-smooth"` to prewarm
  `blockLightModes`; existing boolean and `"colored"` modes retain their meaning.

Targeted checks cover shared corners, diagonal blockers, gradient merging,
nonlinear peaks, unsigned serialization, near LODs, disabled light, cache modes,
URL settings, buffer ownership and both rendering backends. Performance
measurements for this optional mode are left to host-side review.
