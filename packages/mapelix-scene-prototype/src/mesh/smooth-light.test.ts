import { expect, it } from "vitest";
import { Face } from "../format.js";
import { faceSteps, mergeKey, mergeSlice, sliceLayout } from "./voxel-faces.js";
import { cornerLight, repeatLight } from "./smooth-light.js";

const size = 12,
  steps = faceSteps(size),
  layer = 5,
  front = layer * size * size + 5 * size + 5;
const bytes = (word: number) => Array.from({ length: 4 }, (_, i) => (word >>> (i * 8)) & 255);

it("uses identical shared corner samples across neighboring faces", () => {
  const read = (i: number) => {
    const x = i % size,
      z = Math.floor(i / size) % size;
    return (2 << 4) | Math.max(1, 15 - Math.abs(x - 5) - Math.abs(z - 5));
  };
  const a = bytes(cornerLight(steps, Face.PositiveY, front, layer, read, () => false));
  const b = bytes(cornerLight(steps, Face.PositiveY, front + 1, layer, read, () => false));
  expect(a[1]).toBe(b[0]);
  expect(a[2]).toBe(b[3]);
  expect(a.every((v) => v >>> 4 === 2)).toBe(true);
});

it("blocks diagonal light behind two touching opaque sides", () => {
  const corner = cornerLight(
    steps,
    Face.PositiveY,
    front,
    layer,
    (i) => (i === front - size - 1 ? 0x2f : 0),
    (i) => i === front - 1 || i === front - size,
  );
  expect(corner & 255).toBe(0);
  expect(repeatLight(0x2b)).toBe(0x2b2b2b2b);
});

it.each([false, true])(
  "merges uniform and linear smooth fields without losing interior vertices, gradient=%s",
  (gradient) => {
    const width = 6,
      height = 3,
      layout = sliceLayout(Face.PositiveY, width, height);
    const key = mergeKey(0, 16, 0, false, Face.PositiveY);
    const keys = new Uint32Array(layout.area).fill(key, 0, width * height),
      colors = new Uint32Array(layout.area).fill(0x80ffffff),
      lights = new Uint32Array(layout.area);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const a = gradient ? 12 - x - y : 10,
          b = gradient ? a - 1 : a,
          d = gradient ? a - 1 : a,
          c = gradient ? a - 2 : a;
        lights[y * width + x] = (a | (b << 8) | (c << 16) | (d << 24)) >>> 0;
      }
    const emitted: { width: number; height: number; light: number | undefined }[] = [];
    mergeSlice(
      Face.PositiveY,
      keys,
      colors,
      layout,
      (_key, _color, _u, _v, w, h, _texture, light) => emitted.push({ width: w, height: h, light }),
      undefined,
      lights,
    );
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ width, height });
    expect(bytes(emitted[0]!.light!)).toEqual(gradient ? [12, 6, 3, 9] : [10, 10, 10, 10]);
  },
);

it("keeps a nonlinear smooth peak rather than stretching a gradient across it", () => {
  const layout = sliceLayout(Face.PositiveY, 2, 1),
    keys = new Uint32Array(layout.area).fill(mergeKey(0, 16, 0, false, Face.PositiveY), 0, 2);
  const colors = new Uint32Array(layout.area).fill(255),
    lights = Uint32Array.of(0x090b0b09, 0x0b09090b);
  let quads = 0;
  mergeSlice(Face.PositiveY, keys, colors, layout, () => quads++, undefined, lights);
  expect(quads).toBe(2);
});
