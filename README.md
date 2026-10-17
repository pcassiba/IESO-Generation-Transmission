# Ontario Generation Explorer

Interactive map and dashboard of Ontario generating facilities using **real hourly data** from the IESO
[Generator Output and Capability Report](https://reports-public.ieso.ca/public/GenOutputCapability/).

## Run

```bash
npm install
npm run dev          # http://localhost:3000 — starts the IESO poller + 30-day backfill automatically
npm test             # parser, mapping, aggregation, derate, status, timestamp and missing-data tests
npm run ingest       # manual: fetch latest report  (also: `-- backfill 30`, `-- file <xml>`, `-- status`)
npm run validate:facilities   # check data/facilities/*.json (duplicates, bounds, coverage)
```

No database install is needed: PostgreSQL runs embedded via PGlite (`data/pglite`). Set `DATABASE_URL`
to use an external PostgreSQL / Supabase instance instead.

## Architecture

| Layer | Location |
|---|---|
| XML parser (schema-tolerant, validated) | `src/lib/ieso/parser.ts` |
| Ingestion: conditional polling, SHA de-dup, XML cache, daily-archive backfill | `src/lib/ieso/ingest.ts`, `src/lib/server.ts` |
| DB schema (facilities, resource_map, reports, observations, outage_evidence) | `src/lib/db.ts` |
| Status / derate classification | `src/lib/status.ts` |
| Resource → facility aggregation, coverage | `src/lib/aggregate.ts` |
| API: `/api/state`, `/api/history`, `/api/export`, `/api/refresh` | `src/app/api/*` |
| UI (MapLibre + CARTO/OSM basemaps, Recharts) | `src/components/*` |
| Curated facility metadata & IESO mapping | `data/facilities/*.json` |

## Data notes

- IESO market hours are **EST year-round**; "HE 20" = hour ending 20:00 EST (21:00 EDT in summer).
- Wind/solar `<Capability>` is the IESO **forecast**; `<AvailCapacity>` is hardware availability.
- Derates are **capability-based** (vs. max IESO capability in the trailing 30 days), never inferred from
  low output. Zero capability ⇒ *potentially* out of service. *Confirmed* outages require a cited
  record in `outage_evidence`.
- Facility coordinates come from OpenStreetMap (with element IDs), Wikipedia or operator sources, with a
  confidence level. Facilities that could not be verified are listed but **not plotted** and are
  flagged for review (see the coverage dialog in the app).
