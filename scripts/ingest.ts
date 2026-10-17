/**
 * CLI for the ingestion service.
 *   npm run ingest              → fetch latest report (conditional)
 *   npm run ingest -- backfill 30 → backfill N days from IESO daily archive
 *   npm run ingest -- file <path> → ingest a local XML file
 *   npm run ingest -- status    → print ingestion status
 */
import fs from "node:fs";
import { getDb } from "../src/lib/db";
import { loadFacilityFiles, seedFacilities, validateFacilities } from "../src/lib/facilities";
import { backfill, ingestLatest, ingestXml } from "../src/lib/ieso/ingest";

async function main() {
  const [cmd = "latest", arg] = process.argv.slice(2);
  const db = await getDb();
  const list = loadFacilityFiles();
  const { issues } = validateFacilities(list);
  for (const i of issues) console.log(`[metadata ${i.level}] ${i.facilityId ?? ""}: ${i.message}`);
  await seedFacilities(db, list);

  if (cmd === "latest") console.log(await ingestLatest(db));
  else if (cmd === "backfill") console.log(await backfill(db, Number(arg ?? 30), (m) => console.log(m)));
  else if (cmd === "file") console.log(await ingestXml(db, fs.readFileSync(arg!, "utf8"), { url: `file:${arg}`, kind: "file" }));
  else if (cmd === "status") {
    console.log(await db.query("SELECT to_char(report_date,'YYYY-MM-DD') d, kind, max_hour, observation_count FROM reports ORDER BY id DESC LIMIT 40"));
    console.log(await db.query("SELECT min(ts_utc), max(ts_utc), count(*) FROM observations"));
  } else console.log("Unknown command");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
