import { readLittleEndianNbtCompound } from "@mapelix/prototype/bedrock";

/** Palette color per Bedrock cell index, grouped by signed subchunk Y. */
export type BedColors = ReadonlyMap<number, ReadonlyMap<number, number>>;

/** Block entities use tag 0x31, outside the terrain/biome record classifier. */
export function isBlockEntityKey(key: Uint8Array, dimension: number): boolean {
  if (key.length !== 9 && key.length !== 13) return false;
  if (key[key.length - 1] !== 0x31) return false;
  const storedDimension =
    key.length === 9
      ? 0
      : new DataView(key.buffer, key.byteOffset, key.byteLength).getInt32(8, true);
  return storedDimension === dimension;
}

/** Optional color metadata must never prevent terrain rendering if it is malformed. */
export function readBedColors(
  bytes: Uint8Array | undefined,
  chunkX: number,
  chunkZ: number,
  minY: number,
  maxY: number,
): BedColors {
  const colors = new Map<number, Map<number, number>>();
  if (bytes === undefined) return colors;
  let offset = 0;
  while (offset < bytes.length) {
    let entry;
    try {
      entry = readLittleEndianNbtCompound(bytes, offset);
    } catch {
      break;
    }
    offset = entry.nextOffset;
    const { id, x, y, z, color } = entry.value;
    if (
      id !== "Bed" ||
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof z !== "number" ||
      typeof color !== "number"
    )
      continue;
    if (![x, y, z, color].every(Number.isSafeInteger) || color < 0 || color > 15) continue;
    if (Math.floor(x / 16) !== chunkX || Math.floor(z / 16) !== chunkZ || y < minY || y >= maxY)
      continue;
    const sectionY = Math.floor(y / 16);
    let section = colors.get(sectionY);
    if (section === undefined) {
      section = new Map();
      colors.set(sectionY, section);
    }
    section.set(((x & 15) << 8) | ((z & 15) << 4) | (y & 15), color);
  }
  return colors;
}
