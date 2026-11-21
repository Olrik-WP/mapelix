import { describe, expect, it } from "vitest";
import { mobilePixelRatio, mobileViewDistance, renderPixelRatio } from "./render-quality";

describe("independent mobile rendering budget", () => {
  it("retains desktop resolution and avoids supersampling low-density screens", () => {
    expect(renderPixelRatio(3, false, 1)).toBe(1.75);
    expect(renderPixelRatio(1, false, 1.25)).toBe(1);
    expect(renderPixelRatio(1, true, 1.25)).toBe(1);
  });
  it("supports the two mobile caps and refuses invalid values", () => {
    expect(renderPixelRatio(3, true, 1.25)).toBe(1.25);
    expect(renderPixelRatio(3, true, 1)).toBe(1);
    expect(() => mobilePixelRatio(2 as 1)).toThrow(RangeError);
  });
  it("limits the view while retaining the focus in wide isometric views", () => {
    expect(mobileViewDistance(4000, 160)).toBe(1024);
    expect(mobileViewDistance(512, 160)).toBe(512);
    const far = mobileViewDistance(6000, 3000);
    expect(far).toBeLessThan(6000);
    expect(3000).toBeLessThan(far * 0.7);
  });
});
