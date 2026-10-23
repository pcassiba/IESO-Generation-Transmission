import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createMemoryDb, type Db } from "../src/lib/db";
import { storeIntertieLmp, storeLmp } from "../src/lib/ieso/congestion-ingest";
import { ingestXml } from "../src/lib/ieso/ingest";
import { parseRealtimeIntertieLmp, parseRealtimeLmpCsv } from "../src/lib/ieso/market";
import { getSources } from "../src/lib/sources";

const fixture = (...p: string[]) => fs.readFileSync(path.join(__dirname, "fixtures", ...p), "utf8");
const LMP_URL = "https://reports-public.ieso.ca/public/RealtimeEnergyLMP/PUB_RealtimeEnergyLMP_2026101915.csv";

describe("data sources page", () => {
  let db: Db;
  beforeAll(async () => {
    db = await createMemoryDb();
    await ingestXml(db, fixture("PUB_GenOutputCapability_20261014_HE20.xml"), { url: "https://reports-public.ieso.ca/public/GenOutputCapability/PUB_GenOutputCapability.xml", kind: "latest" });
    await storeLmp(db, parseRealtimeLmpCsv(fixture("lmp", "PUB_RealtimeEnergyLMP_2026101915.csv")), LMP_URL, "l1");
    await storeIntertieLmp(db, parseRealtimeIntertieLmp(fixture("intertie", "PUB_RealTimeIntertieLMP_2026101915.xml")), "https://x/PUB_RealTimeIntertieLMP.xml", "i1");
  }, 60_000);

  it("names the report, file and hour behind each dataset", async () => {
    const { entries } = await getSources(db);
    const byId = new Map(entries.map((e) => [e.id, e]));

    const gen = byId.get("generation")!;
    expect(gen.deliveryDate).toBe("2026-10-14");
    expect(gen.hourEnding).toBe(20);
    expect(gen.archiveUrl).toBe("https://reports-public.ieso.ca/public/GenOutputCapability/PUB_GenOutputCapability_20261014.xml");
    expect(gen.publishedEst).toBe("2026-10-14T20:16:16");
    expect(gen.examples.length).toBeGreaterThan(0);
    expect(gen.note).toMatch(/latest/);

    const lmp = byId.get("lmp")!;
    expect(lmp.hourTsUtc).toBe("2026-10-19T20:00:00.000Z");
    expect(lmp.hourEnding).toBe(15);
    expect(lmp.fileUrl).toBe(LMP_URL);
    expect(lmp.archiveUrl).toBe(LMP_URL);
    expect(lmp.publishedEst).toBe("2026-10-19T15:18:08");
    expect(lmp.complete).toBe(true);
    expect(lmp.examples.map((x) => x.label).join(" ")).toMatch(/highest.*median.*lowest/);

    const tie = byId.get("interties")!;
    expect(tie.hourEnding).toBe(15);
    expect(tie.archiveUrl).toMatch(/PUB_RealTimeIntertieLMP_2026101915\.xml$/);
    expect(tie.note).toMatch(/rolling/);

    expect(byId.get("transmission-map")!.report).toMatch(/OpenStreetMap/);
    expect(entries.some((e) => e.id === "tx-outages")).toBe(true);
  });

  it("follows the hour picked on screen", async () => {
    const { entries } = await getSources(db, "2026-10-14T23:00:00Z");
    expect(entries.find((e) => e.id === "lmp")!.hourTsUtc).toBeNull();
    expect(entries.find((e) => e.id === "generation")!.hourEnding).toBe(18);
  });
});
