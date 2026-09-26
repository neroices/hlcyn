import type { APIRoute } from "astro";
import cachedData from "../../data/downloads.json";

export const prerender = true;

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify(cachedData, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
