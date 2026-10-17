import { describe, expect, it } from "vitest";
import { buildFacilityStates, computeCoverage, type ObsLite, type ReferenceLite } from "../src/lib/aggregate";
import { normaliseFacility, validateFacilities } from "../src/lib/facilities";
import type { FacilityMeta } from "../src/lib/types";

const fac = (o: Partial<FacilityMeta> & { id: string; resources: { ieso: string }[] }): FacilityMeta =>
  normaliseFacility({ name: o.id, technology: "gas", lat: 43.7, lon: -79.4, geocodeConfidence: "high", sourceUrls: [], ...o } as Record<string, unknown>);

const obs = (iesoName: string, o: Partial<ObsLite>): [string, ObsLite] => [
  iesoName,
  { iesoName, iesoFuel: "GAS", outputMW: null, capabilityMW: null, forecastMW: null, availCapacityMW: null, ...o },
];
const ref = (mc: number | null, ma: number | null = null): ReferenceLite => ({ maxCapabilityMW: mc, maxAvailCapacityMW: ma });
const opts = { stale: false, windowDays: 30 };

describe("facility/resource mapping validation", () => {
  it("detects a resource mapped to two facilities", () => {
    const { issues, duplicateResources } = validateFacilities([
      fac({ id: "a", resources: [{ ieso: "X-G1" }] }),
      fac({ id: "b", resources: [{ ieso: "X-G1" }] }),
    ]);
    expect(duplicateResources).toEqual(["X-G1"]);
    expect(issues.some((i) => i.level === "error")).toBe(true);
  });
  it("flags out-of-Ontario coordinates and duplicate ids", () => {
    const { issues } = validateFacilities([
      fac({ id: "a", lat: 10, lon: 10, resources: [{ ieso: "A" }] }),
      fac({ id: "a", resources: [{ ieso: "B" }] }),
    ]);
    expect(issues.filter((i) => i.level === "error").length).toBeGreaterThanOrEqual(2);
  });
  it("warns (does not merge) similarly named facilities", () => {
    const { issues } = validateFacilities([
      fac({ id: "a", name: "Kipling GS", resources: [{ ieso: "KIPLING" }] }),
      fac({ id: "b", name: "Kipling G.S.", resources: [{ ieso: "KIPLING 2" }] }),
    ]);
    expect(issues.some((i) => i.message.includes("not merged"))).toBe(true);
  });
  it("coverage reports matched, unmatched and missing resources", () => {
    const c = computeCoverage(
      [fac({ id: "a", resources: [{ ieso: "A" }, { ieso: "GONE" }] }), fac({ id: "b", lat: null, lon: null, resources: [{ ieso: "B" }] })],
      ["A", "B", "NEW"],
      [],
    );
    expect(c.matchedResources).toBe(2);
    expect(c.unmatchedResources).toEqual(["NEW"]);
    expect(c.mappedButMissing).toEqual(["GONE"]);
    expect(c.facilitiesPlotted).toBe(1);
    expect(c.facilitiesNeedingReview).toEqual(["b"]);
  });
});

describe("aggregation of multiple resources per facility", () => {
  it("sums output and capability across resources", () => {
    const f = fac({ id: "p", installedCapacityMW: 550, resources: [{ ieso: "P-G1" }, { ieso: "P-G2" }, { ieso: "P-G3" }] });
    const s = buildFacilityStates(
      [f],
      new Map([obs("P-G1", { outputMW: 190, capabilityMW: 207 }), obs("P-G2", { outputMW: 185, capabilityMW: 207 }), obs("P-G3", { outputMW: 150, capabilityMW: 180 })]),
      new Map([["P-G1", ref(207)], ["P-G2", ref(207)], ["P-G3", ref(180)]]),
      [],
      opts,
    )[0];
    expect(s.outputMW).toBe(525);
    expect(s.capabilityMW).toBe(594);
    expect(s.referenceMW).toBe(594);
    expect(s.status).toBe("generating");
    expect(s.resourceStates).toHaveLength(3);
    expect(Math.round(s.utilizationPct!)).toBe(95);
  });

  it("one unit at zero capability makes the facility Potentially Derated (partial)", () => {
    const f = fac({ id: "n", technology: "nuclear", resources: [{ ieso: "N-G1" }, { ieso: "N-G2" }] });
    const s = buildFacilityStates(
      [f],
      new Map([obs("N-G1", { outputMW: 0, capabilityMW: 0 }), obs("N-G2", { outputMW: 820, capabilityMW: 817 })]),
      new Map([["N-G1", ref(0)], ["N-G2", ref(817)]]),
      [],
      opts,
    )[0];
    expect(s.resourceStates[0].status).toBe("potential_oos");
    expect(s.resourceStates[1].status).toBe("generating");
    expect(s.status).toBe("derated");
    expect(s.isGenerating).toBe(true);
  });

  it("all resources without data → Unknown, null totals (never zero-filled)", () => {
    const f = fac({ id: "z", resources: [{ ieso: "Z1" }] });
    const s = buildFacilityStates([f], new Map(), new Map(), [], opts)[0];
    expect(s.status).toBe("unknown");
    expect(s.outputMW).toBeNull();
    expect(s.capabilityMW).toBeNull();
  });

  it("partial data is flagged and totals use reporting resources only", () => {
    const f = fac({ id: "q", resources: [{ ieso: "Q1" }, { ieso: "Q2" }] });
    const s = buildFacilityStates([f], new Map([obs("Q1", { outputMW: 10, capabilityMW: 20 })]), new Map([["Q1", ref(20)]]), [], opts)[0];
    expect(s.partialData).toBe(true);
    expect(s.outputMW).toBe(10);
    expect(s.resourceStates[1].status).toBe("unknown");
  });

  it("wind facility capability uses available capacity, not forecast", () => {
    const f = fac({ id: "w", technology: "wind", resources: [{ ieso: "W" }] });
    const s = buildFacilityStates(
      [f],
      new Map([obs("W", { iesoFuel: "WIND", outputMW: 78, forecastMW: 79, availCapacityMW: 270 })]),
      new Map([["W", ref(null, 270)]]),
      [],
      opts,
    )[0];
    expect(s.capabilityMW).toBe(270);
    expect(s.forecastMW).toBe(79);
    expect(s.status).toBe("generating");
  });

  it("confirmed outage evidence applies to the linked resource only", () => {
    const f = fac({ id: "c", technology: "nuclear", resources: [{ ieso: "C1" }, { ieso: "C2" }] });
    const s = buildFacilityStates(
      [f],
      new Map([obs("C1", { outputMW: 0, capabilityMW: 0 }), obs("C2", { outputMW: 500, capabilityMW: 500 })]),
      new Map([["C1", ref(500)], ["C2", ref(500)]]),
      [{ facilityId: "c", iesoName: "C1", description: "Refurbishment", sourceUrl: "https://example.org" }],
      opts,
    )[0];
    expect(s.resourceStates[0].status).toBe("confirmed_oos");
    expect(s.resourceStates[1].status).toBe("generating");
  });
});
