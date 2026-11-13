import { resolve } from "node:path";
import {
  writeFixtureWorld,
  sectionRecord,
  biomeRecord,
} from "../../../packages/mapelix-scene-prototype/test/dimension-fixture";
import { modelFixtureRecords } from "../../../packages/mapelix-scene-prototype/test/model-fixture";
import { caveFixtureRecords } from "../../../packages/mapelix-scene-prototype/test/cave-fixture";

export default async function setupWorld(): Promise<void> {
  if (process.env.MAPELIX_E2E_WORLD_DIRECTORY) return;
  await writeFixtureWorld(resolve("../../.local/dimension-world"), [
    ...modelFixtureRecords(),
    ...caveFixtureRecords(),
    sectionRecord(0, 2, 0, 5, (x, y, z) => {
      if (y === 80) return "minecraft:stone";
      if (y === 81 && z === 8 && x === 40) return "minecraft:chest";
      if (y === 81 && z === 8 && x === 44) return "minecraft:barrel";
      return "minecraft:air";
    }),
    biomeRecord(
      0,
      2,
      0,
      Array.from({ length: 24 }, () => 1),
    ),
  ]);
}
