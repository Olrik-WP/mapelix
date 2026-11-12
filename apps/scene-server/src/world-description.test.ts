import { describe, expect, it } from "vitest";

import { describeDimension } from "./world-description.js";

const spawn = { x: 800, y: 70, z: -160 };

describe("describeDimension", () => {
  it("gives each dimension the engine's profile and a starting point", () => {
    expect(describeDimension("overworld", undefined, spawn)).toMatchObject({
      id: "overworld",
      minY: -64,
      maxY: 320,
      defaultCeilingY: 320,
      bounds: null,
      spawn,
    });
    expect(describeDimension("nether", undefined, spawn)).toMatchObject({
      defaultCeilingY: 96,
      maxY: 128,
      spawn: { x: 100, y: 64, z: -20 },
    });
    expect(describeDimension("the-end", undefined, spawn).spawn).toEqual({ x: 100, y: 64, z: 0 });
  });

  it("starts in the middle of the stored area when the default lies outside it", () => {
    const stored = { minX: 1000, minZ: 1000, maxX: 1200, maxZ: 1400 };
    expect(describeDimension("nether", stored, spawn).spawn).toEqual({ x: 1100, y: 64, z: 1200 });
    const inside = { minX: 0, minZ: -100, maxX: 200, maxZ: 100 };
    expect(describeDimension("nether", inside, spawn).spawn).toEqual({ x: 100, y: 64, z: -20 });
  });
});
