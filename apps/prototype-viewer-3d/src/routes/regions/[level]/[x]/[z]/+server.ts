import { error } from "@sveltejs/kit";
import { MAX_REGION_LEVEL } from "@mapelix/scene-prototype/format";
import { contextFromSearch } from "@mapelix/scene-prototype/dimensions";

import { getWorldMetadata, loadRegion, type LoadedRegion } from "$lib/server/scene-world";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, request, url }) => {
  let context;
  try {
    context = contextFromSearch(url.searchParams);
  } catch (cause) {
    error(400, cause instanceof Error ? cause.message : "Invalid scene context");
  }
  const level = Number(params.level);
  const x = Number(params.x);
  const z = Number(params.z);
  if (!Number.isInteger(level) || level < 0 || level > MAX_REGION_LEVEL) {
    error(400, `Region level must be an integer from 0 through ${MAX_REGION_LEVEL}`);
  }
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) {
    error(400, "Region coordinates must be integers");
  }

  const revision = url.searchParams.get("revision");
  if (revision !== null && revision !== (await getWorldMetadata(context)).revision) {
    error(409, "World revision changed; reload world metadata");
  }
  let region: LoadedRegion;
  try {
    region = await loadRegion({ level, x, z }, request.signal, context);
  } catch (cause) {
    if (request.signal.aborted || (cause instanceof Error && cause.name === "AbortError")) {
      return new Response(null, { status: 499, headers: { "cache-control": "no-store" } });
    }
    throw cause;
  }
  const { bytes } = region;
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Response(body as ArrayBuffer, {
    headers: {
      "content-type": "application/octet-stream",
      // The client adds the world revision to the URL, so a region never changes in place.
      "cache-control": revision === null ? "no-cache" : "public, max-age=31536000, immutable",
      "server-timing": `region;dur=${region.milliseconds.toFixed(1)}`,
      "x-mapelix-cache": region.cacheStatus,
    },
  });
};
