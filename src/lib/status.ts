import { config } from "./config";
import type { OperationalStatus, StorageMode, Technology } from "./types";

/**
 * Operational-status classification.
 *
 * Principles:
 *  - Zero output alone NEVER implies an outage.
 *  - Zero capability implies only a *potential* outage. "Confirmed Out of Service"
 *    requires an authoritative, linked outage record (outage_evidence table).
 *  - Derates are "potential / capability-based": reported capability materially below a
 *    reference capacity. The reference is the highest capability the IESO itself
 *    reported for the resource over a trailing window (default 30 days), which keeps the
 *    comparison seasonal (ambient temperature, water conditions) instead of comparing
 *    against a fixed nameplate.
 *  - Wind/solar: the IESO "Capability" is a weather-based forecast, so low output or low
 *    forecast is NOT a derate. Only AvailCapacity (hardware availability, ignores fuel)
 *    is used for derate / unavailability tests.
 *  - Storage: this report publishes injections only; charging is shown only if a
 *    negative output value is ever published.
 */

export interface ClassifyInput {
  technology: Technology;
  outputMW: number | null;
  capabilityMW: number | null; // conventional & storage
  forecastMW: number | null; // wind/solar
  availCapacityMW: number | null;
  referenceMW: number | null;
  referenceBasis?: string | null;
  confirmedOutage?: { description: string; sourceUrl: string } | null;
  stale?: boolean;
  hasData: boolean;
}

export interface ClassifyResult {
  status: OperationalStatus;
  storageMode?: StorageMode;
  derateMW: number | null;
  deratePct: number | null;
  isGenerating: boolean;
  explanation: string[];
}

export interface Thresholds {
  generatingThresholdMW: number;
  zeroCapabilityMW: number;
  derateFraction: number;
  derateMinMW: number;
}

export const defaultThresholds = (): Thresholds => ({
  generatingThresholdMW: config.status.generatingThresholdMW,
  zeroCapabilityMW: config.status.zeroCapabilityMW,
  derateFraction: config.status.derateFraction,
  derateMinMW: config.status.derateMinMW,
});

const fmt = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 10) / 10} MW`);

export function computeDerate(
  referenceMW: number | null,
  reportedMW: number | null,
  t: Thresholds,
): { derateMW: number | null; deratePct: number | null; isDerate: boolean } {
  if (referenceMW === null || reportedMW === null || referenceMW <= 0) {
    return { derateMW: null, deratePct: null, isDerate: false };
  }
  const derateMW = Math.max(0, referenceMW - reportedMW);
  const deratePct = (derateMW / referenceMW) * 100;
  const isDerate = derateMW >= t.derateMinMW && derateMW / referenceMW >= t.derateFraction;
  return { derateMW, deratePct, isDerate };
}

export function classify(input: ClassifyInput, t: Thresholds = defaultThresholds()): ClassifyResult {
  const ex: string[] = [];
  const out = input.outputMW;
  const isGen = out !== null && out >= t.generatingThresholdMW;
  const refTxt = input.referenceMW !== null ? `${fmt(input.referenceMW)} (${input.referenceBasis ?? "reference"})` : null;

  if (!input.hasData) {
    return {
      status: "unknown",
      storageMode: input.technology === "storage" ? "unknown" : undefined,
      derateMW: null,
      deratePct: null,
      isGenerating: false,
      explanation: ["No IESO observation is available for this hour."],
    };
  }
  if (input.stale) {
    ex.push("Data is stale (latest IESO report is older than the freshness threshold); status shown is from the last report.");
  }

  if (input.confirmedOutage) {
    return {
      status: "confirmed_oos",
      storageMode: input.technology === "storage" ? "unavailable" : undefined,
      derateMW: null,
      deratePct: null,
      isGenerating: isGen,
      explanation: [
        ...ex,
        `Confirmed by published source: ${input.confirmedOutage.description}`,
        `Source: ${input.confirmedOutage.sourceUrl}`,
      ],
    };
  }

  // ---------------- Wind & solar ----------------
  if (input.technology === "wind" || input.technology === "solar") {
    const avail = input.availCapacityMW;
    ex.push(
      `Output ${fmt(out)}; IESO forecast ${fmt(input.forecastMW)}; available capacity ${fmt(avail)} (hardware availability, ignores ${input.technology === "wind" ? "wind" : "sunlight"}).`,
    );
    if (avail === null && out === null) {
      return { status: "unknown", derateMW: null, deratePct: null, isGenerating: false, explanation: [...ex, "Neither output nor available capacity was reported."] };
    }
    if (avail !== null && avail <= t.zeroCapabilityMW) {
      if (isGen) {
        ex.push("Available capacity reported as zero while output is positive — data inconsistency; classified as Generating.");
        return { status: "generating", derateMW: null, deratePct: null, isGenerating: true, explanation: ex };
      }
      ex.push("Available capacity is zero → potentially out of service (not confirmed; no authoritative outage record).");
      return { status: "potential_oos", derateMW: input.referenceMW, deratePct: input.referenceMW ? 100 : null, isGenerating: false, explanation: ex };
    }
    const d = computeDerate(input.referenceMW, avail, t);
    if (d.isDerate) {
      ex.push(
        `Available capacity is ${fmt(d.derateMW)} (${d.deratePct!.toFixed(0)}%) below reference ${refTxt}. Because available capacity excludes fuel (weather) effects, this suggests equipment outages/derates — capability-based, not officially confirmed.`,
      );
      return { status: "derated", derateMW: d.derateMW, deratePct: d.deratePct, isGenerating: isGen, explanation: ex };
    }
    if (isGen) {
      ex.push(`Output ≥ ${t.generatingThresholdMW} MW → Generating. Output below nameplate is expected for variable generation and is not treated as a derate.`);
      return { status: "generating", derateMW: d.derateMW, deratePct: d.deratePct, isGenerating: true, explanation: ex };
    }
    ex.push(
      `Output below ${t.generatingThresholdMW} MW with positive available capacity → Available, not generating (likely low ${input.technology === "wind" ? "wind" : "irradiance"} or curtailment).`,
    );
    return { status: "available", derateMW: d.derateMW, deratePct: d.deratePct, isGenerating: false, explanation: ex };
  }

  // ---------------- Storage ----------------
  if (input.technology === "storage") {
    const cap = input.capabilityMW ?? input.availCapacityMW;
    ex.push(`Reported injection ${fmt(out)}; capability ${fmt(cap)}. This IESO report publishes injections (discharge) only.`);
    if (out !== null && out <= -t.generatingThresholdMW) {
      ex.push("Negative output reported → Charging.");
      return { status: "available", storageMode: "charging", derateMW: null, deratePct: null, isGenerating: false, explanation: ex };
    }
    if (isGen) {
      ex.push(`Injection ≥ ${t.generatingThresholdMW} MW → Discharging.`);
      const d = computeDerate(input.referenceMW, cap, t);
      return { status: "generating", storageMode: "discharging", derateMW: d.derateMW, deratePct: d.deratePct, isGenerating: true, explanation: ex };
    }
    if (cap === null) {
      return { status: "unknown", storageMode: "unknown", derateMW: null, deratePct: null, isGenerating: false, explanation: [...ex, "Capability not reported."] };
    }
    if (cap <= t.zeroCapabilityMW) {
      ex.push("Capability is zero → unavailable / potentially out of service (not confirmed).");
      return { status: "potential_oos", storageMode: "unavailable", derateMW: input.referenceMW, deratePct: input.referenceMW ? 100 : null, isGenerating: false, explanation: ex };
    }
    const d = computeDerate(input.referenceMW, cap, t);
    if (d.isDerate) {
      ex.push(`Capability ${fmt(d.derateMW)} (${d.deratePct!.toFixed(0)}%) below reference ${refTxt} → potentially derated (may also reflect state of charge limits).`);
      return { status: "derated", storageMode: "not_discharging", derateMW: d.derateMW, deratePct: d.deratePct, isGenerating: false, explanation: ex };
    }
    ex.push("Not injecting with positive capability → Idle or charging (charging is not published in this dataset). Not an outage.");
    return { status: "available", storageMode: "not_discharging", derateMW: d.derateMW, deratePct: d.deratePct, isGenerating: false, explanation: ex };
  }

  // ---------------- Conventional (nuclear, gas, hydro, bioenergy, other) ----------------
  const cap = input.capabilityMW ?? input.availCapacityMW;
  ex.push(`Output ${fmt(out)}; reported capability ${fmt(cap)}${refTxt ? `; reference ${refTxt}` : ""}.`);
  if (cap === null) {
    if (isGen) {
      ex.push("Capability not reported; output is positive → Generating (derate cannot be assessed).");
      return { status: "generating", derateMW: null, deratePct: null, isGenerating: true, explanation: ex };
    }
    ex.push("Capability not reported and no output → insufficient data.");
    return { status: "unknown", derateMW: null, deratePct: null, isGenerating: false, explanation: ex };
  }
  if (cap <= t.zeroCapabilityMW) {
    if (isGen) {
      ex.push("Capability reported as zero while output is positive — data inconsistency; classified as Generating.");
      return { status: "generating", derateMW: null, deratePct: null, isGenerating: true, explanation: ex };
    }
    ex.push("Capability is zero → potentially out of service. Not confirmed: the public report does not state the cause (planned outage, forced outage, refurbishment, mothballing, or market reasons).");
    return { status: "potential_oos", derateMW: input.referenceMW, deratePct: input.referenceMW ? 100 : null, isGenerating: false, explanation: ex };
  }
  const d = computeDerate(input.referenceMW, cap, t);
  if (d.isDerate) {
    ex.push(
      `Capability is ${fmt(d.derateMW)} (${d.deratePct!.toFixed(1)}%) below the reference → potentially derated (capability-based; not an officially confirmed derate).` +
        (input.technology === "hydro" ? " For hydro this often reflects water conditions rather than equipment." : "") +
        (input.technology === "gas" ? " May reflect ambient temperature or partial unit unavailability." : ""),
    );
    return { status: "derated", derateMW: d.derateMW, deratePct: d.deratePct, isGenerating: isGen, explanation: ex };
  }
  if (isGen) {
    ex.push(`Output ≥ ${t.generatingThresholdMW} MW → Generating.`);
    return { status: "generating", derateMW: d.derateMW, deratePct: d.deratePct, isGenerating: true, explanation: ex };
  }
  ex.push("No output but positive capability → Available, not generating (e.g. not dispatched / economic). Not an outage.");
  return { status: "available", derateMW: d.derateMW, deratePct: d.deratePct, isGenerating: false, explanation: ex };
}

/** Value used as "capability" for a resource, by technology (for totals & charts). */
export function effectiveCapability(
  technology: Technology,
  o: { capabilityMW: number | null; availCapacityMW: number | null },
): number | null {
  if (technology === "wind" || technology === "solar") return o.availCapacityMW;
  return o.capabilityMW ?? o.availCapacityMW;
}
