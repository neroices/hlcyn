import cachedData from "../data/downloads.json";

export interface DeviceRow {
  codename: string;
  total: number;
  builds: number;
  lastUpdated: string;
}

export interface DownloadsData {
  savedAt: string;
  source: string;
  grandTotal: number;
  totalBuilds: number;
  devices: DeviceRow[];
  isCached: boolean;
  fetchError?: string | null;
}

const API_URL = "https://get.hlcyn.org/api/downloads?top=100000";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour in-memory cache
const CACHE_URL = "https://halcyonstats.internal/api/downloads-cache";

let runtimeCache: { data: DownloadsData; timestamp: number } | null = null;

async function getFromEdgeCache(): Promise<DownloadsData | null> {
  try {
    const cache = (globalThis as any).caches?.default;
    if (!cache) return null;
    const res = await cache.match(CACHE_URL);
    if (!res) return null;
    return (await res.json()) as DownloadsData;
  } catch {
    return null;
  }
}

async function saveToEdgeCache(data: DownloadsData): Promise<void> {
  try {
    const cache = (globalThis as any).caches?.default;
    if (!cache) return;
    const res = new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=86400, s-maxage=86400", // Edge cache for 24h
      },
    });
    await cache.put(CACHE_URL, res);
  } catch {
    // Ignore cache put error
  }
}

async function getCloudflareEnv(): Promise<any> {
  try {
    const cf = await import("cloudflare:workers");
    return cf.env;
  } catch {
    return (globalThis as any).process?.env ?? {};
  }
}

export async function getDownloadsData(): Promise<DownloadsData> {
  // 1. If we have fresh in-memory data in this worker isolate, return immediately
  if (runtimeCache && Date.now() - runtimeCache.timestamp < CACHE_TTL_MS) {
    return runtimeCache.data;
  }

  const env = await getCloudflareEnv();
  const kv = env?.DOWNLOADS_BACKUP ?? env?.KV ?? env?.BACKUP_KV;

  // 2. Check if Cloudflare KV has fresh backup data from the scheduled backup worker (< 24h)
  if (kv?.get) {
    try {
      const kvData = (await kv.get("downloads_backup", "json")) as DownloadsData | null;
      if (kvData && Array.isArray(kvData.devices) && kvData.devices.length > 0) {
        const ageMs = Date.now() - new Date(kvData.savedAt).getTime();
        // If KV data is fresh (less than 24 hours old), serve it instantly!
        if (ageMs < 24 * 60 * 60 * 1000) {
          runtimeCache = { data: kvData, timestamp: Date.now() };
          return kvData;
        }
      }
    } catch {
      // Proceed to live fetch if KV read fails
    }
  }

  try {
    const res = await fetch(API_URL, {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://get.hlcyn.org/",
      },
    });

    if (!res.ok) {
      throw new Error(`API responded with ${res.status} ${res.statusText}`);
    }

    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      throw new Error(`Expected JSON but got ${ct} — Cloudflare may be serving a challenge page`);
    }

    const data = (await res.json()) as { downloads?: { path: string; count: number; updatedAt: string }[] };
    const entries = data.downloads ?? [];

    if (entries.length === 0 && cachedData?.devices?.length) {
      throw new Error("Live API returned empty entries");
    }

    const byDevice = new Map<string, DeviceRow>();

    for (const entry of entries) {
      const parts = entry.path.split("/");
      // Count all files including .img and .zip
      const codename = parts[2] ?? "unknown";

      const row = byDevice.get(codename) ?? {
        codename,
        total: 0,
        builds: 0,
        lastUpdated: entry.updatedAt,
      };

      row.total += entry.count;
      row.builds += 1;
      if (new Date(entry.updatedAt) > new Date(row.lastUpdated)) {
        row.lastUpdated = entry.updatedAt;
      }

      byDevice.set(codename, row);
    }

    const devices = [...byDevice.values()].sort((a, b) => b.total - a.total);

    // Query get.hlcyn.org for actual official build counts per device
    await Promise.allSettled(
      devices.map(async (device) => {
        try {
          const buildRes = await fetch(
            `https://get.hlcyn.org/api/builds?device=${encodeURIComponent(device.codename)}`,
            { signal: AbortSignal.timeout(4000) }
          );
          if (buildRes.ok) {
            const buildJson = (await buildRes.json()) as {
              builds?: { filename?: string; timestamp?: string }[];
            };
            const allBuilds = buildJson.builds ?? [];
            const zipBuilds = allBuilds.filter((b) =>
              b.filename?.toLowerCase().endsWith(".zip")
            );
            const otaOrLegacy = zipBuilds.filter(
              (b) => !b.filename?.toLowerCase().startsWith("fastboot-")
            );
            const actualCount =
              otaOrLegacy.length > 0 ? otaOrLegacy.length : zipBuilds.length;
            if (actualCount > 0) {
              device.builds = actualCount;
            }
          }
        } catch {
          // ignore individual build fetch errors and keep default
        }
      })
    );

    const grandTotal = devices.reduce((sum, d) => sum + d.total, 0);
    const totalBuilds = devices.reduce((sum, d) => sum + d.builds, 0);

    const result: DownloadsData = {
      savedAt: new Date().toISOString(),
      source: API_URL,
      grandTotal,
      totalBuilds,
      devices,
      isCached: false,
      fetchError: null,
    };

    runtimeCache = { data: result, timestamp: Date.now() };

    // Automatically persist backup to Cloudflare Edge Cache (24h)
    await saveToEdgeCache(result);

    // If Cloudflare KV is bound, persist backup to KV
    const kv = env?.DOWNLOADS_BACKUP ?? env?.KV ?? env?.BACKUP_KV;
    if (kv?.put) {
      try {
        await kv.put("downloads_backup", JSON.stringify(result));
      } catch {
        // ignore KV errors
      }
    }

    return result;
  } catch (err) {
    const fetchError = err instanceof Error ? err.message : "Unknown error";
    console.warn(`[downloads] Live API fetch failed (${fetchError}). Checking cached backups...`);

    // 1. Check in-memory isolate cache
    if (runtimeCache) {
      return {
        ...runtimeCache.data,
        isCached: true,
        fetchError,
      };
    }

    // 2. Check Cloudflare KV if bound
    const kv = env?.DOWNLOADS_BACKUP ?? env?.KV ?? env?.BACKUP_KV;
    if (kv?.get) {
      try {
        const kvData = (await kv.get("downloads_backup", "json")) as DownloadsData | null;
        if (kvData && Array.isArray(kvData.devices) && kvData.devices.length > 0) {
          return {
            ...kvData,
            isCached: true,
            fetchError,
          };
        }
      } catch {
        // ignore KV errors
      }
    }

    // 3. Check Cloudflare Edge Cache
    const edgeData = await getFromEdgeCache();
    if (edgeData && Array.isArray(edgeData.devices) && edgeData.devices.length > 0) {
      return {
        ...edgeData,
        isCached: true,
        fetchError,
      };
    }

    // 4. Bedrock fallback: bundled src/data/downloads.json
    const fallbackDevices = (cachedData.devices as DeviceRow[]) ?? [];
    return {
      savedAt: cachedData.savedAt ?? new Date().toISOString(),
      source: cachedData.source ?? API_URL,
      grandTotal:
        cachedData.grandTotal ??
        fallbackDevices.reduce((sum, d) => sum + d.total, 0),
      totalBuilds:
        cachedData.totalBuilds ??
        fallbackDevices.reduce((sum, d) => sum + d.builds, 0),
      devices: fallbackDevices,
      isCached: true,
      fetchError,
    };
  }
}
