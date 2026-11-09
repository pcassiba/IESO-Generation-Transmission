# Deploying to Cloudflare Workers

The app can run on Cloudflare Workers through the [OpenNext adapter](https://opennext.js.org/cloudflare)
(`@opennextjs/cloudflare`). The Vercel setup keeps working unchanged: Cloudflare only uses
`wrangler.jsonc`, `open-next.config.ts` and `cloudflare/worker.ts`, and Vercel ignores them.

## What is different on Cloudflare

| Topic | Local / Vercel | Cloudflare Workers |
| --- | --- | --- |
| Build | `npm run build` | `npm run cf:build` (runs `next build`, then bundles a Worker into `.open-next/`) |
| Database | PGlite locally, Neon on Vercel | An external Postgres is required (the same Neon database works). Set `DATABASE_URL`, or add Hyperdrive. |
| Scheduled polling | Node timer locally; daily cron on Vercel (`vercel.json`) | Cron Trigger in `wrangler.jsonc` (hourly at :15) calls `/api/cron` |
| Data files (`data/`, `public/geo`) | Read from disk | Compiled into the Worker (`src/lib/bundled-files.ts`) |
| Raw IESO file cache | `data/cache` (local), `/tmp` (Vercel) | `/tmp`, cleared often (data itself is in Postgres) |

## Commands

- `npm run cf:build`: build the Worker only (nothing is uploaded).
- `npm run cf:preview`: build and run it locally in the Cloudflare runtime on http://localhost:8787. Copy `.dev.vars.example` to `.dev.vars` first and put a database URL in it.
- `npm run cf:upload`: build and upload a new *version* without sending traffic to it (a preview URL).
- `npm run cf:deploy`: build and deploy to production. This makes the version live on your workers.dev URL.

## Step by step: first deployment

You need a Cloudflare account. **The Workers Paid plan ($5/month) is effectively required**: the
Free plan allows only 10 ms of CPU time per request, and parsing an IESO report takes much more.

### 1. Create or connect the Worker

**Option A, deploy from GitHub (Workers Builds):**

1. In the Cloudflare dashboard, open **Workers & Pages**, then your Worker (or **Create** → **Import a repository** and pick `IESO-Generation-Transmission`).
2. The Worker's name must be `ieso-generation-transmission`, the `name` in `wrangler.jsonc`. If your existing Worker has a different name, change `name` (and the `service` under `services`) in `wrangler.jsonc` to match it.
3. Under **Settings** → **Build**, set:
   - Build command: `npx opennextjs-cloudflare build` (not `npm run build`, which only builds the plain Next.js app)
   - Deploy command: `npx opennextjs-cloudflare deploy` (not `npx wrangler deploy`, which tries to set up OpenNext on its own and fails)
   - Non-production branch deploy command: `npx opennextjs-cloudflare upload`
   - Production branch: `main`. Builds of the migration branch then only create preview versions.
4. The earlier error `Cannot find package 'wrangler'` came from `wrangler` not being installed. It is now in `devDependencies`, so the build installs it.

**Option B, deploy from your PC:** run `npx wrangler login` once, then `npm run cf:deploy`.

### 2. Add the secrets

In the dashboard: your Worker → **Settings** → **Variables and Secrets** → **Add**, type **Secret**:

- `DATABASE_URL`: your Neon connection string (Neon dashboard → **Connect**). Use the *pooled* one (host contains `-pooler`).
- `CRON_SECRET` (optional): any long random text. The cron handler sends it automatically.

From the command line, the same is `npx wrangler secret put DATABASE_URL`.

### 3. (Recommended) Hyperdrive

Each database query on Workers opens a new connection. Hyperdrive keeps a warm pool of connections close to the Worker, which makes pages noticeably faster:

1. Run `npx wrangler hyperdrive create ieso-db --connection-string="<your Neon URL>"` (or dashboard → **Storage & Databases** → **Hyperdrive** → **Create**).
2. Copy the id it prints into the commented `hyperdrive` block at the end of `wrangler.jsonc` and uncomment it.
3. When the binding exists it is used instead of `DATABASE_URL`.

### 4. Check it

Open the `*.workers.dev` URL shown after the deploy. The map should load, and **Data sources** should show recent IESO files within a few minutes (the first page views start the backfill). Logs are under your Worker → **Observability**.

Do not add a custom domain or route until you have decided to move the live site off Vercel.

## Known limitations on Workers

- **CPU and time limits.** Work that continues after a response (`after()`) gets about 30 seconds. The hourly cron can run longer (up to 15 minutes), so the 30-day backfill fills in over several runs and page views.
- **No disk.** The raw copies of downloaded IESO generator files (kept for provenance) are only kept briefly. All the data itself, and the latest transmission outage and limits reports, are stored in Postgres and shared by every copy of the Worker, so nothing complete is downloaded twice.
- **Per-isolate memory.** Cloudflare runs several copies of the Worker. Each keeps its own 30-second rate limit on the Refresh buttons.
- **Editing data files** under `data/` or `public/geo` needs a rebuild and redeploy (also true on Vercel).
- **Command-line scripts** (`npm run ingest`, `build:transmission`, `validate:facilities`, …) run on your PC with Node, not on Cloudflare. To load data into the shared Neon database from your PC, set `DATABASE_URL` before running them.
- **PGlite** (the built-in local database) does not run on Workers. Its code is still in the bundle but never used.
