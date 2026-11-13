import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  LineBasicNodeMaterial,
  LineSegments,
  type Vector3,
} from "three/webgpu";
import {
  attribute,
  cameraPosition,
  float,
  fract,
  positionWorld,
  smoothstep,
  uniform,
  vec3,
} from "three/tsl";
import type { SceneContext } from "@mapelix/scene-prototype/dimensions";
import type { Atmosphere } from "./atmosphere";
import { WeatherBudget } from "./weather-budget";

export type WeatherMode = "clear" | "rain" | "thunderstorm";
export const MAX_RAIN_DROPS = 1024;
const WIDTH = 64,
  HEIGHT = 48;
const wrap = (value: number) => value - Math.floor(value);

export function weatherMode(value: unknown): WeatherMode {
  if (value !== "clear" && value !== "rain" && value !== "thunderstorm")
    throw new RangeError("Weather must be clear, rain or thunderstorm");
  return value;
}

/** Cosmetic weather only: fixed buffers, no sounds, textures, world writes or requests. */
export class WeatherLayer {
  readonly root: LineSegments<BufferGeometry, LineBasicNodeMaterial>;
  readonly budget = new WeatherBudget();
  private mode: WeatherMode;
  private eligible = true;
  private readonly clock = uniform(0);
  private readonly seeds = new Float32Array(MAX_RAIN_DROPS * 6);
  private readonly roofs = new BufferAttribute(new Float32Array(MAX_RAIN_DROPS * 2), 1).setUsage(
    DynamicDrawUsage,
  );
  private roofRevision = -1;
  private roofX = Infinity;
  private roofZ = Infinity;
  private flashWait = 14;
  private flashAge = 1;
  private flashes = 0;
  private readonly reducedMotion =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(
    private readonly atmosphere: Atmosphere,
    mode: WeatherMode = "clear",
  ) {
    this.mode = weatherMode(mode);
    const geometry = new BufferGeometry(),
      ends = new Float32Array(MAX_RAIN_DROPS * 2);
    let seed = 0x6d2b79f5;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    for (let i = 0; i < MAX_RAIN_DROPS; i++) {
      const xyz = [random(), random(), random()];
      this.seeds.set(xyz, i * 6);
      this.seeds.set(xyz, i * 6 + 3);
      ends[i * 2 + 1] = 1;
    }
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(MAX_RAIN_DROPS * 6), 3));
    geometry.setAttribute("rainSeed", new BufferAttribute(this.seeds, 3));
    geometry.setAttribute("rainEnd", new BufferAttribute(ends, 1));
    geometry.setAttribute("rainRoof", this.roofs);
    const material = new LineBasicNodeMaterial({
      color: 0xaac8e8,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const point = attribute("rainSeed", "vec3"),
      end = attribute("rainEnd", "float");
    const x = fract(point.x.sub(cameraPosition.x.div(WIDTH)).add(0.5))
      .mul(WIDTH)
      .sub(WIDTH / 2);
    const z = fract(point.z.sub(cameraPosition.z.div(WIDTH)).add(0.5))
      .mul(WIDTH)
      .sub(WIDTH / 2);
    const y = fract(point.y.sub(this.clock).sub(cameraPosition.y.div(HEIGHT)).add(0.5))
      .mul(HEIGHT)
      .sub(HEIGHT / 2);
    material.positionNode = vec3(x.sub(end.mul(0.08)), y.sub(end.mul(1.2)), z);
    const edge = float(1).sub(smoothstep(22, 32, vec3(x, 0, z).length()));
    material.opacityNode = edge
      .mul(this.atmosphere.rain)
      .mul(this.atmosphere.storm.mul(0.18).add(0.25));
    material.maskNode = positionWorld.y.greaterThanEqual(attribute("rainRoof", "float"));
    this.root = new LineSegments(geometry, material);
    this.root.name = "Cosmetic Overworld rain";
    this.root.frustumCulled = false;
    this.root.visible = false;
  }

  setMode(mode: WeatherMode): void {
    this.mode = weatherMode(mode);
    if (mode !== "thunderstorm") {
      this.flashAge = 1;
      this.flashWait = 14;
    }
  }

  setContext(context: SceneContext): void {
    this.eligible = context.dimension === "overworld" && context.mode === "surface";
    this.roofRevision = -1;
    this.flashAge = 1;
    this.flashWait = 14;
    if (!this.eligible) {
      this.root.visible = false;
      this.apply(0, 0, 0);
    }
  }

  update(
    delta: number,
    frameDelta: number,
    camera: Vector3,
    revision: number,
    heightAt: (x: number, z: number) => number | undefined,
  ): void {
    this.budget.sample(frameDelta);
    if (!this.eligible) return;
    if (this.budget.quality === 0) {
      this.apply(0, 0, 0);
      this.root.visible = false;
      return;
    }
    const active = this.mode !== "clear";
    const blend = 1 - Math.exp(-delta * 1.4);
    const rain = this.atmosphere.rain.value + (Number(active) - this.atmosphere.rain.value) * blend;
    const stormTarget = Number(active && this.mode === "thunderstorm");
    const storm = this.atmosphere.storm.value + (stormTarget - this.atmosphere.storm.value) * blend;
    let flash = 0;
    if (stormTarget && !this.reducedMotion) {
      this.flashWait -= delta;
      if (this.flashWait <= 0) {
        this.flashAge = 0;
        this.flashWait = 16 + (++this.flashes % 5) * 2;
      }
      if (this.flashAge < 0.24) {
        this.flashAge += delta;
        flash = Math.max(0, Math.sin((Math.PI * this.flashAge) / 0.24)) * 0.35;
      }
    }
    this.apply(rain, storm, flash);
    this.root.visible = active || rain > 0.01;
    if (!this.root.visible) return;
    const count = this.budget.quality === 2 ? MAX_RAIN_DROPS : 256;
    this.root.geometry.setDrawRange(0, count * 2);
    this.root.position.copy(camera);
    this.clock.value = wrap(this.clock.value + delta * 0.45);
    if (
      revision === this.roofRevision &&
      Math.hypot(camera.x - this.roofX, camera.z - this.roofZ) < 2
    )
      return;
    this.roofRevision = revision;
    this.roofX = camera.x;
    this.roofZ = camera.z;
    for (let i = 0; i < MAX_RAIN_DROPS; i++) {
      const x = wrap(this.seeds[i * 6]! - camera.x / WIDTH + 0.5) * WIDTH - WIDTH / 2 + camera.x;
      const z =
        wrap(this.seeds[i * 6 + 2]! - camera.z / WIDTH + 0.5) * WIDTH - WIDTH / 2 + camera.z;
      const height = heightAt(x, z) ?? camera.y - HEIGHT / 2;
      this.roofs.setX(i * 2, height);
      this.roofs.setX(i * 2 + 1, height);
    }
    this.roofs.needsUpdate = true;
  }

  private apply(rain: number, storm: number, flash: number): void {
    this.atmosphere.rain.value = rain < 0.001 ? 0 : rain;
    this.atmosphere.storm.value = storm < 0.001 ? 0 : storm;
    this.atmosphere.lightning.value = flash;
  }

  dispose(): void {
    this.apply(0, 0, 0);
    this.root.removeFromParent();
    this.root.geometry.dispose();
    this.root.material.dispose();
  }
}
