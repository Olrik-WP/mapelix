import { expect, test, type Page } from "@playwright/test";
import type { WorldViewer, WorldInfo, WorldViewerOptions } from "../src/lib/viewer/world-viewer";
import type { DiscoveryGroup } from "@mapelix/scene-prototype/discoveries";
import type { SceneContext } from "@mapelix/scene-prototype/dimensions";

declare global {
  interface Window {
    __focusViewer: WorldViewer;
    __focusContexts: SceneContext[];
    __focusEvents: (DiscoveryGroup | undefined)[];
    __markerClicks: DiscoveryGroup[];
  }
}

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
});

async function harness(page: Page, world: WorldInfo, customCard = false) {
  await page.route("**/focus-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0"><div id="viewer" style="width:960px;height:700px"></div></body></html>',
    }),
  );
  await page.goto("/focus-harness");
  await page.evaluate(
    async ({ world, customCard }) => {
      const path = "/src/lib/viewer/world-viewer.ts",
        { WorldViewer } = await import(path);
      window.__focusContexts = [];
      window.__focusEvents = [];
      window.__markerClicks = [];
      const options: WorldViewerOptions = {
        discoveryDetails: !customCard,
        autoDepth: false,
        loadDepth: async (context) => ({ ...world, ...context }),
        onDepthChange: (context) => {
          const framed = window.__focusViewer.snapshot();
          if (framed.context.mode !== context.mode || framed.view.y !== framed.selectedDiscovery?.y)
            throw new Error("The host was notified before discovery framing completed");
          window.__focusContexts.push(context);
          // A host rerender may reapply the same filter state after syncing context.
          window.__focusViewer.setDiscoveryFilters({
            enabled: true,
            categories: ["containers", "spawners"],
            ores: [],
            exposure: "all",
            allHeights: true,
          });
        },
        onDiscoveryFocusChange: (group) => window.__focusEvents.push(group),
        onDiscoverySelect: (group) => {
          window.__markerClicks.push(group);
        },
        formatDiscoveryDetails: (group) => ({
          title: `Découverte × ${group.count}`,
          lines: [`Position : ${group.x}, ${group.y}, ${group.z}`],
          closeLabel: "Fermer la découverte",
        }),
      };
      window.__focusViewer = await WorldViewer.create(
        document.getElementById("viewer")!,
        world,
        {
          x: 32,
          y: world.mode === "caves" ? -48 : 82,
          z: 16,
          distance: 60,
          heading: 0.4,
          pitch: 0.9,
        },
        options,
      );
      window.__focusViewer.setDiscoveryFilters({
        enabled: true,
        categories: ["containers", "spawners"],
        ores: [],
        exposure: "all",
        allHeights: true,
      });
    },
    { world, customCard },
  );
  await expect
    .poll(() => page.evaluate(() => window.__focusViewer.snapshot().streaming.remaining))
    .toBe(0);
}

test("surface and underground discoveries frame correctly, notify the host once, and keep a single translated card", async ({
  page,
  request,
}, testInfo) => {
  const world: WorldInfo = await (await request.get("/world.json")).json();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await harness(page, world);
  let sourceRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/discoveries/")) sourceRequests++;
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__focusViewer.snapshot().discoveries.groups.some((g) => g.x === 40 && g.y === 81),
      ),
    )
    .toBe(true);
  await expect
    .poll(() => page.evaluate(() => window.__focusViewer.snapshot().discoveries.remaining))
    .toBe(0);
  const beforeFilter = sourceRequests;
  await page.evaluate(() =>
    window.__focusViewer.setDiscoveryFilters({
      enabled: true,
      categories: ["containers", "spawners"],
      ores: [],
      exposure: "all",
      allHeights: false,
    }),
  );
  await expect
    .poll(() => page.evaluate(() => window.__focusViewer.snapshot().discoveries.grouping))
    .toBe(false);
  expect(
    await page.evaluate(() =>
      window.__focusViewer.snapshot().discoveries.groups.some((g) => g.y === -60),
    ),
  ).toBe(false);
  expect(
    await page.evaluate(() =>
      window.__focusViewer.snapshot().discoveries.groups.some((g) => g.y === 81),
    ),
  ).toBe(true);
  expect(sourceRequests).toBe(beforeFilter);
  await page.evaluate(() =>
    window.__focusViewer.setDiscoveryFilters({
      enabled: true,
      categories: ["containers", "spawners"],
      ores: [],
      exposure: "all",
      allHeights: true,
    }),
  );
  const chest = page.getByRole("button", { name: /Chest .*X 40, Y 81, Z 8/ });
  await expect(chest).toBeVisible();
  await chest.click();
  expect(await page.evaluate(() => window.__markerClicks.length)).toBe(1);
  expect(
    await page.evaluate(() => window.__focusViewer.snapshot().selectedDiscovery),
  ).toBeUndefined();
  await page.evaluate(async () => {
    const group = window.__markerClicks[0]!;
    if (!(await window.__focusViewer.focusDiscovery(group)))
      throw new Error("Surface focus failed");
  });
  const card = page.locator("[data-discovery-details]");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Découverte");
  await expect(page.getByRole("button", { name: "Fermer la découverte" })).toBeVisible();
  const first = await page.evaluate(() => window.__focusViewer.snapshot());
  expect(first.context.mode).toBe("surface");
  expect(first.view.x).toBe(40);
  expect(first.view.y).toBe(81);
  expect(first.view.z).toBe(8);
  expect(first.view.distance).toBeLessThanOrEqual(24);
  expect(first.view.heading).toBeCloseTo(0.4);
  expect(first.view.pitch).toBeCloseTo(0.9);
  expect(await page.evaluate(() => window.__focusContexts.length)).toBe(0);
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-surface-discovery-focus.png`,
  });
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__focusViewer
          .snapshot()
          .discoveries.groups.some((g) => g.y === -60 && g.kind === 11),
      ),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const group = window.__focusViewer
      .snapshot()
      .discoveries.groups.find((g) => g.y === -60 && g.kind === 11)!;
    if (!(await window.__focusViewer.focusDiscovery(group))) throw new Error("Cave focus failed");
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stats = window.__focusViewer.snapshot().streaming;
        return stats.cached > 0 && stats.quads > 0 && stats.remaining === 0 && stats.loading === 0;
      }),
    )
    .toBe(true);
  await page.waitForTimeout(550);
  const cave = await page.evaluate(() => window.__focusViewer.snapshot());
  expect(cave.context).toMatchObject({ mode: "caves", minY: -64, maxY: -32 });
  expect(cave.view.y).toBe(-60);
  expect(cave.view.heading).toBeCloseTo(0.4);
  expect(cave.view.pitch).toBeCloseTo(0.9);
  expect(await page.evaluate(() => window.__focusContexts)).toMatchObject([
    { mode: "caves", minY: -64, maxY: -32 },
  ]);
  await expect(card).toContainText("-60");
  await expect(card).toHaveCount(1);
  await page.screenshot({ path: `test-results/${testInfo.project.name}-cave-discovery-focus.png` });
  await page.mouse.move(600, 420);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(660, 440, { steps: 8 });
  await page.mouse.up({ button: "right" });
  await expect(card).toBeVisible();
  await page.mouse.click(700, 450);
  await expect(card).toBeHidden();
  await page.evaluate((world) => {
    window.__focusViewer.setWorld(
      { ...world, mode: "caves", minY: -64, maxY: -48, ceilingY: -48 },
      true,
    );
    window.__focusViewer.setWorld(world, true);
  }, world);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stats = window.__focusViewer.snapshot().streaming;
        return stats.cached > 0 && stats.remaining === 0 && stats.loading === 0;
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const group = window.__focusEvents.find((entry) => entry?.kind === 11)!;
    if (!(await window.__focusViewer.focusDiscovery(group)))
      throw new Error("Remembered thickness focus failed");
  });
  expect(await page.evaluate(() => window.__focusViewer.snapshot().context)).toMatchObject({
    mode: "caves",
    minY: -64,
    maxY: -48,
  });
  await page.evaluate(() => window.__focusViewer.dispose());
  await expect(card).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a host-owned card receives selection and dismissal; legacy focusOn approaches without surface drift", async ({
  page,
  request,
}) => {
  const world: WorldInfo = await (await request.get("/world.json")).json();
  await harness(page, world, true);
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__focusViewer.snapshot().discoveries.groups.some((g) => g.x === 40 && g.y === 81),
      ),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const group = window.__focusViewer
      .snapshot()
      .discoveries.groups.find((g) => g.x === 40 && g.y === 81)!;
    await window.__focusViewer.focusDiscovery(group);
  });
  expect(await page.evaluate(() => window.__focusEvents.filter(Boolean).length)).toBe(1);
  await expect(page.locator("[data-discovery-details]")).toBeHidden();
  await page.mouse.wheel(0, 100);
  await expect
    .poll(() => page.evaluate(() => window.__focusViewer.snapshot().selectedDiscovery))
    .toBeUndefined();
  expect(await page.evaluate(() => window.__focusEvents.at(-1))).toBeUndefined();
  await page.evaluate(() => window.__focusViewer.focusOn({ x: 40, y: 81, z: 8 }));
  await page.waitForTimeout(350);
  const view = await page.evaluate(() => window.__focusViewer.snapshot().view);
  expect(view.x).toBeCloseTo(40);
  expect(view.y).toBeCloseTo(81);
  expect(view.z).toBeCloseTo(8);
  expect(view.distance).toBeLessThanOrEqual(24);
  await page.evaluate(async () => {
    const group = window.__focusViewer
      .snapshot()
      .discoveries.groups.find((g) => g.x === 40 && g.y === 81)!;
    await window.__focusViewer.focusDiscovery(group);
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { x: 500, y: 400, id: 1 },
      { x: 600, y: 400, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { x: 460, y: 400, id: 1 },
      { x: 600, y: 400, id: 2 },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect
    .poll(() => page.evaluate(() => window.__focusViewer.snapshot().selectedDiscovery))
    .toBeUndefined();
  await page.evaluate(() => window.__focusViewer.dispose());
});

test("Space and isolated Shift respect focused controls, chords, blur and Shift mouse gestures", async ({
  page,
  request,
}) => {
  const world: WorldInfo = await (
    await request.get("/world.json?mode=caves&minY=-64&maxY=-32")
  ).json();
  await harness(page, world);
  const y = () => page.evaluate(() => window.__focusViewer.snapshot().view.y);
  await page.keyboard.down("Space");
  await page.waitForTimeout(300);
  await page.keyboard.up("Space");
  expect(await y()).toBeGreaterThan(-46);
  const beforeShift = await y();
  await page.keyboard.down("Shift");
  await page.waitForTimeout(450);
  expect(await y()).toBeLessThan(beforeShift - 1);
  await page.keyboard.down("KeyW");
  const chord = await y();
  await page.waitForTimeout(250);
  expect(await y()).toBeCloseTo(chord, 1);
  await page.keyboard.up("KeyW");
  await page.keyboard.up("Shift");
  await page.evaluate(() => {
    const controls = document.createElement("div");
    controls.id = "host-controls";
    controls.innerHTML =
      '<button>Host button</button><input type="checkbox"><input type="range"><select><option>A</option></select><input type="text"><div contenteditable="true">Text</div>';
    document.body.append(controls);
  });
  for (const control of await page.locator("#host-controls > *").all()) {
    await control.focus();
    const before = await y();
    await page.keyboard.down("Space");
    await page.waitForTimeout(100);
    await page.keyboard.up("Space");
    expect(await y()).toBeCloseTo(before, 2);
  }
  const hostButton = page.getByRole("button", { name: "Host button", exact: true });
  await hostButton.evaluate((button) => {
    button.addEventListener("keydown", (event) => {
      const key = event as KeyboardEvent;
      if (key.code === "Space") {
        key.preventDefault();
        window.__focusViewer.setVerticalMovement(-1);
      }
    });
    button.addEventListener("keyup", () => window.__focusViewer.setVerticalMovement(0));
  });
  await hostButton.focus();
  const hostY = await y();
  await page.keyboard.down("Space");
  await page.waitForTimeout(250);
  await page.keyboard.up("Space");
  expect(await y()).toBeLessThan(hostY - 1);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.keyboard.down("Shift");
  await page.waitForTimeout(220);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const blurred = await y();
  await page.waitForTimeout(220);
  expect(await y()).toBeCloseTo(blurred, 2);
  await page.keyboard.up("Shift");
  await page.keyboard.down("ShiftRight");
  await page.waitForTimeout(220);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const hiddenY = await y();
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(220);
  expect(await y()).toBeCloseTo(hiddenY, 2);
  await page.keyboard.up("ShiftRight");
  const before = await page.evaluate(() => window.__focusViewer.snapshot().view);
  await page.keyboard.down("Shift");
  await page.mouse.move(500, 400);
  await page.mouse.down();
  await page.mouse.move(550, 400, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  const after = await page.evaluate(() => window.__focusViewer.snapshot().view);
  expect(after.heading).toBeCloseTo(before.heading, 3);
  expect(after.y).toBeCloseTo(before.y, 2);
  expect(Math.abs(after.x - before.x) + Math.abs(after.z - before.z)).toBeGreaterThan(1);
  await page.evaluate(() => window.__focusViewer.dispose());
});
