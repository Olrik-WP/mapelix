import { resolve } from "node:path";
import { writeFixtureWorld } from "../../../packages/mapelix-scene-prototype/test/dimension-fixture";
import { modelFixtureRecords } from "../../../packages/mapelix-scene-prototype/test/model-fixture";
import { caveFixtureRecords } from "../../../packages/mapelix-scene-prototype/test/cave-fixture";

export default async function setupWorld(): Promise<void> {
  if (process.env.MAPELIX_E2E_WORLD_DIRECTORY) return;
  await writeFixtureWorld(resolve("../../.local/dimension-world"), [
    ...modelFixtureRecords(),
    ...caveFixtureRecords(),
  ]);
}
