import { expect, it } from "vitest";
import { buildBlockLight } from "./block-light.js";

it("attenuates in all six directions and takes the strongest source", () => {
  const width = 33,
    layers = 33,
    area = width ** 2;
  const index = (x: number, y: number, z: number) => y * area + z * width + x;
  const source = index(16, 16, 16);
  const weak = index(19, 16, 16);
  const light = buildBlockLight({
    width,
    layers,
    emission: (i) => (i === source ? 15 : i === weak ? 7 : 0),
    opaque: () => false,
  })!;
  expect(light[source]).toBe(15);
  for (const step of [1, -1, width, -width, area, -area]) {
    expect(light[source + step]).toBe(14);
    expect(light[source + step * 14]).toBe(1);
    expect(light[source + step * 15]).toBe(0);
  }
  expect(light[weak]).toBe(12);
});

it("stops at opaque walls while opaque emitters still light their neighbors", () => {
  const width = 20,
    area = width ** 2,
    source = 10 * area + 10 * width + 8;
  const light = buildBlockLight({
    width,
    layers: 20,
    emission: (i) => (i === source ? 15 : 0),
    opaque: (i) => i === source || i % width === 10,
  })!;
  expect(light[source + 1]).toBe(14);
  expect(light[source + 2]).toBe(0);
  expect(light[source + 3]).toBe(0);
});

it("does not wrap a row or layer at volume boundaries", () => {
  const width = 32,
    area = width ** 2;
  const light = buildBlockLight({
    width,
    layers: 2,
    emission: (i) => (i === 0 ? 15 : 0),
    opaque: () => false,
  })!;
  expect(light[width - 1]).toBe(0);
  expect(light[area - 1]).toBe(0);
  expect(light[area]).toBe(14);
  expect(
    buildBlockLight({ width: 2, layers: 1, emission: () => 0, opaque: () => false }),
  ).toBeUndefined();
});

it("carries the strongest source color in one byte without changing any light level", () => {
  const source = {
    width: 33,
    layers: 1,
    emission: (i: number) => (i === 16 * 33 + 12 ? 15 : i === 16 * 33 + 20 ? 10 : 0),
    opaque: () => false,
  };
  const plain = buildBlockLight(source)!;
  const colored = buildBlockLight({ ...source, color: (i) => (i === 16 * 33 + 12 ? 3 : 1) })!;
  expect(colored.byteLength).toBe(plain.byteLength);
  expect(colored.map((v) => v & 15)).toEqual(plain);
  expect(colored[16 * 33 + 13]).toBe((3 << 4) | 14);
  expect(colored[16 * 33 + 24]).toBe((1 << 4) | 6);
});

it("settles equal-strength colors consistently before propagating the next level", () => {
  const colors = [1, 3];
  for (const reverse of [false, true]) {
    const light = buildBlockLight({
      width: 11,
      layers: 1,
      emission: (i) => (i === 5 * 11 + 3 || i === 5 * 11 + 7 ? 7 : 0),
      color: (i) => colors[(i === 5 * 11 + 3 ? 0 : 1) ^ Number(reverse)]!,
      opaque: () => false,
    })!;
    expect(light[5 * 11 + 5]).toBe((1 << 4) | 5);
    expect(light[4 * 11 + 5]).toBe((1 << 4) | 4);
  }
});
