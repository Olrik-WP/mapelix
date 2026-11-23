/** Range of the cave view's brightness: 0 leaves only torches and glowing blocks, 1 is default. */
export const CAVE_BRIGHTNESS_MIN = 0;
export const CAVE_BRIGHTNESS_MAX = 1.5;

/** Checks a cave brightness, kept apart from the 3D world so the map can check it unloaded. */
export function caveBrightness(brightness: number): number {
  if (
    !Number.isFinite(brightness) ||
    brightness < CAVE_BRIGHTNESS_MIN ||
    brightness > CAVE_BRIGHTNESS_MAX
  )
    throw new RangeError(
      `Cave brightness must be from ${CAVE_BRIGHTNESS_MIN} to ${CAVE_BRIGHTNESS_MAX}`,
    );
  return brightness;
}
