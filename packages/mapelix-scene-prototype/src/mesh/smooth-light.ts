import { CORNERS, isFlatFace, type FaceSteps } from "./voxel-faces.js";

/** Four identical samples preserve cell lighting on small model parts and plants. */
export const repeatLight = (value: number): number => (value * 0x01010101) >>> 0;

/** Shared grid vertices use the same neighboring cells and stable family tie rule. */
export function cornerLight(
  steps: FaceSteps,
  face: number,
  front: number,
  layer: number,
  read: (index: number, layer: number) => number,
  opaque: (index: number, layer: number) => boolean,
): number {
  const u = steps.tangentU[face]!,
    v = steps.tangentV[face]!;
  let packed = 0;
  let sum = 0,
    count = 0,
    strongest = 0,
    family = 0;
  const add = (index: number, y: number) => {
    const sample = read(index, y),
      level = sample & 15,
      tint = sample >>> 4;
    sum += level;
    count++;
    if (level > strongest || (level === strongest && tint < family)) {
      strongest = level;
      family = tint;
    }
  };
  for (let corner = 0; corner < 4; corner++) {
    const [su, sv] = CORNERS[corner]!,
      sideLayer = layer + (isFlatFace(face) ? 0 : sv);
    const sideU = front + su * u,
      sideV = front + sv * v;
    const blockedU = opaque(sideU, layer),
      blockedV = opaque(sideV, sideLayer);
    sum = count = strongest = family = 0;
    add(front, layer);
    if (!blockedU) add(sideU, layer);
    if (!blockedV) add(sideV, sideLayer);
    const diagonal = front + su * u + sv * v;
    if (!(blockedU && blockedV) && !opaque(diagonal, sideLayer)) add(diagonal, sideLayer);
    const level = Math.round(sum / count);
    packed |= (level === 0 ? 0 : level | (family << 4)) << (corner * 8);
  }
  return packed >>> 0;
}
