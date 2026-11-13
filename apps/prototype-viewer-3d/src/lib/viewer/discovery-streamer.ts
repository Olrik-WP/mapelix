import { Vector3, type PerspectiveCamera } from "three/webgpu";
import { sceneContext, type SceneContext } from "@mapelix/scene-prototype/dimensions";
import { selectionIntersects, type HorizontalSelection } from "@mapelix/scene-prototype/selection";
import {
  DEFAULT_DISCOVERY_FILTERS,
  DISCOVERY_KINDS,
  DISCOVERY_LIMITS,
  DISCOVERY_SCHEMA_VERSION,
  decodeDiscoveryTile,
  discoveryFilters,
  queryDiscoverySteps,
  unpackDiscoveryBlock,
  type DiscoveryFilters,
  type DiscoveryGroup,
  type DiscoveryQuery,
  type DiscoveryTile,
} from "@mapelix/scene-prototype/discoveries";
import type { WorldInfo } from "./world-viewer";
import { ExplorationRequests, ExplorationRequestError } from "./exploration-requests";
import { surfaceDiscoveryTiles } from "./discovery-focus";

export interface DiscoveryOptions {
  readonly base?: string;
  readonly suffix?: string;
  readonly memoryBudget?: number;
  readonly explorationRequests?: ExplorationRequests;
  readonly isSurfaceBlock?: (x: number, y: number, z: number) => boolean;
  readonly onPointerSelect?: () => void;
  readonly onselect: (group: DiscoveryGroup) => void;
}
export interface DiscoveryStats extends DiscoveryQuery {
  readonly available: boolean;
  readonly enabled: boolean;
  readonly loading: number;
  readonly remaining: number;
  readonly cached: number;
  readonly bytes: number;
  readonly error: string | undefined;
  readonly grouping: boolean;
}
interface CachedTile {
  readonly tile: DiscoveryTile;
  readonly bytes: number;
}
interface Marker {
  readonly button: HTMLButtonElement;
  group: DiscoveryGroup;
}

/** Bounded source-tile streaming and DOM markers; no extra GPU materials, textures or buffers. */
export class DiscoveryStreamer {
  private readonly layer = document.createElement("div");
  private readonly cache = new Map<string, CachedTile>();
  private readonly pending = new Map<string, AbortController>();
  private readonly failed = new Set<string>();
  private readonly markers = new Map<string, Marker>();
  private readonly point = new Vector3();
  private readonly budget: number;
  private readonly requests: ExplorationRequests;
  private bytes = 0;
  private largestTile = 32;
  private context: SceneContext = sceneContext();
  private revision = "";
  private available = false;
  private filters: DiscoveryFilters = DEFAULT_DISCOVERY_FILTERS;
  private selection: HorizontalSelection | undefined;
  private wanted: { key: string; x: number; z: number }[] = [];
  private dirty = true;
  private wantedKey = "";
  private disposed = false;
  private constrained = false;
  private error: string | undefined;
  private transientError = false;
  private terrainRevision = -1;
  private query: DiscoveryQuery = { groups: [], matchingBlocks: 0, limited: false };
  private grouping: Generator<void, DiscoveryQuery> | undefined;
  private get active(): boolean {
    return (
      this.available &&
      this.filters.enabled &&
      this.filters.categories.some(
        (category) => category !== "ores" || this.filters.ores.length > 0,
      )
    );
  }

  constructor(
    container: HTMLElement,
    private readonly options: DiscoveryOptions,
  ) {
    this.budget = options.memoryBudget ?? DISCOVERY_LIMITS.memoryBudget;
    this.requests =
      options.explorationRequests ?? new ExplorationRequests(DISCOVERY_LIMITS.maxRequests);
    if (!Number.isFinite(this.budget) || this.budget < 32)
      throw new RangeError("Discovery memory budget must be at least 32 bytes");
    this.layer.setAttribute("aria-label", "Discovery markers");
    Object.assign(this.layer.style, {
      position: "absolute",
      inset: "0",
      pointerEvents: "none",
      overflow: "hidden",
    });
    // The same positioned container owns the canvas and the overlay in embedded views.
    this.layer.style.position = "fixed";
    this.layer.style.inset = "auto";
    container.append(this.layer);
  }

  setWorld(world: WorldInfo): void {
    this.terrainRevision = -1;
    const revision = world.snapshotRevision ?? world.revision;
    if (revision !== this.revision || world.dimension !== this.context.dimension) {
      this.cancel();
      this.cache.clear();
      this.failed.clear();
      this.bytes = 0;
      this.largestTile = 32;
      this.error = undefined;
      this.transientError = false;
    }
    this.context = sceneContext(world.dimension, world);
    this.revision = revision;
    this.available =
      world.discoveries?.schemaVersion === DISCOVERY_SCHEMA_VERSION &&
      world.discoveries.tileSpan === DISCOVERY_LIMITS.tileSpan;
    this.wantedKey = "";
    this.dirty = true;
    this.clearMarkers();
    if (!this.available) this.cancel();
  }

  setFilters(input: DiscoveryFilters): boolean {
    const next = discoveryFilters(input);
    if (JSON.stringify(next) === JSON.stringify(this.filters)) return false;
    this.cancelQuery();
    this.filters = next;
    this.dirty = true;
    this.wantedKey = "";
    this.failed.clear();
    this.error = undefined;
    this.transientError = false;
    if (!this.active) {
      this.cancel();
      this.clearMarkers();
    }
    return true;
  }

  setSelection(selection: HorizontalSelection | undefined): void {
    this.cancelQuery();
    this.clearMarkers();
    this.selection = selection;
    this.dirty = true;
    this.wantedKey = "";
  }

  /** A changed/evicted exact region invalidates visibility, never source packets. */
  setTerrainRevision(revision: number): void {
    if (this.terrainRevision === revision) return;
    this.terrainRevision = revision;
    if (this.context.mode === "surface" && !this.filters.allHeights) {
      this.clearMarkers();
      this.dirty = true;
    }
  }

  isSurfaceDiscovery(group: DiscoveryGroup): boolean {
    return (
      this.context.mode === "surface" &&
      this.isExposedDiscovery(group) &&
      (this.options.isSurfaceBlock?.(group.x, group.y, group.z) ?? false)
    );
  }

  /** Mixed groups need the representative voxel's exposure, not a neighbor's. */
  isExposedDiscovery(group: DiscoveryGroup): boolean {
    if (group.dimension !== this.context.dimension) return false;
    let exposed = group.exposed === group.count && group.unknown === 0;
    if (!exposed && group.exposed > 0) {
      const tile = this.cache.get(`${Math.floor(group.x / 32)}/${Math.floor(group.z / 32)}`)?.tile;
      for (const word of tile?.blocks ?? []) {
        const block = unpackDiscoveryBlock(tile!, word);
        if (
          block.x === group.x &&
          block.y === group.y &&
          block.z === group.z &&
          block.kind === group.kind
        ) {
          exposed = block.exposure === "exposed";
          break;
        }
      }
    }
    return exposed;
  }

  get stats(): DiscoveryStats {
    return {
      ...this.query,
      limited: this.query.limited || this.constrained,
      available: this.available,
      enabled: this.filters.enabled,
      loading: this.pending.size,
      remaining: this.wanted.filter(
        (tile) => !this.cache.has(tile.key) && !this.failed.has(tile.key),
      ).length,
      cached: this.cache.size,
      bytes: this.bytes,
      error: this.error,
      grouping: this.active && (this.dirty || this.grouping !== undefined),
    };
  }

  update(
    camera: PerspectiveCamera,
    focus: Vector3,
    terrainReady: boolean,
    canvas: HTMLElement,
  ): void {
    if (!this.active || this.disposed) return;
    const key = `${Math.floor(focus.x / 8)}/${Math.floor(focus.z / 8)}/${Math.floor(focus.y / 16)}`;
    if (key !== this.wantedKey) {
      this.cancelQuery();
      this.wantedKey = key;
      this.dirty = true;
      const desired: { key: string; x: number; z: number; distance: number }[] = [];
      const radius = DISCOVERY_LIMITS.viewDistance;
      for (
        let z = Math.floor((focus.z - radius) / 32);
        z <= Math.floor((focus.z + radius) / 32);
        z++
      )
        for (
          let x = Math.floor((focus.x - radius) / 32);
          x <= Math.floor((focus.x + radius) / 32);
          x++
        ) {
          if (this.selection && !selectionIntersects(this.selection, x * 32, z * 32, 32)) continue;
          desired.push({
            key: `${x}/${z}`,
            x,
            z,
            distance: (x * 32 + 16 - focus.x) ** 2 + (z * 32 + 16 - focus.z) ** 2,
          });
        }
      desired.sort((a, b) => a.distance - b.distance);
      const limit = Math.min(
        DISCOVERY_LIMITS.maxTiles,
        Math.max(1, Math.floor(this.budget / this.largestTile)),
      );
      this.wanted = desired.slice(0, limit);
      this.constrained = desired.length > limit;
      const keep = new Set(this.wanted.map((tile) => tile.key));
      for (const [id, controller] of this.pending)
        if (!keep.has(id)) {
          controller.abort();
          this.pending.delete(id);
        }
    }
    if (terrainReady && this.pending.size < DISCOVERY_LIMITS.maxRequests) {
      const tile = this.wanted.find(
        (value) =>
          !this.cache.has(value.key) && !this.pending.has(value.key) && !this.failed.has(value.key),
      );
      if (tile) this.request(tile);
    }
    if (this.dirty && !this.grouping) {
      const tiles: DiscoveryTile[] = [];
      for (const wanted of this.wanted) {
        const cached = this.cache.get(wanted.key);
        if (cached) {
          this.cache.delete(wanted.key);
          this.cache.set(wanted.key, cached);
          tiles.push(cached.tile);
        }
      }
      this.grouping = this.queryTiles(tiles, { x: focus.x, y: focus.y, z: focus.z });
      this.dirty = false;
    }
    // A large all-height ore search must not block the render loop in a single long task.
    if (this.grouping) {
      const until = performance.now() + 2;
      do {
        const step = this.grouping.next();
        if (step.done) {
          this.grouping = undefined;
          this.query = step.value;
          this.reconcile();
          break;
        }
      } while (performance.now() < until);
    }
    const rect = canvas.getBoundingClientRect();
    Object.assign(this.layer.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    for (const marker of this.markers.values()) {
      const g = marker.group;
      this.point.set(g.x + 0.5, g.y + 0.5, g.z + 0.5).project(camera);
      const visible =
        this.point.z >= -1 &&
        this.point.z <= 1 &&
        Math.abs(this.point.x) <= 1 &&
        Math.abs(this.point.y) <= 1;
      marker.button.hidden = !visible;
      if (visible)
        marker.button.style.transform = `translate(${((this.point.x + 1) * rect.width) / 2}px, ${((1 - this.point.y) * rect.height) / 2}px) translate(-50%, -50%)`;
    }
  }

  private *queryTiles(
    tiles: readonly DiscoveryTile[],
    focus: { x: number; y: number; z: number },
  ): Generator<void, DiscoveryQuery> {
    if (this.context.mode === "surface" && !this.filters.allHeights)
      tiles = yield* surfaceDiscoveryTiles(tiles, this.options.isSurfaceBlock ?? (() => false));
    return yield* queryDiscoverySteps(tiles, this.filters, this.context, focus, this.selection);
  }

  private request(tile: { key: string; x: number; z: number }): void {
    const controller = new AbortController();
    this.pending.set(tile.key, controller);
    const params = new URLSearchParams({
      dimension: this.context.dimension,
      revision: this.revision,
      schema: String(DISCOVERY_SCHEMA_VERSION),
    });
    const url = `${this.options.base ?? "/discoveries"}/${tile.x}/${tile.z}${this.options.suffix ?? ".bin"}?${params}`;
    const dimension = this.context.dimension;
    void this.requests
      .read(url, controller.signal)
      .then((raw) => {
        if (controller.signal.aborted || this.disposed) return;
        if (raw.byteLength > this.budget)
          throw new Error("Discovery tile exceeds the selected memory budget.");
        const decoded = decodeDiscoveryTile(new Uint8Array(raw));
        if (decoded.x !== tile.x || decoded.z !== tile.z || decoded.dimension !== dimension)
          throw new Error("Discovery response does not match the requested tile");
        this.cache.set(tile.key, { tile: decoded, bytes: raw.byteLength });
        this.bytes += raw.byteLength;
        if (raw.byteLength > this.largestTile) {
          this.largestTile = raw.byteLength;
          this.wantedKey = "";
        }
        while (this.bytes > this.budget || this.cache.size > DISCOVERY_LIMITS.maxTiles) {
          const oldest = this.cache.keys().next().value!,
            old = this.cache.get(oldest)!;
          this.bytes -= old.bytes;
          this.cache.delete(oldest);
        }
        this.dirty = true;
        if (this.transientError) {
          this.error = undefined;
          this.transientError = false;
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted || this.disposed) return;
        this.transientError =
          cause instanceof ExplorationRequestError &&
          (cause.status === 429 || cause.status === 503);
        if (this.transientError) {
          this.error = "Server busy. Waiting before retrying discoveries.";
          return;
        }
        this.error =
          cause instanceof ExplorationRequestError
            ? cause.status === 409
              ? "Snapshot changed. Reload the map."
              : `Discoveries unavailable (${cause.status}). Toggle discoveries to retry.`
            : cause instanceof Error
              ? cause.message
              : String(cause);
        this.failed.add(tile.key);
        while (this.failed.size > 64) this.failed.delete(this.failed.values().next().value!);
      })
      .finally(() => {
        if (this.pending.get(tile.key) === controller) this.pending.delete(tile.key);
      });
  }

  private reconcile(): void {
    const keep = new Set(this.query.groups.map((group) => group.id));
    for (const [id, marker] of this.markers)
      if (!keep.has(id)) {
        marker.button.remove();
        this.markers.delete(id);
      }
    for (const group of this.query.groups) {
      const type = DISCOVERY_KINDS[group.kind]!;
      let marker = this.markers.get(group.id);
      if (!marker) {
        const button = document.createElement("button");
        button.type = "button";
        Object.assign(button.style, {
          position: "absolute",
          left: "0",
          top: "0",
          pointerEvents: "auto",
          cursor: "pointer",
          border: `2px solid #${type.color.toString(16).padStart(6, "0")}`,
          borderRadius: "50%",
          background: "#101c2bed",
          color: "white",
          padding: "0",
          width: "18px",
          height: "18px",
          fontSize: "11px",
          lineHeight: "12px",
        });
        marker = { button, group };
        const current = marker;
        button.onclick = (event) => {
          event.stopPropagation();
          if (event.detail > 0) {
            button.blur();
            this.options.onPointerSelect?.();
          }
          this.options.onselect(current.group);
        };
        this.markers.set(group.id, marker);
        this.layer.append(button);
      }
      marker.group = group;
      const label = `${type.label} · ${group.count} block${group.count === 1 ? "" : "s"} · X ${group.x}, Y ${group.y}, Z ${group.z}`;
      marker.button.textContent = type.category === "ores" ? "◆" : "✦";
      marker.button.title = label;
      marker.button.setAttribute("aria-label", label);
    }
  }

  private clearMarkers(): void {
    this.cancelQuery();
    this.layer.replaceChildren();
    this.markers.clear();
    this.query = { groups: [], matchingBlocks: 0, limited: false };
  }
  private cancelQuery(): void {
    this.grouping?.return({ groups: [], matchingBlocks: 0, limited: false });
    this.grouping = undefined;
  }
  private cancel(): void {
    for (const controller of this.pending.values()) controller.abort();
    this.pending.clear();
    this.wanted = [];
  }
  dispose(): void {
    this.disposed = true;
    this.cancel();
    if (!this.options.explorationRequests) this.requests.dispose();
    this.clearMarkers();
    this.layer.remove();
    this.cache.clear();
    this.failed.clear();
    this.bytes = 0;
  }
}
