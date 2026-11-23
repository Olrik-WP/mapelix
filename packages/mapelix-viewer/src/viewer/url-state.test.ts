import { expect, it } from "vitest";
import { DEFAULT_WORLD_SETTINGS, type MapelixViewer } from "./mapelix-viewer.js";
import { startFromSearch, viewerSearch } from "./url-state.js";
import { renderProfileSettings } from "./render-profile.js";

it("keeps mobile rendering and marker visibility independent of LOW/HD", () => {
  for (const profile of ["low", "hd"] as const) {
    for (const mobilePixelRatio of [1, 1.25] as const) {
      const settings = {
        ...DEFAULT_WORLD_SETTINGS,
        ...renderProfileSettings(profile),
        renderProfile: profile,
        mobileMode: true,
        mobilePixelRatio,
        showMarkers: false,
      };
      const viewer = {
        settings,
        view: { dimension: "overworld", x: 0, z: 0, pixelsPerBlock: 12, projection: "isometric" },
      } as unknown as MapelixViewer;
      const search = viewerSearch(viewer);
      expect(search.get("mobileRatio")).toBe(mobilePixelRatio === 1 ? null : "1.25");
      expect({ ...DEFAULT_WORLD_SETTINGS, ...startFromSearch(search).settings }).toMatchObject({
        renderProfile: profile,
        mobileMode: true,
        mobilePixelRatio,
        showMarkers: false,
        ...renderProfileSettings(profile),
      });
    }
  }
  expect(DEFAULT_WORLD_SETTINGS).toMatchObject({
    mobileMode: false,
    mobilePixelRatio: 1,
    showMarkers: true,
  });
  expect(
    startFromSearch(new URLSearchParams("mobile=0&mobileRatio=3&markers=1")).settings,
  ).toMatchObject({ mobileMode: false, showMarkers: true });
});

it("round-trips LOW/HD without independent geometry flags or changes to sky and FPS", () => {
  for (const profile of ["low", "hd"] as const) {
    const settings = {
      ...DEFAULT_WORLD_SETTINGS,
      ...renderProfileSettings(profile),
      renderProfile: profile,
      hour: 23,
      weather: "thunderstorm" as const,
      showFps: true,
    };
    const viewer = {
      settings,
      view: { dimension: "nether", x: 0, z: 0, pixelsPerBlock: 12, projection: "isometric" },
    } as unknown as MapelixViewer;
    const search = viewerSearch(viewer);
    expect(search.get("profile")).toBe(profile);
    for (const name of [
      "textures",
      "leaves",
      "noBlockLight",
      "blockLightColors",
      "blockLightSmooth",
    ])
      expect(search.has(name)).toBe(false);
    expect(startFromSearch(search).settings).toMatchObject({
      ...renderProfileSettings(profile),
      renderProfile: profile,
      hour: 23,
      weather: "thunderstorm",
      showFps: true,
    });
  }
  expect(
    startFromSearch(new URLSearchParams("profile=other")).settings.renderProfile,
  ).toBeUndefined();
  // PBR rides along with or without a profile.
  for (const profile of [undefined, "hd"] as const) {
    const viewer = {
      settings: { ...DEFAULT_WORLD_SETTINGS, renderProfile: profile, pbr: "on" as const },
      view: { dimension: "overworld", x: 0, z: 0, pixelsPerBlock: 12, projection: "isometric" },
    } as unknown as MapelixViewer;
    const search = viewerSearch(viewer);
    expect(search.get("pbr")).toBe("1");
    expect(startFromSearch(search).settings.pbr).toBe("on");
  }
  expect(startFromSearch(new URLSearchParams("pbr=2")).settings.pbr).toBeUndefined();
  expect(
    startFromSearch(new URLSearchParams("profile=low&textures=1&blockLightColors=nether")).settings,
  ).toMatchObject(renderProfileSettings("low"));
});

it("keeps smoothing off by default and independent per dimension", () => {
  expect(DEFAULT_WORLD_SETTINGS.blockLightSmooth).toEqual({});
  expect(startFromSearch(new URLSearchParams()).settings.blockLightSmooth).toBeUndefined();
  const start = startFromSearch(
    new URLSearchParams("blockLightSmooth=overworld&blockLightColors=nether"),
  );
  expect(start.settings.blockLightSmooth).toEqual({
    overworld: true,
    nether: false,
    "the-end": false,
  });
  expect(start.settings.blockLightColors).toEqual({
    overworld: false,
    nether: true,
    "the-end": false,
  });
});

it("round-trips light colors independently of each dimension's light switch", () => {
  const settings = {
    ...DEFAULT_WORLD_SETTINGS,
    blockLight: { nether: false },
    blockLightColors: { overworld: true, nether: true },
  };
  const viewer = {
    settings,
    view: { dimension: "overworld", x: 0, z: 0, pixelsPerBlock: 12, projection: "isometric" },
  } as unknown as MapelixViewer;
  const search = viewerSearch(viewer),
    start = startFromSearch(search);
  expect(search.get("blockLightColors")).toBe("overworld,nether");
  expect(start.settings.blockLight).toEqual({ overworld: true, nether: false, "the-end": true });
  expect(start.settings.blockLightColors).toEqual({
    overworld: true,
    nether: true,
    "the-end": false,
  });
  expect(startFromSearch(new URLSearchParams()).settings.blockLightColors).toBeUndefined();
});
