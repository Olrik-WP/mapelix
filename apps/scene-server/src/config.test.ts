import { describe, expect, it } from "vitest";

import { ConfigError, parseBounds, parseDimensions, parseListen, readConfig } from "./config.js";

const root = process.platform === "win32" ? "C:\\srv" : "/srv";
const base = {
  MAPELIX_WORLD_DIRECTORY: `${root}/world`,
  MAPELIX_CACHE_DIRECTORY: `${root}/cache`,
};

describe("readConfig", () => {
  it("uses conservative defaults", () => {
    const config = readConfig(base);
    expect(config.workers).toBe(1);
    expect(config.maxPending).toBe(32);
    expect(config.dimensions).toEqual(["overworld", "nether", "the-end"]);
    expect(config.poolIdleSeconds).toBe(300);
    expect(config.listen).toEqual({ kind: "tcp", host: "127.0.0.1", port: 5180 });
    expect(config.diskCacheBytes).toBe(1024 * 1024 * 1024);
    expect(config.bounds).toBeUndefined();
  });

  it("requires absolute world and cache directories", () => {
    expect(() => readConfig({ MAPELIX_CACHE_DIRECTORY: base.MAPELIX_CACHE_DIRECTORY })).toThrow(
      ConfigError,
    );
    expect(() => readConfig({ ...base, MAPELIX_CACHE_DIRECTORY: "cache" })).toThrow(/absolute/);
  });

  it("refuses a cache inside the world or the reverse", () => {
    expect(() =>
      readConfig({ ...base, MAPELIX_CACHE_DIRECTORY: `${root}/world/db/cache` }),
    ).toThrow(/overlap/);
    expect(() => readConfig({ ...base, MAPELIX_WORLD_DIRECTORY: `${root}/cache/w` })).toThrow(
      /overlap/,
    );
  });

  it("bounds every numeric limit", () => {
    expect(() => readConfig({ ...base, MAPELIX_SCENE_WORKERS: "0" })).toThrow(ConfigError);
    expect(() => readConfig({ ...base, MAPELIX_SCENE_WORKERS: "64" })).toThrow(ConfigError);
    expect(() => readConfig({ ...base, MAPELIX_MAX_PENDING: "-1" })).toThrow(ConfigError);
    expect(() => readConfig({ ...base, MAPELIX_CACHE_MAX_MB: "1.5" })).toThrow(ConfigError);
    expect(readConfig({ ...base, MAPELIX_SCENE_WORKERS: "2" }).workers).toBe(2);
  });
});

describe("parseListen", () => {
  it("accepts a unix socket with a private mode", () => {
    expect(parseListen("unix:/run/m/s.sock", undefined)).toEqual({
      kind: "unix",
      path: "/run/m/s.sock",
      mode: 0o660,
    });
    expect(parseListen("unix:/run/m/s.sock", "600")).toMatchObject({ mode: 0o600 });
  });

  it("refuses socket modes open to other users", () => {
    expect(() => parseListen("unix:/run/s.sock", "666")).toThrow(ConfigError);
    expect(() => parseListen("unix:/run/s.sock", "rw")).toThrow(ConfigError);
  });

  it("only listens on loopback over TCP", () => {
    expect(parseListen("tcp:[::1]:9000", undefined)).toEqual({
      kind: "tcp",
      host: "::1",
      port: 9000,
    });
    expect(() => parseListen("tcp:0.0.0.0:9000", undefined)).toThrow(/loopback/);
    expect(() => parseListen("tcp:192.168.1.90:9000", undefined)).toThrow(/loopback/);
    expect(() => parseListen("tcp:127.0.0.1:0", undefined)).toThrow(/range/);
    expect(() => parseListen("http://127.0.0.1:1", undefined)).toThrow(ConfigError);
  });
});

describe("prewarm and public listener", () => {
  it("are off unless asked for", () => {
    const config = readConfig(base);
    expect(config.prewarm).toBe(false);
    expect(config.publicListen).toBeUndefined();
    expect(config.prewarmMaxRegions).toBe(100_000);
  });

  it("let the public socket open to a folder's group, never to execute bits", () => {
    const config = readConfig({
      ...base,
      MAPELIX_PREWARM: "1",
      MAPELIX_PUBLIC_LISTEN: "unix:/run/public/scene.sock",
      MAPELIX_PUBLIC_SOCKET_MODE: "666",
    });
    expect(config.prewarm).toBe(true);
    expect(config.publicListen).toEqual({
      kind: "unix",
      path: "/run/public/scene.sock",
      mode: 0o666,
    });
    expect(() => readConfig({ ...base, MAPELIX_PREWARM: "yes" })).toThrow(ConfigError);
    expect(() => parseListen("unix:/run/s.sock", "667", true)).toThrow(ConfigError);
    expect(() => parseListen("tcp:0.0.0.0:1", undefined, true)).toThrow(/loopback/);
  });
});

describe("parseDimensions and parseBounds", () => {
  it("accepts known dimensions once each", () => {
    expect(parseDimensions("overworld, the-end,overworld")).toEqual(["overworld", "the-end"]);
    expect(() => parseDimensions("end")).toThrow(/Unknown dimension/);
    expect(() => parseDimensions(" , ")).toThrow(ConfigError);
  });

  it("reads block bounds inside the world border", () => {
    expect(parseBounds("-10,-20,30,40")).toEqual({ minX: -10, minZ: -20, maxX: 30, maxZ: 40 });
    expect(parseBounds(undefined)).toBeUndefined();
    expect(() => parseBounds("1,2,3")).toThrow(ConfigError);
    expect(() => parseBounds("5,0,1,1")).toThrow(/minimum/);
    expect(() => parseBounds("0,0,40000000,1")).toThrow(/border/);
  });
});
