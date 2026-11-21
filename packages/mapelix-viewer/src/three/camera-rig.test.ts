import { afterEach, describe, expect, it, vi } from "vitest";
import { CameraRig, type Terrain } from "./camera-rig";
import { ViewCamera } from "./view-projection";

const GROUND = 64;
const terrain: Terrain = {
  heightAt: () => GROUND,
  raycast: (origin, direction, far) => {
    if (direction.y >= 0) return undefined;
    const distance = (GROUND - origin.y) / direction.y;
    return distance >= 0 && distance < far ? { distance, axis: 1, sign: 1 } : undefined;
  },
};

function createRig(blend: number): { rig: CameraRig; camera: ViewCamera } {
  const ownerDocument = new EventTarget();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", ownerDocument);
  const element = Object.assign(new EventTarget(), {
    style: {},
    ownerDocument,
    getRootNode: () => ownerDocument,
  }) as unknown as HTMLElement;
  const camera = new ViewCamera(50, 1, 1, 4000);
  camera.projectionBlend = blend;
  const rig = new CameraRig(camera, element, terrain);
  rig.setView(
    { x: 0, y: GROUND, z: 0, distance: 160, pitch: 0.7, heading: 0.4 },
    { settle: false },
  );
  return { rig, camera };
}

afterEach(() => vi.unstubAllGlobals());

describe("vertical camera navigation", () => {
  for (const blend of [0, 1]) {
    it(`returns the orbit to the terrain after ascending, projection ${blend}`, () => {
      const { rig } = createRig(blend);
      try {
        // Held buttons use the same vertical movement as Space/Page Up.
        rig.setVerticalMovement(1);
        for (let frame = 0; frame < 30; frame += 1) rig.update(0.1);
        rig.setVerticalMovement(0);
        expect(rig.focus.y).toBeGreaterThan(GROUND + 300);
        rig.faceNorth();
        expect(rig.focus.y).toBeCloseTo(GROUND, 8);
        if (blend === 1) expect(rig.distance).toBeCloseTo(160, 8);
      } finally {
        rig.dispose();
      }
    });
  }

  it("keeps vertical cave navigation in its slice without acquiring a Surface pivot", () => {
    const { rig } = createRig(0);
    try {
      rig.setVerticalWindow({ minY: 64, maxY: 96 });
      rig.setVerticalMovement(1);
      for (let frame = 0; frame < 10; frame += 1) rig.update(0.1);
      rig.setVerticalMovement(0);
      const y = rig.focus.y;
      expect(y).toBeGreaterThan(GROUND);
      rig.faceNorth();
      expect(rig.focus.y).toBe(y);
    } finally {
      rig.dispose();
    }
  });
});
