/**
 * The framework-free entry for hosting the 3D viewer inside another web app.
 * It carries no SvelteKit page, inline script, or server code: the host gives
 * the viewer a container, the world description, and the region path, and
 * builds its own controls around the methods of `WorldViewer`.
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

/** Bumped whenever the exported API changes incompatibly, so a host can refuse a mismatch. */
export const EMBED_API_VERSION = 1;

/** Whether this browser offers WebGPU or WebGL 2, one of which the viewer needs. */
export function isViewerSupported(): boolean {
  if (typeof navigator !== "undefined" && "gpu" in navigator) return true;
  try {
    return document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    return false;
  }
}
