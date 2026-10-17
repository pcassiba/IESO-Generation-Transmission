# Transmission outages & congestion risk

What the layer shows, where each value comes from, and what it cannot tell you.

## Reports used (latest undated files)

| Report | URL | Published | Used for |
|---|---|---|---|
| Today's transmission outages | `/public/TxOutagesTodayAll/PUB_TxOutagesTodayAll.xml` | hourly | equipment outages (Category 1, scheduled) |
| Outage limits, days 0–2 | `/public/TxLimitsOutage0to2Days/PUB_TxLimitsOutage0to2Days.xml` | during the day (observed) | interface restrictions now to day 2 |
| Outage limits, days 3–34 | `/public/TxLimitsOutage3to34Days/PUB_TxLimitsOutage3to34Days.xml` | about weekly (observed) | restrictions day 3 to 34 |
| All-in-service limits, days 0–34 | `/public/TxLimitsAllInService0to34Days/PUB_TxLimitsAllInService0to34Days.xml` | daily, ~00:08 | baseline for "reduction" |
| Constraint shadow prices (already ingested) | `/public/RealtimeConstrShadowPrices/` | daily, days late | binding constraints (Category 4) |

All on `https://reports-public.ieso.ca`. Fetched server-side (`src/lib/txrisk/store.ts`) with ETag /
If-Modified-Since, each on its own cadence (30 min, 60 min, 6 h, 6 h; env `TXRISK_*_MIN`). The last good
XML is cached in `data/cache/txrisk/`; a failed download or parse never replaces it and is shown in the
panel. A report is **stale** when its own `CreatedAt` is older than 3 h / 36 h / 9 days / 48 h
(env `TXRISK_*_STALE_H`). `TXRISK_ENABLED=0` stops background fetching.

## Schemas (read from the live files, 2026-10-17)

All use default namespace `http://www.ieso.ca/schema`, root `Document[@docID]`, header
`DocHeader > {DocTitle, DocRevision, DocConfidentiality/DocConfClass, CreatedAt}`.

**TxOutagesTodayAll**: `DocBody > OutageRangeStart, OutageRangeEnd, OutageRequest*`;
`OutageRequest > OutageID, PlannedStart, PlannedEnd, Priority, Recurrence, EquipmentRequested*
{EquipmentName, EquipmentType, EquipmentVoltage, ConstraintType}, EquipmentRecallTime, OutageRequestStatus`.
Codes (IESO help file): Priority P/O/U/F/FE/I; Recurrence C, NC, RE, REW, RSS, RSM, RFS, RFM;
Status SUB, STDY, NEG, AA, RISK, FA, IMPL; Constraint OOS, IS, DRATE, MUSTRUN, HOLDOFF, PROT OOS, INFO, ….

**TxLimits\*** (all three): `DocBody > DateRangeStart, DateRangeEnd, TransmissionFacilityData*`;
`TransmissionFacilityData > TransmissionFacility (Internal|Intertie), InterfaceData*
{InterfaceName, IssueDate, StartDate, EndDate, OperatingLimit, Comments}`.

**Requested but not published** (so never shown): actual outage start/end or "current status" beyond the
request status; separate station fields (stations appear only inside `EquipmentName`); interchange
scheduling limits; any flow on internal interfaces; units on `OperatingLimit` (treated as MW, as in IESO's
report descriptions).

**Times**: no offset in the files; like all IESO market data they are EST all year (UTC−5). The raw text
is kept and shown; display converts to America/Toronto.

## Matching to the map (`src/lib/txrisk/network.ts`)

1. **Circuit id = OSM `ref`** (`K21W` ↔ `K-21-W`; `A41T;A42T` towers count for both). Line equipment
   `C20R: CHERRYWOOD TS x RICHVIEW TS` → circuit C20R.
2. **Line sections** (`M30A.AJXEJ`): the whole circuit is highlighted with a *dotted* line and labelled
   approximate, because IESO's two-letter section codes are not published.
3. **Stations**: equipment like `NANTICOKE TS T13` → OSM substation "Nanticoke TS" (Transformer Station →
   TS etc. normalised). Extra name pairs: `data/transmission/station-aliases.json`. Names that match
   stations more than 3 km apart are refused.
4. **Interfaces** (`data/transmission/interfaces.json`): stations and circuits for each interface, each
   with its basis (IESO 2026 APO interface overview, the interface name itself, or OSM). Interfaces are
   drawn as rings on their stations; no route is drawn between them. Equipment named in an IESO limit
   comment (`K21W O/S`) is added when it exists on the map.

Anything without a match is listed in **Unmapped outages & constraints** and in the table (pin-off icon),
never drawn. `npm run txrisk:check` prints current coverage.

## Classification (`src/lib/txrisk/classify.ts`)

| Category | Rule |
|---|---|
| 1 Confirmed outage (red, flashing) | constraint `OOS`, status `IMPL`, in effect now under its recurrence |
| 2 Published restriction (orange, pulsing) | outage limit from a TxLimitsOutage report in effect now |
| 3 Potential congestion (yellow) | a Category 2 limit with evidence score ≥ 3 from ≥ 2 kinds of evidence |
| 4 Binding constraint (pink) | non-zero shadow price for the hour containing the selected time |
| Scheduled (purple) | future time, or approved (AA/FA) but not yet implemented |
| Listed only | not out of service (PROT OOS, HOLDOFF, INFO, IS…), only requested, or not in effect |

Score (a count of supporting facts, **not a probability**): +2 limit ≥ 10 % below all-in-service (+1 for
5–10 %); +1 per linked confirmed outage (max 2); +1 another limit on the same interface at the same time;
+1 binding on this interface in the last 7 days of shadow price data; +1 installed generation within 30 km of
the interface stations ≥ the limit.

Baselines are compared only for the same interface name (bracket code, or name without the
Winter/Summer suffix). Where IESO lists separate summer and winter limits the reduction is a range.

Recurrence: C continuous; RE/REW daily between the planned start and end times of day (REW weekdays only);
RSS/RSM/RFS/RFM exclude the named return days whole; NC and anything unclear are "unknown", never assumed
continuous.

## Known limitations

- TxOutagesTodayAll lists only outages occurring **today**; outages starting on later days are not in it.
  The future view therefore relies on the limits reports.
- Limits are published per interface; IESO publishes no flows on internal interfaces, so whether a limit
  is actually reached is unknown.
- Shadow prices arrive days late, so Category 4 appears only for past times.
- OSM `ref` tags are incomplete; some circuits (e.g. N5K, PA27, L33P/L34P) and stations (Beck, Fort
  Frances, Kenora) are not on the map yet.
- Regions are the IESO zone of the nearest plotted generator (approximate) unless the interface table gives one.
