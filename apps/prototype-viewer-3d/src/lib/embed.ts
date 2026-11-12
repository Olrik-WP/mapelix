/**
 * The framework-free entry for hosting the 3D viewer inside another web app.
 * It carries no SvelteKit page, inline script, or server code: the host gives
 * the viewer a container, the world description, and the region path, and
 * builds its own controls around the methods of `WorldViewer`. Region requests go
 * to `{regionBase}/{level}/{x}/{z}{regionSuffix}?dimension=…&ceilingY=…&revision=…`.
 */
export { WorldViewer } from "./viewer/world-viewer";
export type {
  CameraView,
  Pointed,
  ViewerSnapshot,
  WorldInfo,
  WorldViewerOptions,
} from "./viewer/world-viewer";
export type { StreamingStats } from "./viewer/region-streamer";
export type { Dimension, SceneContext } from "@mapelix/scene-prototype/dimensions";

/**
 * Bumped whenever the exported API changes incompatibly, so a host can refuse a mismatch.
 * 2: `WorldInfo` names its `dimension` and `ceilingY`, region URLs carry both, and
 * `setWorld` switches dimension or ceiling while keeping the renderer.
 */
export const EMBED_API_VERSION = 2;

/** Whether this browser offers WebGPU or WebGL 2, one of which the viewer needs. */
export function isViewerSupported(): boolean {
  if (typeof navigator !== "undefined" && "gpu" in navigator) return true;
  try {
    return document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    return false;
  }
}
