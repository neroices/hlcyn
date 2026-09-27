import { execSync } from "node:child_process";

const PROJECT_NAME = "halcyonstats";

console.log("🚀 Starting Cloudflare Pages SSR deployment for", PROJECT_NAME);

// 1. Build Astro project and prepare out directory
console.log("\n🔨 1/3 Building Astro SSR and preparing out/...");
execSync("pnpm run build", { stdio: "inherit" });

// 2. Ensure Pages project exists on Cloudflare
console.log(`\n☁️ 2/3 Verifying Cloudflare Pages project '${PROJECT_NAME}'...`);
try {
  execSync(`pnpm exec wrangler pages project create ${PROJECT_NAME} --production-branch main`, {
    stdio: "pipe",
  });
  console.log(`✓ Project '${PROJECT_NAME}' created successfully.`);
} catch (err) {
  // If project already exists or error occurs, wrangler will print or fail; we continue to deploy
  const msg = err.stderr ? err.stderr.toString() : err.message;
  if (msg.includes("already exists") || msg.includes("A project with this name already exists")) {
    console.log(`✓ Project '${PROJECT_NAME}' already exists.`);
  } else {
    // Project might already exist or need authentication
    console.log(`Project check completed.`);
  }
}

// 3. Deploy to Cloudflare Pages
console.log(`\n📤 3/3 Deploying out/ to Cloudflare Pages...`);
try {
  execSync(`pnpm exec wrangler pages deploy out --project-name=${PROJECT_NAME}`, {
    stdio: "inherit",
  });
  console.log(`\n✨ Successfully deployed to Cloudflare Pages!`);
  console.log(`🔗 https://${PROJECT_NAME}.pages.dev`);
} catch (err) {
  console.error(`\n❌ Deployment failed. If you haven't logged in yet, run:\n   pnpm exec wrangler login\n`);
  process.exit(1);
}
