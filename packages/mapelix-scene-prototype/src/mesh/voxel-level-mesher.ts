import {
  EMPTY_HEIGHT,
  Face,
  QuadList,
  QuadMaterial,
  QUAD_LAVA_FLAG,
  SOIL_COLOR,
  packQuadWord0,
  packQuadWord1,
  packQuadWord2,
  partitionLavaQuads,
  finishBlockLight,
  type SceneRegion,
} from "../format.js";
import { VoxelKind } from "./block-palette.js";
import type { GeometryMode } from "../dimensions.js";
import {
  CAVE_SKY_DEPTH,
  COVER_DEPTH,
  KEY_COVERED,
  KEY_LAVA,
  KEY_BLOCK_LIGHT_SHIFT,
  NORMAL_LAYER,
  cornerOcclusion,
  faceOf,
  faceSteps,
  findOpenAir,
  isFlatFace,
  keyBox,
  keyMaterial,
  maskOffset,
  maskSlice,
  mergeKey,
  mergeSlice,
  slicePosition,
  sliceLayout,
  type FaceSteps,
} from "./voxel-faces.js";
import { isOpaqueKind, type VoxelBox } from "./voxel-box.js";
import type { VoxelRegion } from "./voxel-region.js";
import { lavaFlowDirection } from "./lava-flow.js";
import { buildBlockLight } from "./block-light.js";
import { cornerLight } from "./smooth-light.js";

/**
 * Border faces stay when a neighbor hides them this many layers below its top. A
 * neighbor drawn at another level can sit lower, and these skirts close the gap.
 */
const SKIRT_LAYERS = 2;
/**
 * Walls facing unexplored land reach this many blocks below a column's highest block,
 * under any water, like the cut edge of a diorama.
 */
const EDGE_DEPTH = 16;

const MATERIALS: Readonly<Record<number, QuadMaterial>> = {
  [VoxelKind.Solid]: QuadMaterial.Solid,
  [VoxelKind.Foliage]: QuadMaterial.Foliage,
  [VoxelKind.Emissive]: QuadMaterial.Emissive,
  [VoxelKind.Water]: QuadMaterial.Water,
  [VoxelKind.Glass]: QuadMaterial.Glass,
  [VoxelKind.Lava]: QuadMaterial.Emissive,
};

/**
 * Turns a voxel region into packed quads, in voxel units. Surface mode retains the
 * sky visibility optimization; dimension modes keep interior and island surfaces.
 */
export function meshVoxelRegion(
  region: VoxelRegion,
  geometry: GeometryMode = "surface",
): SceneRegion {
  return new VoxelLevelMesher(region, geometry).mesh();
}

class VoxelLevelMesher {
  private readonly geometry: GeometryMode;
  private readonly region: VoxelRegion;
  private readonly box: VoxelBox;
  private readonly steps: FaceSteps;
  private readonly area: number;
  /** Layer of the highest opaque voxel in each box column, or -1. */
  private readonly roof: Int16Array;
  /** Layer of the highest voxel of any kind in each box column, or -1. */
  private readonly top: Int16Array;
  /** Lowest open layer of each box column. */
  private readonly lowestOpen: Int16Array;
  private readonly reached: Uint8Array;
  /**
   * Cave slices of surface dimensions: the sky roof layer of each box column. Air above it,
   * or reached from it in `reached`, is open sky and shows nothing.
   */
  private readonly caveRoof: Int16Array | undefined;
  /** Cave slices: highest layer per region column that owns a visible face, for `heights`. */
  private readonly visibleTop: Int16Array;
  /** Lowest layer per region column that can own a visible face. */
  private readonly columnLow: Int16Array;
  /** Layers of wall below a column's highest block where it faces unexplored land. */
  private readonly edgeLayers: number;
  private readonly opaque: QuadList;
  private readonly translucent: QuadList;
  private readonly light: Uint8Array | undefined;
  private maskLight: Uint32Array | undefined;
  private readonly readLight = (index: number, layer: number) =>
    layer < 0 || layer >= this.box.layers ? 0 : (this.light?.[index] ?? 0);
  private readonly lightOpaque = (index: number, layer: number) =>
    layer >= 0 && layer < this.box.layers && this.box.lightOpaque?.[index] === 1;
  /** World y of layer 0, in voxels. */
  private readonly baseLayer: number;
  private low = Number.POSITIVE_INFINITY;
  private high = -1;
  private minLayer = Number.POSITIVE_INFINITY;
  private maxLayer = Number.NEGATIVE_INFINITY;

  constructor(region: VoxelRegion, geometry: GeometryMode) {
    this.geometry = geometry;
    this.region = region;
    this.box = region.box;
    this.steps = faceSteps(region.box.width);
    this.area = region.box.width ** 2;
    this.opaque = new QuadList(false, region.blockLightSmooth === true);
    this.translucent = new QuadList(false, region.blockLightSmooth === true);
    this.baseLayer = region.low / region.voxelSize;
    this.edgeLayers = Math.max(1, EDGE_DEPTH / region.voxelSize);
    this.roof = new Int16Array(this.area).fill(-1);
    this.top = new Int16Array(this.area).fill(-1);
    this.findColumnTops();
    this.visibleTop = new Int16Array(region.span * region.span).fill(-1);
    this.caveRoof =
      geometry !== "surface" && region.window !== undefined && region.skyRoof !== undefined
        ? this.caveRoofs(region.skyRoof)
        : undefined;
    const isOpaque = (index: number) => isOpaqueKind(this.box.kind[index]!);
    const open =
      geometry === "surface"
        ? findOpenAir(
            { size: this.box.width, layers: this.box.layers, roof: this.roof, isOpaque },
            Math.ceil(COVER_DEPTH / region.voxelSize),
          )
        : this.caveRoof !== undefined
          ? {
              reached: findOpenAir(
                {
                  size: this.box.width,
                  layers: this.box.layers,
                  roof: this.caveRoof,
                  isOpaque,
                },
                Math.ceil(CAVE_SKY_DEPTH / region.voxelSize),
                false,
              ).reached,
              lowest: new Int16Array(this.area),
            }
          : { reached: new Uint8Array(0), lowest: new Int16Array(this.area) };
    this.reached = open.reached;
    this.lowestOpen = open.lowest;
    this.columnLow = this.findColumnRanges();
    this.light =
      region.level !== 1 || this.box.emission === undefined || this.high < this.low
        ? undefined
        : buildBlockLight({
            width: this.box.width,
            layers: this.box.layers,
            minLayer: this.low - 15,
            maxLayer: this.high + 16,
            emission: (index) => this.box.emission![index]! & 15,
            color: region.blockLightColors
              ? (index) => this.box.emission![index]! >>> 4
              : undefined,
            opaque: (index) => this.box.lightOpaque![index] === 1,
          });
  }

  mesh(): SceneRegion {
    if (this.high >= this.low) {
      for (let face = 0; face < 6; face += 1) this.meshFace(face);
    }
    const { voxelSize } = this.region;
    const empty = new Uint32Array(0);
    const blockLight = finishBlockLight(
      this.opaque,
      new QuadList(false, this.region.blockLightSmooth === true),
      this.translucent,
    );
    return {
      level: this.region.level,
      x: this.region.x,
      z: this.region.z,
      heights: this.heights(),
      minY: Number.isFinite(this.minLayer) ? this.minLayer * voxelSize : 0,
      maxY: Number.isFinite(this.maxLayer) ? this.maxLayer * voxelSize : 0,
      opaque: partitionLavaQuads(this.opaque.finish(), undefined, blockLight?.opaque),
      plants: empty,
      translucent: this.translucent.finish(),
      ...(blockLight === undefined ? {} : { blockLight }),
      ...(blockLight !== undefined && this.region.blockLightSmooth
        ? { blockLightSmooth: true }
        : {}),
      ...(blockLight !== undefined && this.region.blockLightColors
        ? { blockLightColors: true }
        : {}),
    };
  }

  /** Sky roof layers; columns outside stored chunks count as covered, so they never open. */
  private caveRoofs(skyRoof: Int16Array): Int16Array {
    const { voxelSize, low, explored } = this.region;
    const layers = this.box.layers;
    return Int16Array.from(skyRoof, (y, column) =>
      explored[column] === 1
        ? Math.max(-1, Math.min(layers, Math.floor((y - low) / voxelSize)))
        : layers,
    );
  }

  private findColumnTops(): void {
    const { box, area } = this;
    for (let column = 0; column < area; column += 1) {
      for (let layer = box.layers - 1; layer >= 0; layer -= 1) {
        const kind = box.kind[layer * area + column]!;
        if (kind === VoxelKind.Air) continue;
        if (this.top[column] === -1) this.top[column] = layer;
        if (isOpaqueKind(kind)) {
          this.roof[column] = layer;
          break;
        }
      }
    }
  }

  /** As at level 0, the lowest open voxel around a column bounds the voxels worth testing. */
  private findColumnRanges(): Int16Array {
    const { span, margin } = this.region;
    const width = this.box.width;
    const columnLow = new Int16Array(span * span);
    for (let z = 0; z < span; z += 1) {
      for (let x = 0; x < span; x += 1) {
        const column = (z + margin) * width + x + margin;
        const top = this.columnTop(column);
        let low = this.edgeFloor(column);
        for (const neighbor of [column, column + 1, column - 1, column + width, column - width]) {
          if (this.region.explored[neighbor] === 1) {
            low = Math.min(low, this.lowestOpen[neighbor]! - 1);
          }
        }
        low = Math.max(
          0,
          low,
          this.region.window === undefined
            ? 0
            : (this.region.window.minY - this.region.low) / this.region.voxelSize,
        );
        columnLow[z * span + x] = low;
        if (top === -1) continue;
        this.low = Math.min(this.low, low);
        this.high = Math.max(this.high, top);
      }
    }
    return columnLow;
  }

  private meshFace(face: number): void {
    const { span, margin } = this.region;
    const width = this.box.width;
    const layout = sliceLayout(face, span, this.high - this.low + 1);
    const keys = new Uint32Array(layout.slices * layout.area);
    const colors = new Uint32Array(layout.slices * layout.area);
    this.maskLight =
      this.region.blockLightSmooth && this.light !== undefined
        ? new Uint32Array(keys.length)
        : undefined;
    const used = new Uint8Array(layout.slices);

    for (let z = 0; z < span; z += 1) {
      for (let x = 0; x < span; x += 1) {
        const column = (z + margin) * width + x + margin;
        const border = isBorderFace(face, x, z, span);
        const top = this.columnTop(column);
        for (let layer = this.columnLow[z * span + x]!; layer <= top; layer += 1) {
          const slice = maskSlice(face, x, layer - this.low, z);
          const mask = slice * layout.area + maskOffset(face, span, x, layer - this.low, z);
          const index = layer * this.area + column;
          if (this.writeFace(face, index, layer, column, border, keys, colors, mask)) {
            used[slice] = 1;
            const cell = z * span + x;
            if (layer > this.visibleTop[cell]!) this.visibleTop[cell] = layer;
          }
        }
      }
    }

    for (let slice = 0; slice < layout.slices; slice += 1) {
      if (used[slice] === 0) continue;
      const start = slice * layout.area;
      mergeSlice(
        face,
        keys.subarray(start, start + layout.area),
        colors.subarray(start, start + layout.area),
        layout,
        (key, color, u, v, width, height, _texture, light) => {
          this.emit(key, color, face, slice, u, v, width, height, light);
        },
        undefined,
        this.maskLight?.subarray(start, start + layout.area),
      );
    }
  }

  /**
   * Writes the merge key and packed color of one face into a slice mask.
   * Returns false, and writes nothing, when the face is hidden.
   */
  private writeFace(
    face: number,
    index: number,
    layer: number,
    column: number,
    border: boolean,
    keys: Uint32Array,
    colors: Uint32Array,
    mask: number,
  ): boolean {
    const { box } = this;
    const kind = box.kind[index]!;
    if (kind === VoxelKind.Air) return false;
    const fill = box.fill[index]!;
    // A water surface below the top of its voxel shows when the sky reaches the voxel,
    // unless a block sits right on it.
    const inner = face === Face.PositiveY && fill < 16;
    const neighbor = index + this.steps.normal[face]!;
    const neighborLayer = layer + NORMAL_LAYER[face]!;
    const neighborColumn = column + this.steps.column[face]!;
    if (inner) {
      const open =
        kind === VoxelKind.Lava
          ? this.isOpen(neighbor, neighborLayer, neighborColumn)
          : this.isOpen(index, layer, column);
      if (isOpaqueKind(box.kind[neighbor] ?? VoxelKind.Air) || !open) {
        return false;
      }
    } else if (!this.region.explored[neighborColumn]) {
      // Cave slices draw no walls toward land that was never generated.
      if (this.region.window !== undefined || layer < this.edgeFloor(column)) return false;
    } else if (!this.showsFace(kind, neighbor, neighborLayer, neighborColumn, border)) {
      return false;
    }

    const occlusion = inner
      ? this.occlusion(face, index, layer)
      : this.occlusion(face, neighbor, neighborLayer);
    const covered = box.covered[index] === 1 && !isFlatFace(face);
    const key = mergeKey(MATERIALS[kind]!, fill, 0, false, face);
    let lava = 0;
    if (kind === VoxelKind.Lava) {
      const heightAt = (step: number) => {
        const other = index + step;
        return box.kind[other] === VoxelKind.Lava
          ? box.fill[other]!
          : isOpaqueKind(box.kind[other] ?? VoxelKind.Air)
            ? fill
            : 0;
      };
      lava =
        KEY_LAVA |
        (lavaFlowDirection(heightAt(1), heightAt(-1), heightAt(box.width), heightAt(-box.width)) <<
          12);
    }
    const frontLayer = inner ? layer : neighborLayer;
    // Glow and procedural lava ignore local fill, but still emit into the shared light field.
    const light =
      MATERIALS[kind] === QuadMaterial.Emissive || frontLayer < 0 || frontLayer >= this.box.layers
        ? 0
        : (this.light?.[inner ? index : neighbor] ?? 0);
    keys[mask] =
      ((covered ? key | KEY_COVERED : key) |
        lava |
        ((this.maskLight === undefined ? light : 0) << KEY_BLOCK_LIGHT_SHIFT)) >>>
      0;
    if (this.maskLight !== undefined)
      this.maskLight[mask] =
        MATERIALS[kind] === QuadMaterial.Emissive
          ? 0
          : cornerLight(
              this.steps,
              face,
              inner ? index : neighbor,
              frontLayer,
              this.readLight,
              this.lightOpaque,
            );
    colors[mask] = packQuadWord2(this.faceColor(index, face), occlusion);
    return true;
  }

  /** Whether a face of a `kind` voxel shows against the voxel in front of it. */
  private showsFace(
    kind: number,
    neighbor: number,
    neighborLayer: number,
    neighborColumn: number,
    border: boolean,
  ): boolean {
    // Below the box is buried rock; above it is open sky, or a cave under a higher roof.
    if (neighborLayer < 0) return this.geometry === "islands";
    if (neighborLayer >= this.box.layers)
      return this.caveRoof === undefined || neighborLayer <= this.caveRoof[neighborColumn]!;
    const neighborKind = this.box.kind[neighbor]!;
    if (isOpaqueKind(neighborKind)) {
      return (
        this.region.window === undefined &&
        border &&
        isOpaqueKind(kind) &&
        neighborLayer > this.roof[neighborColumn]! - SKIRT_LAYERS
      );
    }
    if (neighborKind !== VoxelKind.Air && neighborKind === kind) return false;
    return this.isOpen(neighbor, neighborLayer, neighborColumn);
  }

  private faceColor(index: number, face: number): number {
    if (face === Face.PositiveY) return this.box.top[index]!;
    if (face === Face.NegativeY && this.box.covered[index] === 1) return SOIL_COLOR;
    return this.box.side[index]!;
  }

  private emit(
    key: number,
    color: number,
    face: number,
    slice: number,
    u: number,
    v: number,
    width: number,
    height: number,
    light?: number,
  ): void {
    const [x, layer, z] = slicePosition(face, slice, u, v, this.low);
    const material = keyMaterial(key);
    const y = this.baseLayer + layer;
    const translucent = material === QuadMaterial.Water || material === QuadMaterial.Glass;
    (translucent ? this.translucent : this.opaque).push(
      packQuadWord0(x, y, z, faceOf(face), material, (key & KEY_COVERED) !== 0),
      packQuadWord1(width, height, keyBox(key), 0) |
        ((key & KEY_LAVA) !== 0 ? QUAD_LAVA_FLAG | (((key >>> 12) & 15) << 28) : 0),
      color,
      0,
      light ?? (key >>> KEY_BLOCK_LIGHT_SHIFT) & 255,
    );
    this.minLayer = Math.min(this.minLayer, y);
    this.maxLayer = Math.max(this.maxLayer, y + (isFlatFace(face) ? 1 : height));
  }

  /** Top of the highest voxel in each region column, in blocks. */
  private heights(): Int16Array {
    const { span, margin, voxelSize } = this.region;
    const width = this.box.width;
    const heights = new Int16Array(span * span);
    for (let z = 0; z < span; z += 1) {
      for (let x = 0; x < span; x += 1) {
        const top =
          this.region.window === undefined
            ? this.columnTop((z + margin) * width + x + margin)
            : this.visibleTop[z * span + x]!;
        heights[z * span + x] = top === -1 ? EMPTY_HEIGHT : (this.baseLayer + top + 1) * voxelSize;
      }
    }
    return heights;
  }

  private occlusion(face: number, front: number, frontLayer: number): number {
    return cornerOcclusion(
      this.steps,
      face,
      front,
      frontLayer,
      (index, layer) =>
        layer >= 0 && layer < this.box.layers && isOpaqueKind(this.box.kind[index]!),
    );
  }

  private columnTop(column: number): number {
    return Math.min(
      this.top[column]!,
      this.region.window === undefined
        ? this.box.layers - 1
        : (this.region.window.maxY - this.region.low) / this.region.voxelSize - 1,
    );
  }

  /** Lowest layer of the walls facing unexplored land. Over water, the walls reach below the floor. */
  private edgeFloor(column: number): number {
    if (this.geometry !== "surface") return 0;
    const roof = this.roof[column]!;
    return (roof === -1 ? this.top[column]! : roof) - this.edgeLayers;
  }

  /**
   * A voxel is open when the sky reaches it directly or through covered air. In cave slices it
   * is the other way round: open voxels are the air the sky does not reach, in stored chunks.
   */
  private isOpen(index: number, layer: number, column: number): boolean {
    if (this.region.window !== undefined) {
      if (this.region.explored[column] !== 1) return false;
      return (
        this.caveRoof === undefined ||
        (layer <= this.caveRoof[column]! && this.reached[index] !== 1)
      );
    }
    return this.geometry !== "surface" || layer > this.roof[column]! || this.reached[index] === 1;
  }
}

/** Faces that point out of the region, onto a neighbor that may be drawn at another level. */
function isBorderFace(face: number, x: number, z: number, span: number): boolean {
  switch (face) {
    case Face.PositiveX:
      return x === span - 1;
    case Face.NegativeX:
      return x === 0;
    case Face.PositiveZ:
      return z === span - 1;
    case Face.NegativeZ:
      return z === 0;
    default:
      return false;
  }
}
