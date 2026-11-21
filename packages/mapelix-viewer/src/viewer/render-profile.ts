import type { BlockLightSettings, LeafMode, TextureMode } from "../three/world-viewer.js";

/** Optional rendering presets; time, weather and the FPS readout stay independent. */
export type RenderProfile = "low" | "hd";

export interface RenderProfileSettings {
  readonly textures: TextureMode;
  readonly leaves: LeafMode;
  readonly blockLight: BlockLightSettings;
  readonly blockLightColors: BlockLightSettings;
  readonly blockLightSmooth: BlockLightSettings;
}

export function renderProfileSettings(profile: RenderProfile): RenderProfileSettings {
  if (profile !== "low" && profile !== "hd")
    throw new RangeError(`Unknown render profile ${String(profile)}`);
  const enabled = profile === "hd";
  const lighting = { overworld: enabled, nether: enabled, "the-end": enabled };
  return {
    textures: enabled ? "on" : "off",
    leaves: enabled ? "detailed" : "fast",
    blockLight: lighting,
    blockLightColors: lighting,
    blockLightSmooth: lighting,
  };
}
