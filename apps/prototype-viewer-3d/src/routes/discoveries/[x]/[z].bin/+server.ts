import { error } from "@sveltejs/kit";
import { parseDimension } from "@mapelix/scene-prototype/dimensions";
import {
  assertDiscoveryRequest,
  DISCOVERY_SCHEMA_VERSION,
} from "@mapelix/scene-prototype/discoveries";
import { getSnapshotRevision } from "$lib/server/scene-world";
import { loadDiscoveries } from "$lib/server/discoveries";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, url, request }) => {
  let dimension;
  const tile = { x: Number(params.x), z: Number(params.z) };
  try {
    dimension = parseDimension(url.searchParams.get("dimension"));
    assertDiscoveryRequest(tile);
    for (const name of url.searchParams.keys())
      if (!["dimension", "revision", "schema"].includes(name))
        throw new RangeError("Discovery indexes have no view, filter or selection parameters");
    const schema = url.searchParams.get("schema");
    if (schema !== null && schema !== String(DISCOVERY_SCHEMA_VERSION))
      throw new RangeError("Unsupported discovery schema");
  } catch (cause) {
    error(400, cause instanceof Error ? cause.message : "Invalid discovery request");
  }
  const revision = url.searchParams.get("revision");
  if (revision !== null && revision !== (await getSnapshotRevision()))
    error(409, "Snapshot revision changed; reload metadata");
  try {
    const result = await loadDiscoveries(dimension, tile, request.signal);
    const body = result.bytes.buffer.slice(
      result.bytes.byteOffset,
      result.bytes.byteOffset + result.bytes.byteLength,
    ) as ArrayBuffer;
    return new Response(body, {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": revision === null ? "no-cache" : "public, max-age=31536000, immutable",
        "x-mapelix-cache": result.cacheStatus,
        "server-timing": `discoveries;dur=${result.milliseconds.toFixed(1)}`,
      },
    });
  } catch (cause) {
    if (request.signal.aborted || (cause instanceof Error && cause.name === "AbortError"))
      return new Response(null, { status: 499, headers: { "cache-control": "no-store" } });
    throw cause;
  }
};
