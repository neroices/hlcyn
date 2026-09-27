import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const distDir = path.join(root, "dist");
const outDir = path.join(root, "out");

// Clean and create out, and remove cached wrangler deployment state
fs.rmSync(outDir, { recursive: true, force: true });
fs.rmSync(path.join(root, ".wrangler"), { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "_worker.js"), { recursive: true });

// Copy static client assets to out root
fs.cpSync(path.join(distDir, "client"), outDir, { recursive: true });

// Copy server chunks to out/_worker.js
fs.cpSync(path.join(distDir, "server"), path.join(outDir, "_worker.js"), { recursive: true });

// Remove server wrangler.json to avoid config conflicts with Pages
const serverWranglerJson = path.join(distDir, "server", "wrangler.json");
if (fs.existsSync(serverWranglerJson)) {
  fs.unlinkSync(serverWranglerJson);
}
const workerWranglerJson = path.join(outDir, "_worker.js", "wrangler.json");
if (fs.existsSync(workerWranglerJson)) {
  fs.unlinkSync(workerWranglerJson);
}

// Create _worker.js entrypoint for Cloudflare Pages Advanced Mode
fs.writeFileSync(
  path.join(outDir, "_worker.js", "index.js"),
  'export * from "./entry.mjs";\nexport { default } from "./entry.mjs";\n'
);

console.log("✓ Prepared Cloudflare Pages SSR build in out/");
