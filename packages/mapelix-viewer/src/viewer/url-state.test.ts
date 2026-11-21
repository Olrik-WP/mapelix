import { expect, it } from "vitest";
import { DEFAULT_WORLD_SETTINGS, type MapelixViewer } from "./mapelix-viewer.js";
import { startFromSearch, viewerSearch } from "./url-state.js";

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
