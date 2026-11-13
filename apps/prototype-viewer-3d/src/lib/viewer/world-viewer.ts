import {
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  RenderPipeline,
  Scene,
  Timer,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { normalWorldGeometry, pass } from "three/tsl";
import { retainScreenUniforms } from "./shaders/stable-screen";
import { createStablePCFFilter } from "./shaders/shadow-filter";

import { Atmosphere } from "./atmosphere";
import { CameraRig, ZOOM_LIMIT, pointerRay, type CameraView } from "./camera-rig";
import { RegionStreamer, type StreamingStats } from "./region-streamer";
import { RegionMeshPool } from "./region-mesh";
import { createSceneMaterials, type SceneMaterials } from "./shaders/materials";
import {
  CAVE_LIMITS,
  DIMENSIONS,
  sceneContext,
  type SceneContext,
  type SceneContextInput,
} from "@mapelix/scene-prototype/dimensions";

export interface WorldInfo extends SceneContextInput {
  readonly name: string;
  readonly spawn: { readonly x: number; readonly y: number; readonly z: number };
  readonly revision: string;
}

export type { CameraView } from "./camera-rig";

/** Kept across view switches so embedding does not fall back to a different server. */
export interface WorldViewerOptions {
  readonly regionBase?: string;
  readonly regionSuffix?: string;
  readonly caveViewDistance?: number;
  readonly caveMemoryBudget?: number;
}

export interface ViewerSnapshot {
  readonly backend: "WebGPU" | "WebGL 2";
  readonly framesPerSecond: number;
  readonly view: CameraView;
  readonly streaming: StreamingStats;
  readonly context: SceneContext;
}

export interface Pointed {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const SHADOW_MAP_SIZE = 4096;
/** Half the width of the sun's shadow map when zoomed far out, in blocks. */
const MAX_SHADOW_EXTENT = 2048;
const MAX_PIXEL_RATIO = 1.75;
/** Farthest the view grows on its own as the camera zooms out, in blocks. */
const AUTO_VIEW_LIMIT = 32_768;

/**
 * The 3D world view: renderer, lights, atmosphere, streaming, and camera. It
 * redraws continuously for water and plants, but refreshes the sun's shadow map
 * only when the view, the sun, or the loaded terrain changes.
 */
export class WorldViewer {
  private readonly container: HTMLElement;
  private readonly renderer: WebGPURenderer;
  private readonly pipeline: RenderPipeline;
  private readonly glow: ReturnType<typeof bloom>;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(50, 1, 1, 12000);
  private readonly atmosphere = new Atmosphere();
  private readonly sun = new DirectionalLight(0xffffff, 3);
  private readonly sky = new HemisphereLight(0xb9d3ec, 0x8a7a62, 1.4);
  private streamer: RegionStreamer;
  private readonly materials: SceneMaterials;
  private readonly meshPool = new RegionMeshPool();
  private readonly options: WorldViewerOptions;
  private context: SceneContext;
  private hour = 15.5;
  private readonly rig: CameraRig;
  private readonly timer = new Timer();
  private readonly resizeObserver: ResizeObserver;
  private readonly sunDirection = new Vector3(0.4, 0.7, 0.3);
  private shadowKey = "";
  private regionsChanged = true;
  /** A fixed render distance in blocks, or undefined to follow the zoom. */
  private renderDistance: number | undefined;
  private frames = 0;
  private frameWindowStart = performance.now();
  private framesPerSecond = 0;

  private constructor(
    container: HTMLElement,
    world: WorldInfo,
    renderer: WebGPURenderer,
    start: Partial<CameraView>,
    options: WorldViewerOptions,
  ) {
    this.container = container;
    this.context = sceneContext(world.dimension, world);
    this.options = options;
    this.atmosphere.setDimension(world.dimension);
    this.atmosphere.setCaves(this.context.mode === "caves");
    this.renderer = renderer;
    container.append(renderer.domElement);

    retainScreenUniforms();
    this.materials = createSceneMaterials(this.atmosphere);
    this.streamer = this.createStreamer(world);
    this.scene.add(this.streamer.root, this.sky, this.sun, this.sun.target);
    this.scene.backgroundNode = this.atmosphere.sky(normalWorldGeometry);
    this.scene.fogNode = this.atmosphere.fogNode;

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.sun.shadow.autoUpdate = false;
    // Public WebGPU LightShadow hook omitted by Three's shared shadow typings.
    Object.assign(this.sun.shadow, { filterNode: createStablePCFFilter(this.sun.shadow) });

    this.rig = new CameraRig(this.camera, renderer.domElement, {
      heightAt: (x, z) =>
        this.context.mode === "caves" ? undefined : this.streamer.heightAt(x, z),
      raycast: (origin, direction, far, radius) =>
        this.streamer.raycast(origin, direction, far, radius),
    });
    this.rig.setVerticalWindow(this.context.mode === "caves" ? this.context : undefined);
    this.rig.setView(
      {
        x: world.spawn.x,
        y:
          this.context.mode === "caves"
            ? (this.context.minY + this.context.maxY) / 2
            : world.spawn.y,
        z: world.spawn.z,
        distance: this.context.mode === "caves" || world.dimension === "nether" ? 80 : 160,
        heading: MathUtils.degToRad(35),
        pitch: MathUtils.degToRad(42),
        ...start,
      },
      { settle: this.context.mode !== "caves" && start.y === undefined },
    );

    // Only very bright light blooms: the sun, glints on water, and lamps after dark.
    const color = pass(this.scene, this.camera, { samples: 4 }).getTextureNode("output");
    this.glow = bloom(color, 0.5, 0.45, 1.4);
    this.pipeline = new RenderPipeline(renderer);
    this.pipeline.outputNode = color.add(this.glow);
    this.setTimeOfDay(15.5);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.timer.connect(document);
    renderer.setAnimationLoop(() => this.frame());
  }

  static async create(
    container: HTMLElement,
    world: WorldInfo,
    start: Partial<CameraView> = {},
    options: WorldViewerOptions = {},
  ): Promise<WorldViewer> {
    for (const value of [options.caveViewDistance, options.caveMemoryBudget]) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0))
        throw new RangeError("Cave budgets must be positive");
    }
    const renderer = new WebGPURenderer({
      antialias: false,
      powerPreference: "high-performance",
      reversedDepthBuffer: false,
    });
    await renderer.init();
    renderer.toneMapping = NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    return new WorldViewer(container, world, renderer, start, options);
  }

  get backend(): ViewerSnapshot["backend"] {
    return "isWebGPUBackend" in this.renderer.backend ? "WebGPU" : "WebGL 2";
  }

  snapshot(): ViewerSnapshot {
    const focus = this.rig.focus;
    return {
      backend: this.backend,
      framesPerSecond: this.framesPerSecond,
      view: {
        x: focus.x,
        y: focus.y,
        z: focus.z,
        distance: this.rig.distance,
        heading: this.rig.heading,
        pitch: this.rig.pitch,
      },
      streaming: this.streamer.stats,
      context: this.context,
    };
  }

  /** Hour of the day from 0 to 24. Noon is 12. */
  setTimeOfDay(hour: number): void {
    this.hour = hour;
    const daylight = this.atmosphere.setTimeOfDay(hour);
    this.sun.color.copy(daylight.sunColor);
    this.sun.intensity = daylight.sunIntensity;
    this.sky.color.copy(daylight.skyColor);
    this.sky.groundColor.copy(daylight.groundColor);
    this.sky.intensity = daylight.ambientIntensity * 3.1;
    this.sunDirection.copy(daylight.direction);
    this.glow.strength.value = MathUtils.lerp(0.9, 0.45, daylight.daylight);
    this.shadowKey = "";
  }

  /** Replaces all terrain together while retaining the renderer, materials and controls. */
  setWorld(world: WorldInfo, keepView = false): void {
    const previous = this.snapshot().view;
    this.scene.remove(this.streamer.root);
    this.streamer.dispose();
    this.context = sceneContext(world.dimension, world);
    this.streamer = this.createStreamer(world);
    this.scene.add(this.streamer.root);
    this.atmosphere.setDimension(world.dimension);
    this.atmosphere.setCaves(this.context.mode === "caves");
    this.setTimeOfDay(this.hour);
    this.rig.setVerticalWindow(this.context.mode === "caves" ? this.context : undefined);
    this.rig.setView(
      {
        ...previous,
        ...(keepView ? {} : { ...world.spawn, distance: world.dimension === "nether" ? 80 : 160 }),
        ...(this.context.mode === "caves"
          ? {
              y: (this.context.minY + this.context.maxY) / 2,
              distance: Math.min(previous.distance, 80),
            }
          : {}),
      },
      { settle: this.context.mode !== "caves" },
    );
    this.regionsChanged = true;
    this.fitViewDistance();
  }

  private createStreamer(world: WorldInfo): RegionStreamer {
    const caves = this.context.mode === "caves";
    return new RegionStreamer({
      context: this.context,
      revision: world.revision,
      ...(this.options.regionBase === undefined ? {} : { regionBase: this.options.regionBase }),
      ...(this.options.regionSuffix === undefined
        ? {}
        : { regionSuffix: this.options.regionSuffix }),
      meshPool: this.meshPool,
      materials: this.materials,
      voxelPixels: 2.2,
      blockPixels: 4.4,
      viewDistance: caves
        ? (this.options.caveViewDistance ?? CAVE_LIMITS.viewDistance)
        : this.atmosphere.viewDistance.value,
      maxRequests: caves ? 2 : 10,
      memoryBudget: caves
        ? (this.options.caveMemoryBudget ?? CAVE_LIMITS.memoryBudget)
        : 1024 * 1024 * 1024,
      onRegion: () => {
        this.regionsChanged = true;
      },
    });
  }

  /** Fades terrain into the sky before the edge of the loaded area, or lets the edge show. */
  setEdgeFade(enabled: boolean): void {
    this.atmosphere.edgeFade.value = enabled ? 1 : 0;
  }

  /**
   * Streams terrain out to `distance` blocks at any zoom, or picks the distance from the
   * zoom when undefined. The haze keeps its thickness either way.
   */
  setRenderDistance(distance: number | undefined): void {
    this.renderDistance = distance;
    this.fitViewDistance();
    this.regionsChanged = true;
  }

  /** Lets the camera zoom out far past the usual limit, with the view growing to match. */
  setZoomUnlocked(unlocked: boolean): void {
    this.rig.setZoomUnlocked(unlocked);
  }

  flyTo(x: number, z: number): void {
    this.rig.flyTo(x, z);
  }

  zoom(factor: number): void {
    this.rig.zoom(factor);
  }

  faceNorth(): void {
    this.rig.faceNorth();
  }

  /** The block under a canvas position: the first loaded surface along the pointer ray. */
  pick(clientX: number, clientY: number): Pointed | undefined {
    const ray = pointerRay(this.camera, this.renderer.domElement, clientX, clientY);
    const hit = this.streamer.raycast(ray.origin, ray.direction, this.camera.far);
    if (hit === undefined) return undefined;
    // Half a block behind the face lies the block it belongs to.
    const point = ray.at(hit.distance, new Vector3());
    point.setComponent(hit.axis, point.getComponent(hit.axis) - hit.sign * 0.5);
    return { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) };
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.rig.dispose();
    this.streamer.dispose();
    this.meshPool.dispose();
    this.pipeline.dispose();
    for (const pair of Object.values(this.materials)) {
      pair.steady.dispose();
      pair.fading.dispose();
    }
    this.sun.shadow.dispose();
    this.timer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private frame(): void {
    this.timer.update();
    const delta = Math.min(this.timer.getDelta(), 0.1);
    const moved = this.rig.update(delta);
    if (moved) this.fitViewDistance();
    if (moved || this.regionsChanged || this.frames % 15 === 0) {
      this.streamer.update(this.camera, this.renderer.domElement.height);
    }
    if (this.streamer.animate(performance.now())) this.regionsChanged = true;
    this.updateShadow();
    this.regionsChanged = false;
    this.pipeline.render();
    this.countFrame();
  }

  /** Sees farther from higher up, in steps so streaming does not churn while zooming. */
  private fitViewDistance(): void {
    const zoom = this.rig.distance;
    // Past the usual zoom limit, the view keeps growing so the ground stays in reach.
    const beyond = Math.max(0, zoom - ZOOM_LIMIT) * 3;
    const wanted = MathUtils.clamp(1400 + zoom * 3, 1600, 6000) + beyond;
    const distance = Math.round(Math.min(wanted, AUTO_VIEW_LIMIT) / 200) * 200;
    const caves = this.context.mode === "caves";
    const caveReach = Math.min(
      this.options.caveViewDistance ?? CAVE_LIMITS.viewDistance,
      CAVE_LIMITS.viewDistance,
    );
    const reach = caves
      ? Math.min(this.renderDistance ?? caveReach, caveReach)
      : (this.renderDistance ?? distance);
    this.streamer.setViewDistance(reach);
    this.atmosphere.viewDistance.value = reach;
    this.atmosphere.hazeDistance.value = caves
      ? 300
      : this.context.dimension === "overworld"
        ? distance
        : DIMENSIONS[this.context.dimension].atmosphere.hazeDistance;
    // Far from the world, a farther near plane keeps the depth buffer precise.
    this.camera.near = MathUtils.clamp(zoom / 400, 1, 50);
    // Regions start within reach, and their far corners can lie a few thousand blocks beyond.
    this.camera.far = reach * 1.2 + (caves ? 256 : 4000);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Fits the shadow map around the camera focus. It re-renders only when the snapped
   * focus, the zoom band, the sun, or the loaded terrain changes.
   */
  private updateShadow(): void {
    const focus = this.rig.focus;
    // Extents snap to steps of the square root of two, so zooming re-renders only a few times.
    const wanted = MathUtils.clamp(this.rig.distance * 1.25, 48, MAX_SHADOW_EXTENT);
    const extent = 2 ** (Math.round(Math.log2(wanted) * 2) / 2);
    const texel = (extent * 2) / SHADOW_MAP_SIZE;
    // The depth range grows with the map, and the biases keep the same size in blocks.
    const sunDistance = Math.max(900, extent * 1.5);
    const depth = sunDistance * 2.2;
    const step = texel * 16;
    const snappedX = Math.round(focus.x / step) * step;
    const snappedZ = Math.round(focus.z / step) * step;
    const key = `${snappedX}/${snappedZ}/${Math.round(focus.y)}/${extent.toFixed(1)}`;
    if (key === this.shadowKey && !this.regionsChanged) return;
    this.shadowKey = key;

    const shadowCamera = this.sun.shadow.camera;
    shadowCamera.left = -extent;
    shadowCamera.right = extent;
    shadowCamera.top = extent;
    shadowCamera.bottom = -extent;
    shadowCamera.near = 1;
    shadowCamera.far = depth;
    shadowCamera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.8 / depth;
    this.sun.shadow.normalBias = Math.max(0.35, texel * 1.4);
    this.sun.target.position.set(snappedX, focus.y, snappedZ);
    this.sun.position
      .copy(this.sun.target.position)
      .addScaledVector(this.sunDirection, sunDistance);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    this.sun.shadow.needsUpdate = true;
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private countFrame(): void {
    this.frames += 1;
    const now = performance.now();
    if (now - this.frameWindowStart >= 1000) {
      this.framesPerSecond = (this.frames * 1000) / (now - this.frameWindowStart);
      this.frames = 0;
      this.frameWindowStart = now;
    }
  }
}
