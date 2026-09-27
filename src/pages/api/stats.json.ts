import type { APIRoute } from "astro";
import { getDownloadsData } from "../../lib/downloads";

export const GET: APIRoute = async () => {
  const data = await getDownloadsData();
  const summary = {
    savedAt: data.savedAt,
    grandTotal: data.grandTotal,
    totalBuilds: data.totalBuilds,
    deviceCount: data.devices?.length ?? 0,
    topDevice: data.devices?.[0] ?? null,
  };

  return new Response(JSON.stringify(summary, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
};
