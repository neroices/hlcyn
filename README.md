# halcyonstats

Download statistics dashboard and API for the Halcyon Project. Built with Astro SSR, Tailwind CSS v4, and hosted on Cloudflare Pages.

## Features

- **Search & Filtering**: Real-time client-side search across both device marketing names and codenames.
- **Dynamic Theming**: Material You expressive tonal palette with interactive hue slider and dark/light mode toggle.
- **Resilient Caching**: Multi-tier caching with Cloudflare KV, in-memory cache, live API fallback, and static snapshot fallback.

## How it works

1. **Scheduled Worker (`worker/`)**: Runs daily on a cron trigger (`0 0 * * *`). It pulls downloads and build stats from `get.hlcyn.org`, caches the payload in Cloudflare KV, and commits `src/data/downloads.json` to the repo via the GitHub API.
2. **SSR Website (`src/`)**: Renders on Cloudflare Pages. On each request, it serves fresh data from the live API (with a 5-minute in-memory isolate cache to prevent rate-limiting). If the live API is unreachable or times out, it automatically falls back to Cloudflare KV, Edge Cache, and the bundled `downloads.json` snapshot.

## Development

```bash
# install dependencies
pnpm install

# run dev server
pnpm dev

# build for production (outputs to out/)
pnpm build

# preview the pages build locally
pnpm preview
```

## Deployment

### Website (Cloudflare Pages)

```bash
pnpm run deploy
```

This runs `pnpm build`, ensures the Cloudflare Pages project exists, and deploys `out/`.

### Backup Worker (Cloudflare Worker)

The worker in `worker/` handles the automated daily sync and backup.

1. **Create the KV namespace**:
   ```bash
   pnpm exec wrangler kv namespace create DOWNLOADS_BACKUP
   ```
   Put the returned ID in `worker/wrangler.json`.

2. **Bind KV to Pages**:
   In Cloudflare Dashboard under your Pages project: **Settings > Functions > KV namespace bindings**, add `DOWNLOADS_BACKUP`.

3. **Set GitHub Token (optional, for auto-commit)**:
   ```bash
   pnpm exec wrangler secret put GITHUB_TOKEN --config worker/wrangler.json
   ```

4. **Deploy worker**:
   ```bash
   pnpm run deploy:worker
   ```

You can trigger a manual sync anytime by pinging `https://<worker-subdomain>.workers.dev/sync`.

## APIs

- `GET /api/stats.json` — Summary stats (grand total, builds count, device count, top device).
- `GET /api/downloads.json` — Full breakdown of all devices, download counts, and official build counts.