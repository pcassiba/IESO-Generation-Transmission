import { describe, expect, it } from "vitest";
import { classify, computeDerate, type Thresholds } from "../src/lib/status";

const T: Thresholds = { generatingThresholdMW: 1, zeroCapabilityMW: 0.5, derateFraction: 0.1, derateMinMW: 5 };
const base = { outputMW: null, capabilityMW: null, forecastMW: null, availCapacityMW: null, referenceMW: null, hasData: true };

describe("computeDerate", () => {
  it("computes MW and % below reference", () => {
    const d = computeDerate(800, 600, T);
    expect(d.derateMW).toBe(200);
    expect(d.deratePct).toBe(25);
    expect(d.isDerate).toBe(true);
  });
  it("ignores small differences (fraction or MW threshold)", () => {
    expect(computeDerate(800, 780, T).isDerate).toBe(false); // 2.5 %
    expect(computeDerate(20, 16, T).isDerate).toBe(false); // 4 MW < 5 MW minimum
  });
  it("never reports a negative derate", () => {
    expect(computeDerate(500, 520, T).derateMW).toBe(0);
  });
  it("returns null without a reference", () => {
    expect(computeDerate(null, 100, T)).toEqual({ derateMW: null, deratePct: null, isDerate: false });
  });
});

describe("classify — conventional", () => {
  it("generating when output above threshold", () => {
    expect(classify({ ...base, technology: "nuclear", outputMW: 820, capabilityMW: 817, referenceMW: 817 }, T).status).toBe("generating");
  });
  it("zero output with positive capability is Available, NOT an outage", () => {
    const c = classify({ ...base, technology: "gas", outputMW: 0, capabilityMW: 207, referenceMW: 207 }, T);
    expect(c.status).toBe("available");
    expect(c.explanation.join(" ")).toMatch(/Not an outage/);
  });
  it("zero capability is only POTENTIAL OOS", () => {
    expect(classify({ ...base, technology: "nuclear", outputMW: 0, capabilityMW: 0, referenceMW: 830 }, T).status).toBe("potential_oos");
  });
  it("confirmed OOS only with authoritative evidence", () => {
    const c = classify(
      { ...base, technology: "nuclear", outputMW: 0, capabilityMW: 0, confirmedOutage: { description: "Refurbishment outage", sourceUrl: "https://example.org" } },
      T,
    );
    expect(c.status).toBe("confirmed_oos");
  });
  it("capability materially below reference is a potential derate (even while generating)", () => {
    const c = classify({ ...base, technology: "gas", outputMW: 60, capabilityMW: 61, referenceMW: 207 }, T);
    expect(c.status).toBe("derated");
    expect(Math.round(c.derateMW!)).toBe(146);
    expect(c.isGenerating).toBe(true);
  });
  it("unknown without data", () => {
    expect(classify({ ...base, technology: "hydro", hasData: false }, T).status).toBe("unknown");
  });
  it("unknown when capability missing and no output", () => {
    expect(classify({ ...base, technology: "hydro", outputMW: 0 }, T).status).toBe("unknown");
  });
  it("inconsistent zero capability with positive output stays Generating", () => {
    expect(classify({ ...base, technology: "gas", outputMW: 20, capabilityMW: 0 }, T).status).toBe("generating");
  });
});

describe("classify — wind & solar", () => {
  it("low wind is NOT a derate: output far below nameplate with full availability", () => {
    const c = classify({ ...base, technology: "wind", outputMW: 3, forecastMW: 4, availCapacityMW: 270, referenceMW: 270 }, T);
    expect(c.status).toBe("generating");
  });
  it("zero output with available capacity is Available (calm / night)", () => {
    expect(classify({ ...base, technology: "solar", outputMW: 0, forecastMW: 0, availCapacityMW: 100, referenceMW: 100 }, T).status).toBe("available");
  });
  it("reduced available capacity is a potential derate", () => {
    expect(classify({ ...base, technology: "wind", outputMW: 50, forecastMW: 60, availCapacityMW: 180, referenceMW: 270 }, T).status).toBe("derated");
  });
  it("zero available capacity is potential OOS", () => {
    expect(classify({ ...base, technology: "wind", outputMW: 0, availCapacityMW: 0, referenceMW: 100 }, T).status).toBe("potential_oos");
  });
});

describe("classify — storage", () => {
  it("positive injection is discharging", () => {
    const c = classify({ ...base, technology: "storage", outputMW: 150, capabilityMW: 250, referenceMW: 250 }, T);
    expect(c.status).toBe("generating");
    expect(c.storageMode).toBe("discharging");
  });
  it("zero injection with capability is idle/not discharging — never an outage", () => {
    const c = classify({ ...base, technology: "storage", outputMW: 0, capabilityMW: 250, referenceMW: 250 }, T);
    expect(c.status).toBe("available");
    expect(c.storageMode).toBe("not_discharging");
  });
  it("negative output is charging", () => {
    const c = classify({ ...base, technology: "storage", outputMW: -80, capabilityMW: 250, referenceMW: 250 }, T);
    expect(c.storageMode).toBe("charging");
    expect(c.status).toBe("available");
  });
  it("zero capability is unavailable (potential OOS)", () => {
    const c = classify({ ...base, technology: "storage", outputMW: 0, capabilityMW: 0, referenceMW: 250 }, T);
    expect(c.storageMode).toBe("unavailable");
    expect(c.status).toBe("potential_oos");
  });
});
