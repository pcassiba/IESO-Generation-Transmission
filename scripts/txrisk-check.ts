/**
 * Downloads the four live IESO transmission reports, parses them with the app's parsers and
 * prints how many records match the map's network. Read-only; nothing is stored.
 *
 *   npm run txrisk:check
 */
import { REPORT_URL, classify } from "../src/lib/txrisk/classify";
import { loadInterfaces } from "../src/lib/txrisk/interfaces";
import { loadNetworkIndex } from "../src/lib/txrisk/network";
import { REPORTS, parseReport } from "../src/lib/txrisk/store";
import type { ParsedLimits, ParsedOutages } from "../src/lib/txrisk/types";

async function main() {
  const parsed: Record<string, ParsedOutages | ParsedLimits | null> = {};
  for (const def of REPORTS) {
    try {
      const res = await fetch(REPORT_URL[def.kind], { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const p = parseReport(def, await res.text());
      parsed[def.kind] = p;
      const n = "outages" in p ? p.outages.length : p.limits.length;
      console.log(`${def.label}: published ${p.header.createdAtRaw} EST, ${n} records, ${p.warnings.length} warnings`);
      for (const w of p.warnings.slice(0, 10)) console.log(`   ! ${w}`);
    } catch (e) {
      parsed[def.kind] = null;
      console.log(`${def.label}: FAILED (${(e as Error).message})`);
    }
  }
  const net = loadNetworkIndex();
  if (!net.loaded) console.log("\npublic/geo/transmission.geojson missing: run npm run build:transmission first.");
  const items = classify({
    t: Date.now(),
    now: Date.now(),
    outages: parsed.outages as ParsedOutages | null,
    limits0to2: parsed.limits0to2 as ParsedLimits | null,
    limits3to34: parsed.limits3to34 as ParsedLimits | null,
    allInService: parsed.allInService as ParsedLimits | null,
    network: net,
    interfaces: loadInterfaces(),
    generation: [],
    binding: [],
    bindingDataThroughUtc: null,
  });
  const counts: Record<string, number> = {};
  for (const i of items) counts[`${i.kind} ${i.category} ${i.match === "none" ? "unmapped" : "mapped"}`] = (counts[`${i.kind} ${i.category} ${i.match === "none" ? "unmapped" : "mapped"}`] ?? 0) + 1;
  console.log("\nClassification at the current time:");
  for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${k}: ${v}`);
  console.log("\nIn effect but not on the map:");
  for (const i of items.filter((x) => x.match === "none" && x.category !== "info")) console.log(`  ${i.title}: ${i.matchNote}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
