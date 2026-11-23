import {
  discoveryFiltersFromSearch,
  discoveryFilterSearch,
} from "@mapelix/scene-prototype/discoveries";
import { selectionFromSearch } from "@mapelix/scene-prototype/selection";
import { CAVE_LIMITS, type Dimension } from "@mapelix/scene-prototype/dimensions";
import type { MapView } from "../map/tile-math.js";
import type { MapelixViewer, WorldSettings } from "./mapelix-viewer.js";
import type { Projection } from "./view-state.js";
import { renderProfileSettings } from "./render-profile.js";
import {
  CAVE_BRIGHTNESS_DEFAULT,
  CAVE_BRIGHTNESS_MAX,
  CAVE_BRIGHTNESS_MIN,
} from "../three/cave-brightness.js";

/** Viewer options read back from an address: give them to `new MapelixViewer`. */
export interface SearchStart {
  readonly dimension?: string;
  readonly view: Partial<MapView>;
  readonly projection?: Projection;
  readonly settings: Partial<WorldSettings>;
}

const number = (params: URLSearchParams, name: string): number | undefined => {
  const raw = params.get(name);
  const value = raw === null || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : undefined;
};
const DIMENSIONS: readonly Dimension[] = ["overworld", "nether", "the-end"];

/**
 * The view and settings as address parameters: `dimension`, `x`, `z`, `scale` (CSS pixels per
 * block), `projection`, `view=caves` with `minY` and `thickness`, `ceilingY` (Nether), `hour`,
 * `weather`, `clouds=0`, `profile=low|hd` or individual rendering flags, `autoDepth=0`,
 * `caveLight` (cave brightness when not the default),
 * `mobile=1`, `mobileRatio=1|1.25`, `markers=0`, the discovery filters and the cave area.
 */
export function viewerSearch(viewer: MapelixViewer): URLSearchParams {
  const view = viewer.view;
  const settings = viewer.settings;
  const params = new URLSearchParams({
    dimension: view.dimension,
    x: String(Math.round(view.x)),
    z: String(Math.round(view.z)),
    scale: String(Number(view.pixelsPerBlock.toPrecision(3))),
    projection: view.projection,
  });
  if (settings.viewMode === "caves") {
    params.set("view", "caves");
    params.set("minY", String(settings.caveMinY));
    params.set("thickness", String(settings.caveThickness));
  }
  if (view.dimension === "nether") params.set("ceilingY", String(settings.netherCeilingY));
  params.set("hour", String(settings.hour));
  if (settings.weather !== "clear") params.set("weather", settings.weather);
  if (!settings.clouds) params.set("clouds", "0");
  if (settings.showFps) params.set("fps", "1");
  if (settings.mobileMode) params.set("mobile", "1");
  if (settings.mobilePixelRatio === 1.25) params.set("mobileRatio", "1.25");
  if (settings.showMarkers === false) params.set("markers", "0");
  if (settings.renderProfile !== undefined) params.set("profile", settings.renderProfile);
  else {
    const unlit = DIMENSIONS.filter((dimension) => settings.blockLight[dimension] === false);
    if (unlit.length) params.set("noBlockLight", unlit.join(","));
    const colored = DIMENSIONS.filter(
      (dimension) => settings.blockLightColors?.[dimension] === true,
    );
    if (colored.length) params.set("blockLightColors", colored.join(","));
    const smooth = DIMENSIONS.filter(
      (dimension) => settings.blockLightSmooth?.[dimension] === true,
    );
    if (smooth.length) params.set("blockLightSmooth", smooth.join(","));
    if (settings.textures === "on") params.set("textures", "1");
    if (settings.leaves === "detailed") params.set("leaves", "detailed");
  }
  // Apart from LOW/HD: a profile sets textures, but PBR stays the host's choice.
  if (settings.pbr === "on") params.set("pbr", "1");
  if (!settings.autoDepth) params.set("autoDepth", "0");
  if (settings.caveBrightness !== undefined && settings.caveBrightness !== CAVE_BRIGHTNESS_DEFAULT)
    params.set("caveLight", String(settings.caveBrightness));
  for (const [name, value] of discoveryFilterSearch(settings.discoveries)) params.set(name, value);
  if (settings.selection)
    for (const name of ["minX", "maxX", "minZ", "maxZ"] as const)
      params.set(name, String(settings.selection[name]));
  return params;
}

/** Reads what `viewerSearch` wrote; anything missing or invalid is left to the defaults. */
export function startFromSearch(params: URLSearchParams): SearchStart {
  const view: { -readonly [K in keyof MapView]?: MapView[K] } = {};
  const x = number(params, "x"),
    z = number(params, "z"),
    scale = number(params, "scale");
  if (x !== undefined) view.x = x;
  if (z !== undefined) view.z = z;
  if (scale !== undefined && scale > 0) view.pixelsPerBlock = scale;
  const settings: { -readonly [K in keyof WorldSettings]?: WorldSettings[K] } = {};
  if (params.get("view") === "caves") settings.viewMode = "caves";
  const minY = number(params, "minY"),
    thickness = number(params, "thickness"),
    ceilingY = number(params, "ceilingY"),
    hour = number(params, "hour");
  if (minY !== undefined && minY % 16 === 0) settings.caveMinY = minY;
  if (thickness !== undefined && CAVE_LIMITS.thicknesses.includes(thickness))
    settings.caveThickness = thickness;
  if (ceilingY !== undefined && ceilingY % 16 === 0) settings.netherCeilingY = ceilingY;
  if (hour !== undefined && hour >= 0 && hour <= 24) settings.hour = hour;
  const weather = params.get("weather");
  if (weather === "rain" || weather === "thunderstorm") settings.weather = weather;
  if (params.get("clouds") === "0") settings.clouds = false;
  if (params.get("fps") === "1" || params.get("fps") === "0")
    settings.showFps = params.get("fps") === "1";
  if (params.get("mobile") === "1" || params.get("mobile") === "0")
    settings.mobileMode = params.get("mobile") === "1";
  if (params.get("mobileRatio") === "1" || params.get("mobileRatio") === "1.25")
    settings.mobilePixelRatio = params.get("mobileRatio") === "1" ? 1 : 1.25;
  if (params.get("markers") === "0" || params.get("markers") === "1")
    settings.showMarkers = params.get("markers") !== "0";
  const unlit = params.get("noBlockLight");
  if (unlit !== null)
    settings.blockLight = Object.fromEntries(
      DIMENSIONS.map((dimension) => [dimension, !unlit.split(",").includes(dimension)]),
    );
  if (params.get("textures") === "1") settings.textures = "on";
  const colored = params.get("blockLightColors");
  const smooth = params.get("blockLightSmooth");
  if (smooth !== null)
    settings.blockLightSmooth = Object.fromEntries(
      DIMENSIONS.map((dimension) => [dimension, smooth.split(",").includes(dimension)]),
    );
  if (colored !== null)
    settings.blockLightColors = Object.fromEntries(
      DIMENSIONS.map((dimension) => [dimension, colored.split(",").includes(dimension)]),
    );
  if (params.get("leaves") === "detailed") settings.leaves = "detailed";
  if (params.get("pbr") === "1") settings.pbr = "on";
  const profile = params.get("profile");
  if (profile === "low" || profile === "hd")
    Object.assign(settings, renderProfileSettings(profile), { renderProfile: profile });
  if (params.get("autoDepth") === "0") settings.autoDepth = false;
  const caveLight = number(params, "caveLight");
  if (
    caveLight !== undefined &&
    caveLight >= CAVE_BRIGHTNESS_MIN &&
    caveLight <= CAVE_BRIGHTNESS_MAX
  )
    settings.caveBrightness = caveLight;
  try {
    const filters = discoveryFiltersFromSearch(params);
    if (filters) settings.discoveries = filters;
  } catch {
    /* Invalid filters keep the defaults. */
  }
  try {
    const selection = selectionFromSearch(params);
    if (selection) settings.selection = selection;
  } catch {
    /* An invalid area is dropped. */
  }
  const projection = params.get("projection");
  return {
    dimension: params.get("dimension") ?? undefined,
    view,
    projection: projection === "perspective" || projection === "isometric" ? projection : undefined,
    settings,
  };
}
