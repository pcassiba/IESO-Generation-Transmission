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
npm run build:transmission    # one-off: download transmission lines + substations from OpenStreetMap
npm run ingest -- congestion  # manual: fetch IESO nodal prices + binding constraints (server also does this)
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
| Transmission lines (OSM, by voltage) | `scripts/build-transmission.ts` → `public/geo/transmission.geojson`, `src/lib/transmission.ts` |
| Congestion: LMP + constraint parsers, ingest, API | `src/lib/ieso/market.ts`, `src/lib/ieso/congestion-ingest.ts`, `src/lib/congestion.ts`, `/api/congestion` |

## Data notes

- IESO market hours are **EST year-round**; "HE 20" = hour ending 20:00 EST (21:00 EDT in summer).
- Wind/solar `<Capability>` is the IESO **forecast**; `<AvailCapacity>` is hardware availability.
- Derates are **capability-based** (vs. max IESO capability in the trailing 30 days), never inferred from
  low output. Zero capability ⇒ *potentially* out of service. *Confirmed* outages require a cited
  record in `outage_evidence`.
- Facility coordinates come from OpenStreetMap (with element IDs), Wikipedia or operator sources, with a
  confidence level. Facilities that could not be verified are listed but **not plotted** and are
  flagged for review (see the coverage dialog in the app).

## Transmission and congestion

- **Lines** come from OpenStreetMap (`power=line|cable` in Ontario, © OpenStreetMap contributors, ODbL),
  classed by their highest tagged voltage: 500 kV (red), 230 kV (orange), 115 kV (blue). Lines below 100 kV
  are skipped unless you run `npm run build:transmission -- --all`. Re-run the script to refresh.
- **Congestion** uses IESO's renewed-market reports. IESO publishes the *limits* of internal interfaces
  (FETT, BLIP, CLAN…) but not live flows on them, so the bottleneck signal is:
  - the **congestion component of the nodal price** (`RealtimeEnergyLMP`, hourly, 7 days kept by default):
    strongly negative at a plant = its output is held back by a constraint; positive = import-constrained;
  - **binding constraints** (`RealtimeConstrShadowPrices`, daily, 30 days kept), which IESO publishes a few
    days late. Interface codes in constraint names are decoded where recognised.
- Pricing locations are linked to plants by IESO resource name; extra links go in
  `data/transmission/pricing-locations.json`. Unlinked generator locations are listed in the Congestion panel.
- Settings: `CONGESTION_ENABLED=0` turns fetching off; `CONGESTION_LMP_DAYS`, `CONGESTION_CONSTRAINT_DAYS`,
  `CONGESTION_THRESHOLD` (default 2 $/MWh) tune it.
