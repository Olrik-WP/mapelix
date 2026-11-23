import { describe, expect, it } from "vitest";
import { Atmosphere } from "./atmosphere";
import { CAVE_BRIGHTNESS_DEFAULT } from "./cave-brightness";

describe("dimension atmosphere", () => {
  it("uses fixed cave exploration light and restores Surface lighting", () => {
    const atmosphere = new Atmosphere();
    const baseline = atmosphere.setTimeOfDay(15.5);
    atmosphere.setCaves(true);
    const light = atmosphere.setTimeOfDay(12);
    expect(atmosphere.setTimeOfDay(0)).toEqual(light);
    expect(atmosphere.caveLight.value).toBeGreaterThan(0);
    const dim = atmosphere.caveLight.value;
    atmosphere.setCaveBrightness(1);
    const full = atmosphere.caveLight.value;
    expect(dim).toBeCloseTo(full * CAVE_BRIGHTNESS_DEFAULT);
    atmosphere.setCaveBrightness(0.5);
    expect(atmosphere.caveLight.value).toBeCloseTo(full / 2);
    expect(() => atmosphere.setCaveBrightness(2)).toThrow(RangeError);
    atmosphere.setCaves(false);
    expect(atmosphere.caveLight.value).toBe(0);
    atmosphere.setCaves(true);
    expect(atmosphere.caveLight.value).toBeCloseTo(full / 2);
    atmosphere.setCaves(false);
    expect(atmosphere.setTimeOfDay(15.5)).toEqual(baseline);
  });
  it("keeps Nether and End lighting fixed across the clock", () => {
    for (const dimension of ["nether", "the-end"] as const) {
      const atmosphere = new Atmosphere();
      atmosphere.setDimension(dimension);
      const noon = atmosphere.setTimeOfDay(12);
      expect(atmosphere.setTimeOfDay(0)).toEqual(noon);
      expect(atmosphere.sunColor.value.getHex()).toBe(0);
      expect(atmosphere.environment.value).toBe(dimension === "nether" ? 1 : 2);
    }
  });
  it("restores the existing Overworld daylight after visiting another dimension", () => {
    const atmosphere = new Atmosphere();
    const baseline = atmosphere.setTimeOfDay(15.5);
    atmosphere.setDimension("nether");
    atmosphere.setTimeOfDay(15.5);
    atmosphere.setDimension("overworld");
    expect(atmosphere.setTimeOfDay(15.5)).toEqual(baseline);
    expect(atmosphere.environment.value).toBe(0);
  });
});
