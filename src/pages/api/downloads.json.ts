import type { APIRoute } from "astro";
import { getDownloadsData } from "../../lib/downloads";

export const GET: APIRoute = async () => {
  const data = await getDownloadsData();
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
};
