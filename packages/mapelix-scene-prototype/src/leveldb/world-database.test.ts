import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readLevelDbRecords } from "@mapelix/prototype/bedrock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorldDatabase } from "./world-database.js";
import { RegionBuilder } from "../node/region-builder.js";

const run = promisify(execFile);
const fixture = fileURLToPath(
  new URL("../../../mapelix-prototype/test/fixtures/2000world.mcworld", import.meta.url),
);

describe("seekable world database", () => {
  let directory: string;
  let database: WorldDatabase;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mapelix-scene-fixture-"));
    await run("unzip", ["-qq", fixture, "-d", directory]);
    database = WorldDatabase.open(directory);
  });

  afterAll(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("returns the same live records as a full scan for every chunk", async () => {
    const names = await readdir(join(directory, "db"));
    const files = await Promise.all(
      names.map(async (name) => ({ name, bytes: await readFile(join(directory, "db", name)) })),
    );
    const expected = new Map<string, Map<string, string>>();
    for (const record of readLevelDbRecords(files)) {
      // Overworld chunk records start with the two little-endian chunk coordinates.
      if (record.key.length !== 9 && record.key.length !== 10) continue;
      const prefix = hex(record.key.subarray(0, 8));
      const chunk = expected.get(prefix) ?? new Map<string, string>();
      chunk.set(hex(record.key), hex(record.value));
      expected.set(prefix, chunk);
    }
    expect(expected.size).toBeGreaterThan(10);

    for (const [prefix, records] of expected) {
      const found = new Map<string, string>();
      for (const record of database.readPrefix(bytes(prefix))) {
        if (record.key.length === 9 || record.key.length === 10) {
          found.set(hex(record.key), hex(record.value));
        }
      }
      expect(found).toEqual(records);
    }
  });

  it.each([
    [0, "e9d18dc8ca9ff828c71aa06e8b1cb1894cb2b42a3000b3140439130b7b19ee0e"],
    [1, "9b3b327688c41853c400e50977e3927c303d1e50bda4f6c544ff5d1b0113b0a5"],
    [3, "ee426fbed3e125600ed1307bbb4753c65a3e8832a8e3dfac7aaf1e7f62a26dab"],
    [5, "4e870ec433bd334ea2a88c9974c74b5951623ff7a656d97f9a51a32cd9f8dcab"],
  ] as const)("preserves exact Overworld region bytes from main at LOD %i", (level, expected) => {
    const builder = new RegionBuilder({ directory, dimension: "overworld" });
    try {
      const bytes = builder.build({ level, x: 0, z: 0 });
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
    } finally {
      builder.close();
    }
  });
});

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "hex"));
}
