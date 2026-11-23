import {
  Fn,
  If,
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cos,
  dFdx,
  dFdy,
  float,
  fract,
  ivec2,
  max,
  mix,
  modelScale,
  normalWorldGeometry,
  normalize,
  positionWorld,
  select,
  sin,
  smoothstep,
  step,
  texture,
  textureLoad,
  time,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { Vector2, type Node } from "three/webgpu";

import type { BlockAtlas, PbrAtlas, PbrLayer } from "../block-atlas";
import { quadColor, quadPackedData, quadPosition, quadSprite, quadUV } from "./quad";

/**
 * Block textures for textured regions. Each quad carries a fourth word (see
 * `QUAD_TEXTURED` in `@mapelix/scene-prototype/texture-format`): its atlas tile, quarter
 * turns, and whether the texture takes the quad's biome color. Pixels show the texture where a
 * block is large on screen and the flat color below, with a smooth blend in between measured
 * in screen pixels per block, so perspective and isometric views fade at the same block size.
 */

/**
 * The quad's texture word, 19 bits, shares a flat integer with four light bits: plain terrain uses
 * all 16 varyings WebGPU allows, and the textured terrain and plants never read lava flow (lava
 * keeps its plain material). No interpolation can change these per-face flags.
 */
const textureWord = quadPackedData;

const bit = (word: Node<"uint">, shift: number, mask: number) =>
  float(word.shiftRight(uint(shift)).bitAnd(uint(mask)));

/**
 * The offset of a face drawn from a sheet of parts, as for lanterns and candles: its byte
 * (bits 19 to 26 of the texture word) rides in the plant sprite varying, which only crossed
 * plant quads read. A float holds it exactly; rounding removes interpolation error.
 */
const textureOffset = quadSprite;

/** `quadPosition`, with the quad's texture word for the fragment stage. */
export const texturedQuadPosition = Fn(() => {
  // A variable, so `quadPosition` and its own lava flow and sprite assignments come first.
  const position = quadPosition().toVar();
  const texture = uint(attribute("texture", "uint"));
  textureWord.assign(
    texture.bitAnd(uint(0x0007ffff)).bitOr(quadPackedData.bitAnd(uint(0x7f800000))),
  );
  If(bit(uint(attribute("quad", "uvec3").x), 23, 7).lessThan(6), () => {
    textureOffset.assign(bit(texture, 19, 0xff));
  });
  return position;
});

const word = textureWord;
const textureTile = bit(word, 0, 0x3fff);
const textureTurn = bit(word, 14, 3);
const textureTint = bit(word, 16, 1);
const textured = bit(word, 17, 1);
const cutoutQuad = bit(word, 18, 1);
const offset = uint(textureOffset.round());
const offsetAcross = bit(offset, 0, 15);
const offsetDown = bit(offset, 4, 15);

/** Screen sizes, in CSS pixels per block, where textures start to show and are complete. */
export interface TextureFade {
  readonly none: number;
  readonly full: number;
}

/** Brightness of the fill behind the transparent texels of leaves and other cut-out tiles. */
const LEAF_SHADE = 0.5;

export const DEFAULT_TEXTURE_FADE: TextureFade = { none: 4, full: 8 };

/** What sampling needs of the color atlas or a PBR layer. */
type AtlasLayer = Pick<PbrLayer, "image" | "tileSize" | "gutter" | "cellSize" | "width" | "height">;

export class TextureLook {
  readonly atlas: BlockAtlas;
  /** The normal and material atlases, when PBR is on and the stack has texture sets. */
  readonly pbr: PbrAtlas | undefined;
  /** `none` and `full` of the fade, in CSS pixels per block. */
  readonly fade = uniform(new Vector2(DEFAULT_TEXTURE_FADE.none, DEFAULT_TEXTURE_FADE.full));
  /** Height of the view in CSS pixels. */
  readonly viewHeight = uniform(1);

  constructor(atlas: BlockAtlas, pbr?: PbrAtlas) {
    this.atlas = atlas;
    this.pbr = pbr;
  }

  setFade(fade: TextureFade): void {
    this.fade.value.set(fade.none, fade.full);
  }

  /**
   * CSS pixels covered by one block at this pixel, from the projection itself: the same
   * measure in perspective, isometric and the blend between them.
   */
  private pixelsPerBlock(): Node<"float"> {
    // From the world position, already passed to the fragment stage: `positionView` would take
    // one more varying than WebGPU allows here.
    const clip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(positionWorld, 1)));
    // The vertical scale of the projection, its second column's second row. Matrix nodes index
    // columns at run time; their typings leave `element` out.
    const projection = cameraProjectionMatrix as unknown as {
      element(index: number): Node<"vec4">;
    };
    const scale = projection.element(1).y;
    return this.viewHeight.mul(0.5).mul(scale).div(max(clip.w, 1e-4)).mul(modelScale.x);
  }

  /** How much of the texture shows, 0 to 1. Quads without a texture keep their color. */
  amount(): Node<"float"> {
    return smoothstep(this.fade.x, this.fade.y, this.pixelsPerBlock()).mul(textured);
  }

  /**
   * Samples the quad's tile at continuous texture coordinates in blocks. The fraction picks the
   * texel; the gradients come from the continuous coordinates, so mipmaps never jump where a
   * coordinate wraps. Animated tiles step through the frames that follow them.
   */
  private cellOf(tile: Node<"float">): Node<"vec2"> {
    const columns = float(this.atlas.columns);
    return vec2(tile.mod(columns), tile.div(columns).floor());
  }

  /** The quad's tile entry: frames (low, high byte), ticks per frame, overlay; 0 to 255. */
  private tileInfo(): Node<"vec4"> {
    return textureLoad(this.atlas.animation, ivec2(this.cellOf(textureTile))).mul(255);
  }

  private sample(coords: Node<"vec2">): Node<"vec4"> {
    return this.sampleLayer(this.atlas, coords);
  }

  /** Samples the quad's tile in the color atlas or a PBR layer, which share cells and tiles. */
  private sampleLayer(layer: AtlasLayer, coords: Node<"vec2">): Node<"vec4"> {
    const info = this.tileInfo();
    const frames = max(info.x.add(info.y.mul(256)), 1);
    const ticks = max(info.z, 1);
    const frame = time.mul(20).div(ticks).floor().mod(frames);
    const cell = this.cellOf(textureTile.add(frame));
    const size = vec2(layer.width, layer.height);
    const texel = cell.mul(layer.cellSize).add(layer.gutter).add(fract(coords).mul(layer.tileSize));
    const scale = vec2(layer.tileSize, layer.tileSize).div(size);
    return texture(layer.image, texel.div(size)).grad(
      dFdx(coords).mul(scale),
      dFdy(coords).mul(scale),
    );
  }

  private tint(): Node<"vec3"> {
    return select(textureTint.greaterThan(0.5), quadColor, vec3(1, 1, 1));
  }

  /**
   * A block face's texture at this pixel. Coordinates follow the game: sides read with the
   * texture's top up and its left on the left seen from outside, tops with north up.
   */
  private faceTexel(): Node<"vec4"> {
    return this.sample(this.faceCoords());
  }

  /** The face's texture coordinates in blocks, turned and moved as `faceTexel` reads them. */
  private faceCoords(): Node<"vec2"> {
    const p = positionWorld.div(modelScale.x);
    // The face's own normal: once a material has a normal map, `normalWorld` is the bent one
    // everywhere but in the normal itself, and would pick faces and coordinates per texel.
    const n = normalWorldGeometry;
    const coords = select(
      n.y.greaterThan(0.5),
      vec2(p.x, p.z),
      select(
        n.y.lessThan(-0.5),
        vec2(p.x, p.z.negate()),
        select(
          n.x.greaterThan(0.5),
          vec2(p.z.negate(), p.y.negate()),
          select(
            n.x.lessThan(-0.5),
            vec2(p.z, p.y.negate()),
            select(n.z.greaterThan(0.5), vec2(p.x, p.y.negate()), vec2(p.x.negate(), p.y.negate())),
          ),
        ),
      ),
    );
    // Quarter turns, for the sides of lying logs: (x, y) becomes (y, -x) per turn.
    const angle = textureTurn.mul(Math.PI / 2);
    const c = cos(angle).round();
    const s = sin(angle).round();
    const turned = vec2(coords.x.mul(c).add(coords.y.mul(s)), coords.y.mul(c).sub(coords.x.mul(s)));
    // Faces drawn from a sheet of parts move onto their rectangle, in sixteenths of a block.
    return turned.add(vec2(offsetAcross, offsetDown).div(16));
  }

  /**
   * The world directions in which the face's texture coordinates grow: across (`tangent`) and
   * down the texture (`bitangent`). Block faces are aligned with the axes, so both follow from
   * the face normal and the quarter turns, as `faceCoords` builds the coordinates: no tangent
   * attribute and no varying beyond those terrain already uses.
   */
  private faceBasis(): { tangent: Node<"vec3">; bitangent: Node<"vec3"> } {
    const n = normalWorldGeometry;
    const axis = (
      top: [number, number, number],
      bottom: [number, number, number],
      east: [number, number, number],
      west: [number, number, number],
      south: [number, number, number],
      north: [number, number, number],
    ): Node<"vec3"> =>
      select(
        n.y.greaterThan(0.5),
        vec3(...top),
        select(
          n.y.lessThan(-0.5),
          vec3(...bottom),
          select(
            n.x.greaterThan(0.5),
            vec3(...east),
            select(
              n.x.lessThan(-0.5),
              vec3(...west),
              select(n.z.greaterThan(0.5), vec3(...south), vec3(...north)),
            ),
          ),
        ),
      );
    const across = axis([1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0]);
    const down = axis([0, 0, 1], [0, 0, -1], [0, -1, 0], [0, -1, 0], [0, -1, 0], [0, -1, 0]);
    const angle = textureTurn.mul(Math.PI / 2);
    const c = cos(angle).round();
    const s = sin(angle).round();
    return {
      tangent: across.mul(c).add(down.mul(s)),
      bitangent: down.mul(c).sub(across.mul(s)),
    };
  }

  /**
   * The face normal bent by the normal atlas, in world space, blended in with the texture.
   * Normals are stored with red across the texture, green down it and blue out of the face.
   */
  pbrNormal(pbr: PbrAtlas): Node<"vec3"> {
    const stored = this.sampleLayer(pbr.normal, this.pbrCoords()).xyz.mul(2).sub(1);
    const { tangent, bitangent } = this.faceBasis();
    const bent = normalize(
      tangent.mul(stored.x).add(bitangent.mul(stored.y)).add(normalWorldGeometry.mul(stored.z)),
    );
    return normalize(mix(normalWorldGeometry, bent, this.amount()));
  }

  /** Metalness, emissive and roughness at this pixel, flat (0, 0, 1) where no texture shows. */
  pbrMaterial(pbr: PbrAtlas): Node<"vec3"> {
    const stored = this.sampleLayer(pbr.material, this.pbrCoords()).xyz;
    return mix(vec3(0, 0, 1), stored, this.amount());
  }

  private pbrCoordsNode: Node<"vec2"> | undefined;

  /** One coordinate node for both PBR layers, so the shader computes it once. */
  private pbrCoords(): Node<"vec2"> {
    this.pbrCoordsNode ??= this.faceCoords();
    return this.pbrCoordsNode;
  }

  /**
   * Blends a terrain color toward the face texture. Texels a pack leaves transparent, as in
   * leaves, show a dark shade of the quad's own color, the leaves' tint or their average
   * color, so a canopy stays opaque. Cut-out faces (see `cutoutMask`) lose those texels where
   * the texture shows, and blend from their plain color before.
   */
  terrain(plain: Node<"vec3">): Node<"vec3"> {
    const texel = this.faceTexel();
    const tint = this.tint();
    const fill = select(cutoutQuad.greaterThan(0.5), quadColor, quadColor.mul(LEAF_SHADE));
    const opaque = mix(fill, texel.rgb.mul(tint), step(0.5, texel.a));
    // An overlay tile's alpha marks the pixels that take the quad color: the grass strip of a
    // grass block side, whose quad color is the grass color.
    const overlay = mix(texel.rgb, texel.rgb.mul(quadColor), texel.a);
    const color = select(this.tileInfo().w.greaterThan(127), overlay, opaque);
    return mix(plain, color, this.amount());
  }

  /**
   * False at the transparent texels of cut-out faces where their texture shows: the ground
   * under leaf litter, the faces and sky behind detailed leaves. Below the fade they stay
   * filled, as the texture blends from a flat color.
   */
  cutoutMask(): Node<"bool"> {
    return this.amount()
      .greaterThan(0.5)
      .and(cutoutQuad.greaterThan(0.5))
      .and(this.faceTexel().a.lessThan(0.5))
      .not();
  }

  /** Plant sprites: the crossed quad shows the whole tile, top up. */
  private plantTexel(): Node<"vec4"> {
    return this.sample(vec2(quadUV.x, float(1).sub(quadUV.y)));
  }

  plant(plain: Node<"vec3">, shade: Node<"float">): Node<"vec3"> {
    return mix(plain, this.plantTexel().rgb.mul(this.tint()).mul(shade), this.amount());
  }

  /** The texture's own cutout where it shows, the procedural sprite elsewhere. */
  plantMask(procedural: Node<"bool">): Node<"bool"> {
    return select(
      this.amount().greaterThan(0.5),
      this.plantTexel().a.greaterThanEqual(0.5),
      procedural,
    );
  }
}
