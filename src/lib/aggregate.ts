import { classify, effectiveCapability, type Thresholds, defaultThresholds } from "./status";
import type { CoverageSummary, FacilityMeta, FacilityState, OperationalStatus, ResourceState, StorageMode } from "./types";
import { STATUS_LABEL } from "./types";

export interface ObsLite {
  iesoName: string;
  iesoFuel: string;
  outputMW: number | null;
  capabilityMW: number | null;
  forecastMW: number | null;
  availCapacityMW: number | null;
}

export interface ReferenceLite {
  maxCapabilityMW: number | null;
  maxAvailCapacityMW: number | null;
}

export interface OutageLite {
  facilityId: string | null;
  iesoName: string | null;
  description: string;
  sourceUrl: string;
}

const sumOrNull = (vals: (number | null)[]): number | null => {
  const v = vals.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};

export function referenceFor(technology: FacilityMeta["technology"], ref: ReferenceLite | undefined, windowDays: number) {
  if (!ref) return { referenceMW: null, basis: null };
  if (technology === "wind" || technology === "solar") {
    return ref.maxAvailCapacityMW !== null && ref.maxAvailCapacityMW > 0
      ? { referenceMW: ref.maxAvailCapacityMW, basis: `max IESO available capacity, trailing ${windowDays}d` }
      : { referenceMW: null, basis: null };
  }
  const v = ref.maxCapabilityMW ?? ref.maxAvailCapacityMW;
  return v !== null && v > 0 ? { referenceMW: v, basis: `max IESO capability, trailing ${windowDays}d` } : { referenceMW: null, basis: null };
}

export function buildFacilityStates(
  facilities: FacilityMeta[],
  obs: Map<string, ObsLite>,
  refs: Map<string, ReferenceLite>,
  outages: OutageLite[],
  opts: { stale: boolean; windowDays: number; thresholds?: Thresholds },
): FacilityState[] {
  const t = opts.thresholds ?? defaultThresholds();
  return facilities.map((f) => {
    const facOutage = outages.find((o) => o.facilityId === f.id && !o.iesoName) ?? null;
    const resourceStates: ResourceState[] = f.resources.map((r) => {
      const o = obs.get(r.ieso);
      const { referenceMW, basis } = referenceFor(f.technology, refs.get(r.ieso), opts.windowDays);
      const resOutage = outages.find((x) => x.iesoName === r.ieso) ?? facOutage;
      const hasData = !!o && (o.outputMW !== null || o.capabilityMW !== null || o.availCapacityMW !== null || o.forecastMW !== null);
      const c = classify(
        {
          technology: f.technology,
          outputMW: o?.outputMW ?? null,
          capabilityMW: o?.capabilityMW ?? null,
          forecastMW: o?.forecastMW ?? null,
          availCapacityMW: o?.availCapacityMW ?? null,
          referenceMW,
          referenceBasis: basis,
          confirmedOutage: resOutage ? { description: resOutage.description, sourceUrl: resOutage.sourceUrl } : null,
          stale: opts.stale,
          hasData,
        },
        t,
      );
      return {
        iesoName: r.ieso,
        iesoFuel: o?.iesoFuel ?? "—",
        units: r.units,
        outputMW: o?.outputMW ?? null,
        capabilityMW: o?.capabilityMW ?? null,
        forecastMW: o?.forecastMW ?? null,
        availCapacityMW: o?.availCapacityMW ?? null,
        referenceMW,
        referenceBasis: basis,
        status: c.status,
        storageMode: c.storageMode,
        derateMW: c.derateMW,
        deratePct: c.deratePct,
        explanation: c.explanation,
        hasData,
      };
    });

    const withData = resourceStates.filter((r) => r.hasData);
    const outputMW = sumOrNull(withData.map((r) => r.outputMW));
    const capabilityMW = sumOrNull(withData.map((r) => effectiveCapability(f.technology, r)));
    const forecastMW = sumOrNull(withData.map((r) => r.forecastMW));
    const availCapacityMW = sumOrNull(withData.map((r) => r.availCapacityMW));
    const refs2 = withData.map((r) => r.referenceMW);
    const referenceMW = sumOrNull(refs2);
    const partialData = withData.length > 0 && withData.length < resourceStates.length;

    let status: OperationalStatus;
    let storageMode: StorageMode | undefined;
    let derateMW: number | null = null;
    let deratePct: number | null = null;
    let isGenerating = false;
    const explanation: string[] = [];

    if (withData.length === 0) {
      status = "unknown";
      storageMode = f.technology === "storage" ? "unknown" : undefined;
      explanation.push(
        resourceStates.length === 0
          ? "No IESO resource is mapped to this facility."
          : "None of the mapped IESO resources has data for this hour.",
      );
    } else {
      const c = classify(
        {
          technology: f.technology,
          outputMW,
          capabilityMW: f.technology === "wind" || f.technology === "solar" ? null : capabilityMW,
          forecastMW,
          availCapacityMW,
          referenceMW,
          referenceBasis: withData.length > 1 ? "sum of resource references" : withData[0].referenceBasis,
          confirmedOutage: facOutage ? { description: facOutage.description, sourceUrl: facOutage.sourceUrl } : null,
          stale: opts.stale,
          hasData: true,
        },
        t,
      );
      status = c.status;
      storageMode = c.storageMode;
      derateMW = c.derateMW;
      deratePct = c.deratePct;
      isGenerating = c.isGenerating;
      explanation.push(...c.explanation);

      const counts = new Map<OperationalStatus, number>();
      for (const r of withData) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
      const oos = (counts.get("potential_oos") ?? 0) + (counts.get("confirmed_oos") ?? 0);
      if (resourceStates.length > 1) {
        explanation.push(
          "Resource breakdown: " +
            [...counts.entries()].map(([s, n]) => `${n} × ${STATUS_LABEL[s]}`).join(", ") +
            (partialData ? `; ${resourceStates.length - withData.length} resource(s) without data` : "") +
            ".",
        );
      }
      // Partial unavailability: some (not all) resources have zero capability.
      if (oos > 0 && oos < withData.length && (status === "generating" || status === "available")) {
        status = "derated";
        const lost = sumOrNull(withData.filter((r) => r.status === "potential_oos" || r.status === "confirmed_oos").map((r) => r.referenceMW));
        explanation.push(
          `${oos} of ${withData.length} reporting resources show zero capability → facility classified as Potentially Derated (partial unavailability${lost ? `, ≈${Math.round(lost)} MW by reference` : ""}).`,
        );
      }
      if (partialData) explanation.push("Some mapped resources did not report this hour; totals cover reporting resources only.");
    }

    const utilBase = f.installedCapacityMW ?? null;
    const utilizationPct = outputMW !== null && utilBase && utilBase > 0 ? (Math.max(0, outputMW) / utilBase) * 100 : null;

    return {
      ...f,
      resourceStates,
      outputMW,
      capabilityMW,
      forecastMW,
      availCapacityMW,
      referenceMW,
      utilizationPct,
      status,
      storageMode,
      derateMW,
      deratePct,
      explanation,
      isGenerating,
      partialData,
    };
  });
}

export function computeCoverage(
  facilities: FacilityMeta[],
  reportResources: string[],
  duplicateMappings: string[],
): CoverageSummary {
  const mapped = new Set(facilities.flatMap((f) => f.resources.map((r) => r.ieso)));
  const inReport = new Set(reportResources);
  return {
    reportResources: inReport.size,
    matchedResources: [...inReport].filter((r) => mapped.has(r)).length,
    unmatchedResources: [...inReport].filter((r) => !mapped.has(r)).sort(),
    mappedButMissing: [...mapped].filter((r) => !inReport.has(r)).sort(),
    facilitiesTotal: facilities.length,
    facilitiesPlotted: facilities.filter((f) => f.lat !== null && f.lon !== null).length,
    facilitiesNeedingReview: facilities.filter((f) => f.reviewFlag || f.lat === null).map((f) => f.id),
    duplicateMappings,
  };
}
