import { getWorldMetadata } from "$lib/server/scene-world";
import { error } from "@sveltejs/kit";
import { contextFromSearch } from "@mapelix/scene-prototype/dimensions";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => {
  let context;
  try {
    context = contextFromSearch(url.searchParams);
  } catch (cause) {
    error(400, cause instanceof Error ? cause.message : "Invalid scene context");
  }
  return Response.json(await getWorldMetadata(context), {
    headers: { "cache-control": "no-store" },
  });
};
