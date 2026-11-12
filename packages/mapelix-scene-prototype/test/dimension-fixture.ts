import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FixtureRecord {
  readonly key: Uint8Array;
  readonly value: Uint8Array;
}

export function chunkKey(
  dimension: number,
  x: number,
  z: number,
  tag: number,
  y?: number,
): Uint8Array {
  const offset = dimension === 0 ? 8 : 12;
  const key = new Uint8Array(offset + (y === undefined ? 1 : 2));
  const view = new DataView(key.buffer);
  view.setInt32(0, x, true);
  view.setInt32(4, z, true);
  if (dimension !== 0) view.setInt32(8, dimension, true);
  key[offset] = tag;
  if (y !== undefined) key[offset + 1] = y & 255;
  return key;
}

function paletteEntry(name: string): Uint8Array {
  const encoded = new TextEncoder().encode(name);
  const entry = new Uint8Array(13 + encoded.length);
  entry.set([10, 0, 0, 8, 4, 0, 110, 97, 109, 101]);
  new DataView(entry.buffer).setUint16(10, encoded.length, true);
  entry.set(encoded, 12);
  return entry;
}

/** A v9 disk subchunk with a four-bit palette and real little-endian block NBT. */
export function sectionRecord(
  dimension: number,
  x: number,
  z: number,
  y: number,
  block: string | ((x: number, y: number, z: number) => string),
): FixtureRecord {
  const names: string[] = [];
  const words = new Uint32Array(512);
  for (let index = 0; index < 4096; index++) {
    const name =
      typeof block === "string"
        ? block
        : block(x * 16 + (index >> 8), y * 16 + (index & 15), z * 16 + ((index >> 4) & 15));
    let id = names.indexOf(name);
    if (id < 0) {
      id = names.length;
      names.push(name);
    }
    if (id > 15) throw new Error("Fixture palette exceeds four bits");
    words[index >> 3] = words[index >> 3]! | (id << ((index & 7) * 4));
  }
  const entries = names.map(paletteEntry);
  const value = new Uint8Array(
    4 + words.byteLength + 4 + entries.reduce((size, entry) => size + entry.length, 0),
  );
  value.set([9, 1, y & 255, 8]);
  const view = new DataView(value.buffer);
  for (let index = 0; index < words.length; index++)
    view.setUint32(4 + index * 4, words[index]!, true);
  view.setUint32(4 + words.byteLength, names.length, true);
  let offset = 8 + words.byteLength;
  for (const entry of entries) {
    value.set(entry, offset);
    offset += entry.length;
  }
  return { key: chunkKey(dimension, x, z, 0x2f, y), value };
}

export function biomeRecord(
  dimension: number,
  x: number,
  z: number,
  biomes: readonly number[],
): FixtureRecord {
  const value = new Uint8Array(512 + biomes.length * 5);
  const view = new DataView(value.buffer);
  biomes.forEach((biome, index) => {
    value[512 + index * 5] = 1;
    view.setInt32(513 + index * 5, biome, true);
  });
  return { key: chunkKey(dimension, x, z, 0x2b), value };
}

export function dimensionFixtureRecords(): FixtureRecord[] {
  const records: FixtureRecord[] = [];
  for (let z = 0; z < 4; z++) {
    for (let x = 0; x < 4; x++) {
      records.push(
        sectionRecord(0, x, z, 4, (_x, y) =>
          y === 79 ? "minecraft:grass_block" : "minecraft:stone",
        ),
      );
      records.push(biomeRecord(0, x, z, Array<number>(24).fill(1)));
      records.push(
        sectionRecord(1, x, z, 0, (wx, y) =>
          y === 15
            ? wx < 32
              ? "minecraft:crimson_nylium"
              : "minecraft:warped_nylium"
            : "minecraft:netherrack",
        ),
      );
      for (let section = 1; section < 6; section++) {
        records.push(
          sectionRecord(1, x, z, section, (wx, y, wz) => {
            if (wx === 0 || wx === 63 || wz === 0 || wz === 63) return "minecraft:netherrack";
            if (y === 31 && wx >= 8 && wx < 24 && wz >= 8 && wz < 24) return "minecraft:lava";
            if (wx === 30 && wz === 30 && y === 50) return "minecraft:glowstone";
            if (wx === 32 && wz === 30 && y === 50) return "example:unknown_crystal";
            return "minecraft:air";
          }),
        );
      }
      records.push(
        sectionRecord(1, x, z, 6, "minecraft:bedrock"),
        sectionRecord(1, x, z, 7, "minecraft:bedrock"),
      );
      records.push(biomeRecord(1, x, z, Array<number>(8).fill(x < 2 ? 179 : 180)));
      records.push(sectionRecord(2, x, z, x < 2 ? 3 : 7, "minecraft:end_stone"));
      records.push(biomeRecord(2, x, z, Array<number>(16).fill(9)));
    }
  }
  return records;
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  while (value >= 128) {
    bytes.push((value & 127) | 128);
    value >>>= 7;
  }
  return [...bytes, value];
}

function maskedCrc32c(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f6_3b78 : 0);
  }
  crc = ~crc;
  return (((crc >>> 15) | (crc << 17)) + 0xa282_ead8) >>> 0;
}

/** Writes only a generated test database; never opens or changes a Minecraft database. */
export async function writeFixtureWorld(
  directory: string,
  records = dimensionFixtureRecords(),
): Promise<void> {
  const fragments: Uint8Array[] = [];
  let position = 0;
  for (const [index, record] of records.entries()) {
    const payload = new Uint8Array(
      12 +
        1 +
        varint(record.key.length).length +
        record.key.length +
        varint(record.value.length).length +
        record.value.length,
    );
    const view = new DataView(payload.buffer);
    view.setBigUint64(0, BigInt(index + 1), true);
    view.setUint32(8, 1, true);
    payload.set(
      [
        1,
        ...varint(record.key.length),
        ...record.key,
        ...varint(record.value.length),
        ...record.value,
      ],
      12,
    );
    const frame = new Uint8Array(7 + payload.length);
    frame[6] = 1; // FULL physical record.
    new DataView(frame.buffer).setUint16(4, payload.length, true);
    frame.set(payload, 7);
    new DataView(frame.buffer).setUint32(0, maskedCrc32c(new Uint8Array([1, ...payload])), true);
    const remaining = 32768 - (position % 32768);
    if (remaining < frame.length) {
      fragments.push(new Uint8Array(remaining));
      position += remaining;
    }
    fragments.push(frame);
    position += frame.length;
  }
  await mkdir(join(directory, "db"), { recursive: true });
  await writeFile(join(directory, "db", "000001.log"), Buffer.concat(fragments));
  await writeFile(join(directory, "levelname.txt"), "Dimension test world");
}
