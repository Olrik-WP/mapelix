import { expect, it, vi } from "vitest";
import { MarkerLayer } from "./marker-layer";

it("hides markers without deleting data, hit targets or projection work", () => {
  const marker = { id: "a", x: 10, z: 20, dimension: "overworld" };
  const entry = { marker, heightNext: 500 };
  const root = { hidden: false };
  const project = vi.fn();
  const schedule = vi.fn();
  const layer = Object.create(MarkerLayer.prototype) as MarkerLayer;
  Object.assign(layer, {
    root,
    visible: true,
    disposed: false,
    schedule,
    stored: new Map([["a", entry]]),
    host: { project },
    statsNow: { visible: 1, labels: 1, clusters: 0 },
  });
  layer.setVisible(false);
  layer.redraw();
  expect(root.hidden).toBe(true);
  expect(layer.get("a")).toEqual(marker);
  expect(layer.markerAt(10, 20)).toBeUndefined();
  expect(project).not.toHaveBeenCalled();
  layer.setVisible(true);
  expect(root.hidden).toBe(false);
  expect(entry.heightNext).toBe(0);
  expect(schedule).toHaveBeenCalledOnce();
});
