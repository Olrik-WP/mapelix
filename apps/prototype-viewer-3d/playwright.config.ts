import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";

export default defineConfig({
  projects: [{ name: "auto" }, { name: "webgl" }],
  testDir: "./tests",
  testMatch: "**/*.e2e.ts",
  globalSetup: "./tests/setup-world.ts",
  workers: 1,
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:5179",
    channel: process.env.MAPELIX_TEST_BROWSER,
    viewport: { width: 1200, height: 800 },
    launchOptions: { args: ["--enable-unsafe-swiftshader"] },
  },
  webServer: {
    command: "pnpm run dev --port 5179",
    url: "http://127.0.0.1:5179",
    reuseExistingServer: false,
    env: {
      MAPELIX_WORLD_DIRECTORY:
        process.env.MAPELIX_E2E_WORLD_DIRECTORY ?? resolve("../../.local/dimension-world"),
      MAPELIX_CACHE_DIRECTORY: resolve("../../.local/dimension-cache"),
      MAPELIX_SCENE_WORKERS: "1",
    },
  },
});
