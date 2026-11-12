# `@mapelix/scene-server`

A small, hardened HTTP server for the 3D viewer's scene regions. It is meant to run as a private
service behind an application that handles sign-in, such as a web panel. It never serves HTML and
never takes a path from a request.

```sh
pnpm turbo run build --filter=@mapelix/scene-server...
MAPELIX_WORLD_DIRECTORY=/srv/snapshots/world \
MAPELIX_CACHE_DIRECTORY=/var/cache/mapelix \
MAPELIX_LISTEN=unix:/run/mapelix/scene.sock \
node apps/scene-server/dist/main.js
```

The world directory must be a copy of a Bedrock world, such as a snapshot extracted from a backup.
The server only reads it.

## Routes

All routes accept `GET` and `HEAD` only. API version 2:

| Route                                                | Response                                                                |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `/v1/health`                                         | Status, revision, builds in flight, and cache use                       |
| `/v1/world`                                          | Name, spawn, revision, and the profile of each served dimension         |
| `/v1/dimensions/{dimension}/regions/{level}/{x}/{z}` | One binary scene region, as `@mapelix/scene-prototype/format` describes |

`dimension` is `overworld`, `nether`, or `the-end`, and must be one of the served dimensions.
`level` runs from 0 to 5. An optional `ceilingY` query parameter is the exclusive height at which
the geometry is cut, such as the Nether roof: a multiple of 16 above the dimension's floor and at
most its top. Without it, the dimension's `defaultCeilingY` applies (Overworld 320, Nether 96, End
256). An optional `dimension` query parameter, as the viewer sends it, must repeat the path's. A
refused context answers `400 invalid-context`. Each dimension and ceiling is a separate region in
every cache.

Each `/v1/world` dimension entry gives `id`, `label`, `bounds` (stored blocks, or null when the
dimension holds no chunks), `minY`, `maxY` (exclusive), `defaultCeilingY` and `spawn`, a navigation
default: the world spawn, the same point divided by eight in the Nether, or the End's arrival
platform, moved to the middle of the stored area when it falls outside it. A `revision` query parameter that does not match the current world answers
`409`, so a viewer of an older snapshot knows to reload. Regions outside the stored area answer an
empty region at once, without a build or a disk write. When too many builds wait, the server answers
`503` with `Retry-After`.

## Settings

| Variable                    | Default              | Use                                                          |
| --------------------------- | -------------------- | ------------------------------------------------------------ |
| `MAPELIX_WORLD_DIRECTORY`   | required             | The extracted world: `level.dat` and `db/`.                  |
| `MAPELIX_CACHE_DIRECTORY`   | required             | Region cache. Must not overlap the world.                    |
| `MAPELIX_LISTEN`            | `tcp:127.0.0.1:5180` | `unix:/path` or `tcp:host:port`; TCP accepts loopback only.  |
| `MAPELIX_SOCKET_MODE`       | `660`                | Octal mode of the Unix socket. Others never get access.      |
| `MAPELIX_DIMENSIONS`        | all three            | Comma-separated dimensions to serve.                         |
| `MAPELIX_SCENE_WORKERS`     | `1`                  | Builder threads per opened dimension, and builds at once.    |
| `MAPELIX_POOL_IDLE_SECONDS` | `300`                | Closes an idle dimension's threads; `0` keeps them open.     |
| `MAPELIX_MAX_PENDING`       | `32`                 | Distinct builds queued or running before `503`.              |
| `MAPELIX_MEMORY_CACHE_MB`   | `64`                 | Regions kept in memory.                                      |
| `MAPELIX_CACHE_MAX_MB`      | `1024`               | Disk cache budget. The oldest regions go first beyond it.    |
| `MAPELIX_BOUNDS`            | scanned              | `minX,minZ,maxX,maxZ` in blocks, replacing the scanned area. |

## Prewarm and the public listener

`MAPELIX_PREWARM=1` builds every region of the stored area after start-up, one dimension after the
other at its default ceiling, coarse levels first and nearest the middle of the world first, one region at a time so visitors wait behind at most one
build. Regions already on disk are only read. It stops before the disk cache passes 85 % of its
budget, and `MAPELIX_PREWARM_MAX_REGIONS` (default 100,000) caps the plan while keeping the coarse
levels. `/v1/health` reports its progress under `prewarm`.

`MAPELIX_PUBLIC_LISTEN` opens a second listener for an anonymous front end. It serves `/v1/world`
and regions **from the cache only**: a region that is not built yet answers `404 not-cached`, so no
visitor can make the server work. It does not offer `/v1/health`. `MAPELIX_PUBLIC_SOCKET_MODE`
(default `660`) may give others read and write access when the socket's folder already restricts
who can reach it; execute bits are refused.

## Dimensions and memory

The engine opens one world and one set of builder threads per dimension. Visiting all three would
keep three sets. The server shares one budget of `MAPELIX_SCENE_WORKERS` builds across them, and
closes a dimension's threads after `MAPELIX_POOL_IDLE_SECONDS` without a build, or 5 seconds after another dimension opens; the next request
reopens them.

## Lifecycle

- The revision hashes the database file names, sizes, and times, `level.dat`, and the engine code.
  A new snapshot or a new engine gets a new revision.
- The cache lives in `<cache>/<revision>/`. Opening it deletes other revision folders and any write
  interrupted by a crash. Only names the cache creates are deleted.
- The stored area is found once per revision by reading every key, and saved as `extent.json` in
  the revision folder.
- The world is opened once per process. To show a new snapshot, restart the server.
- `SIGTERM` stops it cleanly. A configuration error exits with status 78.

Logs are JSON lines on standard output and standard error.

## Releases

`scripts/pack-release.mjs` assembles a self-contained release from a built, committed checkout: the
server, only the engine modules it imports, the browser viewer module from
`apps/prototype-viewer-3d` (`build:embed`), license notices, and a `release.json` with the commit,
the API versions, and a SHA-256 for every file. It records no time or machine path.

```sh
pnpm turbo run build --filter=@mapelix/scene-server...
pnpm --filter @mapelix/prototype-viewer-3d build:embed
node apps/scene-server/scripts/pack-release.mjs /tmp/mapelix-release
```
