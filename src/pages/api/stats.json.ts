import type { APIRoute } from "astro";
import cachedData from "../../data/downloads.json";

export const prerender = true;

export const GET: APIRoute = async () => {
  const summary = {
    savedAt: cachedData.savedAt,
    grandTotal: cachedData.grandTotal,
    totalBuilds: cachedData.totalBuilds,
    deviceCount: cachedData.devices?.length ?? 0,
    topDevice: cachedData.devices?.[0] ?? null,
  };

  return new Response(JSON.stringify(summary, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
