import { afterEach, describe, expect, it, vi } from "vitest";
import { Vector3 } from "three/webgpu";
import { WorldViewer } from "./world-viewer";
import { ViewCamera } from "./view-projection";

afterEach(() => vi.unstubAllGlobals());

describe("marker terrain and CSS projection", () => {
  it("uses the displayed LOD height instead of a cached finer altitude", () => {
    const world = Object.create(WorldViewer.prototype) as WorldViewer;
    Object.assign(world, { streamer: { heightAt: () => 80, exactHeightAt: () => 112 } });
    expect(world.surfaceHeightAt(0, 0)).toBe(80);
    Object.assign(world, { streamer: { heightAt: () => undefined, exactHeightAt: () => 112 } });
    expect(world.surfaceHeightAt(0, 0)).toBeUndefined();
  });

  for (const blend of [0, 1]) {
    it(`projects into CSS pixels through DPR and viewport changes, projection ${blend}`, () => {
      const world = Object.create(WorldViewer.prototype) as WorldViewer;
      const camera = new ViewCamera(50, 1, 1, 4000);
      const point = new Vector3(10, 80, 20);
      camera.position.copy(point).add(new Vector3(20, 80, 100));
      camera.lookAt(point);
      camera.updateMatrixWorld();
      camera.focusDistance = camera.position.distanceTo(point);
      camera.projectionBlend = blend;
      Object.assign(world, { camera, projected: new Vector3() });
      for (const dpr of [1, 1.25, 3]) {
        vi.stubGlobal("window", { devicePixelRatio: dpr });
        for (const [width, height] of [
          [390, 844],
          [844, 390],
        ]) {
          camera.aspect = width! / height!;
          camera.updateProjectionMatrix();
          Object.assign(world, { screenWidth: width, screenHeight: height });
          const projected = world.projectToScreen(point.x, point.y, point.z)!;
          expect(projected.x).toBeCloseTo(width! / 2, 6);
          expect(projected.y).toBeCloseTo(height! / 2, 6);
        }
      }
    });
  }
});
