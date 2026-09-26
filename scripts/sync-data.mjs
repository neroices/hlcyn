import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../src/data");
const OUTPUT_FILE = path.join(DATA_DIR, "downloads.json");

const API_URL = "https://get.hlcyn.org/api/downloads?top=100000";

async function sync() {
  console.log("Fetching downloads data from", API_URL);

  const res = await fetch(API_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch downloads: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  const entries = json.downloads ?? [];

  const byDevice = new Map();

  for (const entry of entries) {
    const parts = entry.path.split("/");
    const filename = parts.at(-1) ?? "";

    if (filename.toLowerCase().endsWith(".img")) continue;

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

  console.log(`Fetched ${devices.length} devices from download statistics.`);
  console.log("Fetching official build counts from get.hlcyn.org/api/builds...");

  await Promise.all(
    devices.map(async (device) => {
      try {
        const buildRes = await fetch(
          `https://get.hlcyn.org/api/builds?device=${encodeURIComponent(device.codename)}`
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
      } catch (err) {
        console.warn(`Could not fetch builds for ${device.codename}:`, err.message);
      }
    })
  );

  const grandTotal = devices.reduce((sum, d) => sum + d.total, 0);
  const totalBuilds = devices.reduce((sum, d) => sum + d.builds, 0);

  const payload = {
    savedAt: new Date().toISOString(),
    source: "https://get.hlcyn.org/api/downloads",
    grandTotal,
    totalBuilds,
    devices,
  };

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(payload, null, 2), "utf8");
  console.log(`✓ Successfully saved backup data to ${OUTPUT_FILE}`);
}

sync().catch((err) => {
  console.error("Error syncing data:", err);
  process.exit(1);
});
