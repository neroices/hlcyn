/**
 * Cloudflare Worker for Halcyon Stats Automated Daily Backup
 *
 * Runs automatically via Cron Trigger (0 0 * * *) and writes
 * aggregated downloads & build statistics to Cloudflare KV.
 */

const API_URL = "https://get.hlcyn.org/api/downloads?top=100000";
const KV_KEY = "downloads_backup";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://get.hlcyn.org/",
};

export default {
  // 1. Cron Trigger Handler (Scheduled Event)
  async scheduled(event, env, ctx) {
    console.log(`[Cron] Triggered at ${new Date().toISOString()} (cron: ${event.cron})`);
    ctx.waitUntil(syncDownloadsToKV(env));
  },

  // 2. HTTP Handler (for testing and manual triggers)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Optional manual sync endpoint: GET /sync
    if (url.pathname === "/sync" || url.pathname === "/") {
      // If SYNC_SECRET environment variable is set, verify authorization
      if (env.SYNC_SECRET) {
        const auth = request.headers.get("x-sync-secret") || url.searchParams.get("key");
        if (auth !== env.SYNC_SECRET) {
          return new Response(JSON.stringify({ success: false, error: "Unauthorized" }, null, 2), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      try {
        const result = await syncDownloadsToKV(env);
        return new Response(
          JSON.stringify(
            {
              success: true,
              message: "Successfully synced downloads data to KV",
              savedAt: result.savedAt,
              devicesCount: result.devices.length,
              grandTotal: result.grandTotal,
              totalBuilds: result.totalBuilds,
            },
            null,
            2
          ),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      } catch (err) {
        return new Response(
          JSON.stringify(
            {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            },
            null,
            2
          ),
          {
            status: 500,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
    }

    // Healthcheck or status
    return new Response("Halcyon Stats Backup Worker is active. Use /sync to trigger manual backup.", {
      status: 200,
    });
  },
};

export async function syncDownloadsToKV(env) {
  if (!env.DOWNLOADS_BACKUP) {
    throw new Error("KV binding 'DOWNLOADS_BACKUP' is missing. Please bind it in your Worker settings.");
  }

  console.log(`[Sync] Fetching downloads from ${API_URL}...`);
  const res = await fetch(API_URL, {
    headers: HEADERS,
  });

  if (!res.ok) {
    throw new Error(`API responded with ${res.status} ${res.statusText}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new Error(`Expected JSON but received '${ct}'. Possible Cloudflare challenge.`);
  }

  const data = await res.json();
  const entries = data.downloads ?? [];

  if (entries.length === 0) {
    throw new Error("Received empty downloads list from API. Aborting write to prevent data loss.");
  }

  const byDevice = new Map();

  for (const entry of entries) {
    const parts = entry.path.split("/");
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
  console.log(`[Sync] Processed ${devices.length} devices.`);

  // Query get.hlcyn.org for official build counts per device
  await Promise.allSettled(
    devices.map(async (device) => {
      try {
        const buildRes = await fetch(
          `https://get.hlcyn.org/api/builds?device=${encodeURIComponent(device.codename)}`,
          { headers: HEADERS }
        );
        if (buildRes.ok) {
          const buildJson = await buildRes.json();
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
        // Keep default build count on error
      }
    })
  );

  const grandTotal = devices.reduce((sum, d) => sum + d.total, 0);
  const totalBuilds = devices.reduce((sum, d) => sum + d.builds, 0);

  const payload = {
    savedAt: new Date().toISOString(),
    source: API_URL,
    grandTotal,
    totalBuilds,
    devices,
  };

  // 1. Save to Cloudflare KV
  await env.DOWNLOADS_BACKUP.put(KV_KEY, JSON.stringify(payload));
  console.log(`[Sync] ✓ Saved latest backup to KV '${KV_KEY}' at ${payload.savedAt}`);

  // 2. Automatically commit to GitHub repo if GITHUB_TOKEN is configured
  try {
    await commitToGitHub(payload, env);
  } catch (err) {
    console.warn("[GitHub] Error during commit:", err);
  }

  return payload;
}

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function commitToGitHub(payload, env) {
  if (!env.GITHUB_TOKEN) {
    console.log("[GitHub] GITHUB_TOKEN secret not configured. Skipping GitHub commit.");
    return;
  }

  const repoOwner = env.GITHUB_OWNER || "neroices";
  const repoName = env.GITHUB_REPO || "hlcyn";
  const filePath = "src/data/downloads.json";
  const branch = env.GITHUB_BRANCH || "main";

  const apiUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}?ref=${branch}`;

  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Cloudflare-Worker-HalcyonStats",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  let existingSha = null;
  let existingContent = null;

  try {
    const getRes = await fetch(apiUrl, { headers });
    if (getRes.ok) {
      const fileData = await getRes.json();
      existingSha = fileData.sha;
      existingContent = fileData.content ? fileData.content.replace(/\n/g, "") : null;
    }
  } catch (err) {
    console.warn("[GitHub] Could not fetch current file SHA:", err);
  }

  const jsonString = JSON.stringify(payload, null, 2) + "\n";
  const newBase64 = toBase64(jsonString);

  // Skip commit if content has not changed
  if (existingContent && existingContent === newBase64) {
    console.log("[GitHub] Download statistics unchanged. Skipping commit.");
    return;
  }

  const putUrl = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${filePath}`;
  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: "chore(data): update daily downloads stats backup",
      content: newBase64,
      sha: existingSha ?? undefined,
      branch,
    }),
  });

  if (!putRes.ok) {
    const errText = await putRes.text();
    console.error(`[GitHub] Failed to commit to GitHub: ${putRes.status} ${errText}`);
  } else {
    console.log(`[GitHub] ✓ Successfully committed updated ${filePath} to GitHub (${repoOwner}/${repoName}@${branch})`);
  }
}

