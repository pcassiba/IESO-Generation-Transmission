import { describe, expect, it } from "vitest";
import { describeConstraint, parseConstraintShadowPrices, parseRealtimeLmpCsv } from "../src/lib/ieso/market";

// Header and rows copied from the live PUB_RealtimeEnergyLMP.csv (2026-10-17), plus a synthetic congested location.
const LMP = `CREATED AT 2026/10/17 00:18:08 FOR 2026/10/17
Delivery Hour,Interval,Pricing Location,LMP,Energy Loss Price,Energy Congestion Price
1,1,ABITIBISF-LT.AG_T1,81.67,3.19,0.00
1,2,ABITIBISF-LT.AG_T1,72.64,2.83,0.00
1,3,ABITIBISF-LT.AG_T1,36.45,1.42,0.00
1,1,ABKENORA-LT.AG,77.63,-0.85,-10.00
1,2,ABKENORA-LT.AG,69.04,-0.76,-20.00
1,2,ABKENORA-LT.AG,69.04,-0.76,-99.00
1,3,ABKENORA-LT.AG,34.64,-0.38,0.00
`;

// Shape copied from the live PUB_RealtimeConstrShadowPrices.xml (DocBody trimmed to two constraints).
const SHADOW = `<?xml version="1.0" encoding="UTF-8"?>
<Document docID="RealtimeConstrShadowPrices" xmlns="http://www.ieso.ca/schema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<DocHeader><DocTitle>Real-Time Constraints Shadow Prices Report</DocTitle><DocRevision>1</DocRevision>
<DocConfidentiality><DocConfClass>PUB</DocConfClass></DocConfidentiality><CreatedAt>2026-10-16T08:01:24</CreatedAt></DocHeader>
<DocBody>
<DELIVERYDATE>2026-10-10</DELIVERYDATE>
<HourlyPrice>
<ConstraintName> BASE CASE                      0 NW.O.T6A_4C.MMWmN</ConstraintName>
<DeliveryHour>24</DeliveryHour>
<IntervalShadowPrices><Interval>1</Interval><ShadowPrice>0</ShadowPrice><Interval>2</Interval><ShadowPrice>0</ShadowPrice></IntervalShadowPrices>
</HourlyPrice>
<HourlyPrice>
<ConstraintName> BASE CASE                      0 NW.O.T6A_4C.V2N_D</ConstraintName>
<DeliveryHour>24</DeliveryHour>
<IntervalShadowPrices><Interval>1</Interval><ShadowPrice>-25.21</ShadowPrice><Interval>2</Interval><ShadowPrice>0</ShadowPrice><Interval>8</Interval><ShadowPrice>-22.32</ShadowPrice><Interval>12</Interval><ShadowPrice>-22.32</ShadowPrice></IntervalShadowPrices>
</HourlyPrice>
</DocBody>
</Document>`;

describe("RealtimeEnergyLMP CSV", () => {
  it("averages 5-minute intervals into one row per location and hour", () => {
    const p = parseRealtimeLmpCsv(LMP);
    expect(p.deliveryDate).toBe("2026-10-17");
    expect(p.createdAt).toBe("2026-10-17T00:18:08");
    expect(p.rows).toHaveLength(2);
    const k = p.rows.find((r) => r.location === "ABKENORA-LT.AG")!;
    // HE 1 EST on Oct 17 = 06:00 UTC
    expect(k.tsUtc).toBe("2026-10-17T06:00:00.000Z");
    expect(k.intervals).toBe(3); // duplicate interval 2 ignored (first wins)
    expect(k.congestion).toBe(-10);
    expect(k.congestionMin).toBe(-20);
    expect(k.congestionMax).toBe(0);
  });

  it("uses the fallback date when the header line is absent and rejects unknown layouts", () => {
    const body = LMP.split("\n").slice(1).join("\n");
    expect(parseRealtimeLmpCsv(body, "2026-10-01").deliveryDate).toBe("2026-10-01");
    expect(() => parseRealtimeLmpCsv("a,b,c\n1,2,3")).toThrow();
  });
});

describe("RealtimeConstrShadowPrices XML", () => {
  it("keeps binding intervals and normalises names", () => {
    const p = parseConstraintShadowPrices(SHADOW);
    expect(p.deliveryDate).toBe("2026-10-10");
    expect(p.constraintCount).toBe(2);
    const b = p.rows.find((r) => r.bindingIntervals > 0)!;
    expect(b.constraint).toBe("BASE CASE 0 NW.O.T6A_4C.V2N_D");
    expect(b.bindingIntervals).toBe(3);
    expect(b.avgShadowPrice).toBeCloseTo(-23.28, 2);
    expect(b.peakShadowPrice).toBe(-25.21);
    expect(b.tsUtc).toBe("2026-10-11T05:00:00.000Z");
  });

  it("recognises interfaces and areas in constraint names", () => {
    expect(describeConstraint("BASE CASE 0 S-FETT.TAB6_N582L_24K.EQ4_DSO")).toMatchObject({ interfaceCode: "FETT", area: "Southern Ontario" });
    expect(describeConstraint("BASE CASE 0 NWL-KEN.ALL_I/S.KAO-dso")).toMatchObject({ interfaceCode: "KAO", area: "Kenora area" });
    expect(describeConstraint("R9A_SCT 1 R1LB.LAXPI")).toMatchObject({ interfaceCode: null, area: null });
  });
});
