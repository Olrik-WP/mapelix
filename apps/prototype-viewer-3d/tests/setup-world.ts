import { resolve } from "node:path";
import { writeFixtureWorld } from "../../../packages/mapelix-scene-prototype/test/dimension-fixture";

export default async function setupWorld(): Promise<void> {
  if (process.env.MAPELIX_E2E_WORLD_DIRECTORY) return;
  await writeFixtureWorld(resolve("../../.local/dimension-world"));
}
