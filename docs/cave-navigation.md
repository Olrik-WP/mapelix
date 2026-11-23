# Cave navigation and automatic depth

Incremental viewer work based on `92351d9`. Viewer only: no server, region
format or cache-key change.

## Navigation

Surface camera collision and retargeting remain active. In explicit Caves mode,
the camera moves through rock without collision or automatic retargeting onto a
nearby wall. This avoids the oversized collision sweep and wall pivot that could
trap exploration in a narrow cavern. The orbit focus stays within the visible
slice; the camera can stand above the cut for an overview.

Space/C move the camera and focus vertically, in Caves as in Surface views, at
the keyboard pace of WASD, which follows the zoom (see `keyboardSpeed`).
Page Up/Page Down remain aliases. Shift has no camera action; it never swaps
mouse pan/orbit. Space never takes over focused buttons or form controls.
The prototype also supplies 44-pixel touch buttons held to ascend/descend. Input
stops on release, cancellation, lost capture, blur, hidden document, selection
drag or manual view switch. Text/number/select/contenteditable fields keep their
keyboard input. Existing WASD/QE/RF controls are preserved. Keys expire after
600 ms without a keydown/repeat, protecting against a lost keyup. Translation,
vertical moves included, is capped at 160 blocks/s in Surface and 32 in Caves.

After a Surface ascent or descent, the next gesture can reacquire terrain up to
the existing orbit limit instead of twice the previous focus distance. This
returns rotation to the ground when vertical movement left the focus in the air.
It adds no per-frame raycast and retains the isometric scale. Ordinary gestures
keep their shorter ray; cave navigation and explicitly pinned discoveries retain
their focus.

Recover view stops movement, cancels pending automatic metadata, turns off the
selection tool and restores a distance of 80 and pitch of 60 degrees around the
current slice midpoint. X/Z, heading, selection and discovery preferences remain.
Explicit camera placement drains old control damping before applying the pose.

## Cave light

The caves view has no clock: a fixed fill light shines from the camera, slightly above and to
the left, so walls facing the view are brightest and relief shows. Block light (torches, lava,
glowing blocks) adds to it. `setCaveBrightness(0..1.5)` scales the fill (0.2 by default, a dim light that keeps torches and
glowing blocks readable); 0
leaves only block light and glowing texels, as at night. The settings panel shows it as a
"Cave light" slider and the address keeps `caveLight` when it is not 0.2.

## Automatic following and limits

The host opts into automatic depth with a metadata loader. It is disabled by
default for embedded consumers; the local prototype enables it initially.
The local `autoDepth=0|1` URL parameter overrides the optional browser preference
`mapelix-auto-depth-v1`. Manual slicing continues to work.

Only held vertical input near a boundary requests the adjacent 16-block step.
Thickness remains 16, 32 or 64 (default 32), bounds remain section-aligned and maxY
remains exclusive. A window of 32 blocks or more asks for its neighbor a quarter of
its height (8 or 16 blocks) before its last visible block, so the next slice can load while the
focus keeps moving; the focus lies inside both slices, and overlap and camera pose
are retained. A 16-block window changes at the last visible block; the focus moves
by at most one block into its neighbor. Movement stops at dimension limits and
cannot widen the slice.

The next slice loads out of sight: its streamer requests the regions around the
camera while the current slice stays on screen, and replaces it once that terrain
is loaded, or after ten seconds. Exploring never shows an empty view between two
depths. `snapshot().navigation.loading` stays true until the replacement.

Following requires 250 ms of held intent, a settled terrain streamer and at least
2000 ms between metadata requests (configurable, minimum 1000). Only one metadata
request may be pending. It and a slice loading out of sight are dropped on manual
`setWorld`, disable, recovery, lighting changes and disposal; late replies are
ignored. Incorrect contexts and changed snapshot revisions are rejected before
any terrain loads. At most two cave streamers exist, each within the cave memory
budget, and no additional worker pool is created. Applying a slice releases the
previous streamer's meshes and requests, reusing the existing bounded mesh pool.

Caves and discovery source downloads share **two concurrent slots**, including
body download. A 429/503 `Retry-After` (seconds or HTTP date) pauses both kinds of
download, including queued requests. Other failures use bounded exponential
backoff (1–30 seconds). Retry state retains at most 256 URL keys. Cancelled queued
jobs detach listeners; disposal releases their promises and timers. Surface
streaming retains its existing parallelism. Request rate limits stay with
the serving host; the viewer waits for its advertised retry delay.

Source discovery packets/cache identities remain independent of depth. Existing
encoded/GPU budgets and LOD 0/1 are unchanged. The cave reach is 256 blocks, see
"Reach and thickness" below.
There is no server change, region/discovery format change or cache-key revision.
Already cached regions remain valid.
A server that fingerprints the two engine packages keeps its region revision,
since this change does not modify them: a viewer-only update needs no region
cache invalidation.

## What a cave slice shows

A cave slice draws the faces that border enclosed air: caverns, tunnels, mines and the
inside of buildings. It leaves out, at LOD 0 and LOD 1:

- **Open sky.** Each column's sky roof is its highest opaque block other than leaves,
  read from the top sections of the whole chunk, not only from the slice
  (`chunkRoofs`, cached per chunk). Air above it is open sky, and so is the air up to
  eight blocks under an overhang beside it (`CAVE_SKY_DEPTH`). Ground, cliffs, ravines,
  water surfaces and sea floors under the open sky therefore disappear, while a cave
  mouth keeps its passage beyond those eight blocks. This applies to the Overworld; the
  Nether, under its bedrock roof, and the End are unchanged.
- **Unstored chunks.** Land that was never generated used to read as air, so every
  slice drew stone walls around it. Faces toward chunks the world does not store are
  no longer drawn.

Region heights in a slice follow the highest block with a visible face, so a flight
lands on visible terrain. These are mesher changes: the engine fingerprint changes,
which renews cached regions, but the region format, cache keys and embed API do not.

## Reach and thickness

Caves are a true volume, so they never use the coarse LODs that keep a distant Surface
light: beyond 2-block voxels, tunnels close up or vanish. Their reach is therefore
bounded, at 256 blocks (`CAVE_LIMITS.viewDistance`, formerly 128), and the camera
zooms out to three quarters of it. In a measured world, a 64-block slice at full
reach drew 55 regions, about 19 MiB and 1 M quads, within the 32 MiB cave budget;
32-block slices weigh less. The main cost is the first build of each region on the
server, cached afterwards.

The 64-block thickness gives overviews of deep caverns and ravines; 32 stays the
default, as wider slices stack levels of caves on top of each other. Each thickness
is its own cache variant on the server, alongside 16 and 32.

## Optional host additions

No existing option, method signature, HTTP API or binary interface is removed or
changed. All additions are optional for the host; detect methods and the new
snapshot field when supporting older viewer builds.

New `WorldViewerOptions`:

| Option                                            | Meaning                                                                                                                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadDepth(context, signal): Promise<WorldInfo>`  | Host metadata loader using its own URL base/authentication. Return canonical metadata for exactly that context and current snapshot. Honor the abort signal.                                                                            |
| `autoDepth?: boolean`                             | Initially enable following; defaults to false. Has no effect without a loader.                                                                                                                                                          |
| `autoDepthIntervalMs?: number`                    | Minimum request interval, default 2000, at least 1000.                                                                                                                                                                                  |
| `onDepthChange?: (context: SceneContext) => void` | Called after a successful automatic transition or discovery navigation that changes context. Includes dimension, mode, minY, exclusive maxY and ceilingY. Update host controls/state; do not call setWorld again for this notification. |

New methods:

| Method                           | Meaning                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `setVerticalMovement(direction)` | Hold descent (-1), stop (0), ascent (1). Always send 0 on release/cancel/lost capture, blur and control unmount. No effect outside Caves. |
| `recoverCamera()`                | Restore the cave overview and clear movement/pending follow.                                                                              |
| `setAutoDepth(boolean)`          | Enable/disable following; disabling aborts pending metadata.                                                                              |

`snapshot().navigation` adds `available`, `autoDepth`, `loading` and optional-value
`error`. Older builds lack it. These additions need no new server routes.
The existing `snapshot().context` always reports the active canonical bounds.

```ts
const viewer = await WorldViewer.create(container, world, start, {
  ...existingOptions, // preserve region/discovery base paths and .bin suffixes
  loadDepth: (context, signal) => loadHostMetadata(context, signal),
  autoDepth: savedAutoDepth,
  onDepthChange: ({ minY, maxY }) => updatePanelDepth(minY, maxY),
});
if (typeof viewer.setVerticalMovement === "function") {
  // Wire host touch controls; the embedded class does not inject its own buttons.
}
```

The Svelte prototype owns its own buttons; an embedding host supplies its own.
The host loader can construct the next `WorldInfo` from its current world
description plus the requested context; no extra HTTP request is necessary when
that description and snapshot remain current.
For a manual metadata load, temporarily call `setAutoDepth(false)` before the
request, call the existing `setWorld` after it completes, then restore the user's
follow preference. Persist that preference in the host's existing store. The
viewer does not write browser preferences for embedded consumers.

## Validation

Targeted browser checks cover real keyboard and touch input on WebGPU and forced
WebGL, preserved camera pose/canvas, manual preference reload, recovery, wall
collision bypass, one pending automatic request, host callbacks and stale reply
cancellation. Unit checks cover boundaries/negative Y, 16/32-block slices,
debouncing, error handling, concurrency, retry delays and queued resource cleanup.
Build, type checks and lint pass. The unchanged engine's 182 tests are reused
from the verified Turbo cache, and all 33 viewer unit tests pass. The full browser
run passes 28 scenarios without failures, retries or skips. Four subsequent
targeted checks pass after the final mobile layout and custom-base test changes.
They include 320/430-pixel layouts and retained `.bin` URLs across auto-follow.

Each backend completes 104 Surface/Caves/Nether/End switches, with discoveries,
selection helpers and forced unpooled disposal after switch 52. Warmed equivalent
checkpoints (switches 20 to 104) give:

| Backend | Uniform buffers | Textures | JS heap           | Renderer allocation change |
| ------- | --------------- | -------- | ----------------- | -------------------------- |
| WebGPU  | 75 to 70        | 18 to 18 | 9.46 to 10.66 MiB | -54,672 bytes              |
| WebGL 2 | 77 to 72        | 18 to 18 | 9.56 to 10.85 MiB | -49,145 bytes              |

Additional shader/JS paths warm when the reuse pool is disabled. The final
36-switch heap differences are 401,432/414,108 bytes, within the existing 512 KiB
regression allowance. GPU counters remain stable; these are logical renderer
allocations and collected JS heap, not physical GPU residency or process RSS.

On the user's copied snapshot, WebGPU follows an Overworld slice from -32..0 to
-16..16 and a Nether slice from 16..48 to 32..64, with discoveries enabled and
camera distance/angles preserved. Both visits observe at most two simultaneous
terrain/discovery downloads and no browser errors. All 1,895 source files retain
their SHA-256 hashes. End navigation uses generated fixtures, since this copy
contains no saved End chunks. See the [measurement summary](benchmarks/cave-navigation-2026-11-13.json).
