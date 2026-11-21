export type MobilePixelRatio = 1 | 1.25;

export function mobilePixelRatio(value: MobilePixelRatio): MobilePixelRatio {
  if (value !== 1 && value !== 1.25) throw new RangeError("Mobile pixel ratio must be 1 or 1.25");
  return value;
}

/** Desktop keeps its existing cap; mobile quality is independent of rendering profiles. */
export function renderPixelRatio(
  deviceRatio: number,
  mobile: boolean,
  cap: MobilePixelRatio,
): number {
  return Math.min(deviceRatio, mobile ? mobilePixelRatio(cap) : 1.75);
}

/** Coarsen mobile terrain at both output ratios without changing desktop detail. */
export function renderDetailScale(pixelRatio: number, mobile: boolean): number {
  return mobile ? 2 * Math.max(1, pixelRatio) : 1;
}

/** Keep the focus ahead of the edge fade, including wide isometric views. */
export function mobileViewDistance(requested: number, focusDistance: number): number {
  return Math.min(requested, Math.max(1024, focusDistance / 0.65));
}
