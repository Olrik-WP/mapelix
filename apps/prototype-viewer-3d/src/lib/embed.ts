/**
 * The framework-free entry for hosting the 3D viewer inside another web app.
 * It carries no SvelteKit page, inline script, or server code: the host gives
 * the viewer a container, the world description, and the region path, and
 * builds its own controls around the methods of `WorldViewer`. Region requests go
 * to `{regionBase}/{level}/{x}/{z}{regionSuffix}?dimension=…&ceilingY=…&revision=…`
 * (surface) or `…?dimension=…&mode=caves&minY=…&maxY=…&revision=…` (cave slice), and
 * discovery requests to `{discoveryBase}/{x}/{z}{discoverySuffix}?dimension=…&revision=…&schema=1`.
 */
export { WorldViewer } from "./viewer/world-viewer";
export type {
  CameraView,
  Pointed,
  VerticalMovement,
  ViewerSnapshot,
  WorldInfo,
  WorldViewerOptions,
} from "./viewer/world-viewer";
export type { StreamingStats } from "./viewer/region-streamer";
export type { DepthNavigation } from "./viewer/depth-follow";
export type { DiscoveryStats } from "./viewer/discovery-streamer";
export type { SelectionChange, SelectionTool } from "./viewer/selection-box";
export type { Dimension, SceneContext, ViewMode } from "@mapelix/scene-prototype/dimensions";
export { CAVE_LIMITS } from "@mapelix/scene-prototype/dimensions";
export {
  DEFAULT_DISCOVERY_FILTERS,
  DISCOVERY_CATEGORIES,
  DISCOVERY_KINDS,
  DISCOVERY_LIMITS,
} from "@mapelix/scene-prototype/discoveries";
export type {
  DiscoveryCategory,
  DiscoveryFilters,
  DiscoveryGroup,
  DiscoveryKind,
} from "@mapelix/scene-prototype/discoveries";
export { SELECTION_LIMITS, selectionAround } from "@mapelix/scene-prototype/selection";
export type { HorizontalSelection } from "@mapelix/scene-prototype/selection";

/**
 * Bumped whenever the exported API changes incompatibly, so a host can refuse a mismatch.
 * 2: `WorldInfo` names its `dimension` and `ceilingY`, region URLs carry both, and
 * `setWorld` switches dimension or ceiling while keeping the renderer.
 * 3: cave slices (`mode`, `minY`, `maxY` in `WorldInfo`), the X/Z selection box and
 * discovery markers, with their options, methods, constants and snapshot state.
 * Later version 3 builds add optional members only: `loadDepth`, `autoDepth`,
 * `autoDepthIntervalMs` and `onDepthChange` options, `setVerticalMovement`,
 * `recoverCamera` and `setAutoDepth` methods, and `snapshot().navigation`. Hosts
 * detect them before use.
 */
export const EMBED_API_VERSION = 3;

/** Whether this browser offers WebGPU or WebGL 2, one of which the viewer needs. */
export function isViewerSupported(): boolean {
  if (typeof navigator !== "undefined" && "gpu" in navigator) return true;
  try {
    return document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    return false;
  }
}
