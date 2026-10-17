/**
 * Shared domain types.
 *
 * Terminology (deliberately kept distinct):
 *  - Facility:          a physical generating station (one map marker).
 *  - Physical unit:     a turbine/reactor/etc. (described in metadata text only — the
 *                       public IESO report does not expose physical units directly).
 *  - IESO resource:     a name published in the Generator Output & Capability report
 *                       (e.g. "PORTLANDS-G1"). May correspond to one unit, several units
 *                       (e.g. "NPKIRKLAND-G1-G5") or a whole facility (e.g. "K2WIND").
 *  - Reporting entity:  the IESO report row; for this dataset it is identical to the
 *                       IESO resource name.
 */

export type Technology =
  | "gas"
  | "nuclear"
  | "wind"
  | "hydro"
  | "solar"
  | "bioenergy"
  | "storage"
  | "other";

export const TECHNOLOGIES: Technology[] = [
  "gas",
  "nuclear",
  "hydro",
  "wind",
  "solar",
  "bioenergy",
  "storage",
  "other",
];

export const TECHNOLOGY_LABEL: Record<Technology, string> = {
  gas: "Natural Gas",
  nuclear: "Nuclear",
  wind: "Wind",
  hydro: "Hydro",
  solar: "Solar",
  bioenergy: "Bioenergy",
  storage: "Battery Storage",
  other: "Other",
};

/** Fuel categories as published in the IESO report (<FuelType>). */
export type IesoFuel = "NUCLEAR" | "GAS" | "HYDRO" | "WIND" | "SOLAR" | "BIOFUEL" | "OTHER" | string;

export type OperationalStatus =
  | "generating"
  | "available"
  | "derated"
  | "potential_oos"
  | "confirmed_oos"
  | "unknown";

export const STATUSES: OperationalStatus[] = [
  "generating",
  "available",
  "derated",
  "potential_oos",
  "confirmed_oos",
  "unknown",
];

export const STATUS_LABEL: Record<OperationalStatus, string> = {
  generating: "Generating",
  available: "Available — Not Generating",
  derated: "Potentially Derated",
  potential_oos: "Potentially Out of Service",
  confirmed_oos: "Confirmed Out of Service",
  unknown: "Status Unknown",
};

/** Battery-specific operating mode (only shown where the data supports it). */
export type StorageMode = "discharging" | "charging" | "not_discharging" | "unavailable" | "unknown";

export const STORAGE_MODE_LABEL: Record<StorageMode, string> = {
  discharging: "Discharging",
  charging: "Charging",
  not_discharging: "Idle / Not Discharging",
  unavailable: "Unavailable (zero capability)",
  unknown: "Unknown",
};

export type GeocodeConfidence = "high" | "medium" | "low" | "unverified";

/** A single IESO resource → facility mapping entry (from data/facilities.json). */
export interface ResourceMapping {
  ieso: string;
  /** Description of the physical unit(s) behind this resource, where publicly known. */
  units?: string;
}

/** Curated facility metadata (data/facilities.json). */
export interface FacilityMeta {
  id: string;
  name: string;
  technology: Technology;
  subtype?: string | null;
  operator?: string | null;
  owner?: string | null;
  municipality?: string | null;
  region?: string | null;
  lat: number | null;
  lon: number | null;
  geocodeConfidence: GeocodeConfidence;
  geocodeSource?: string | null;
  installedCapacityMW?: number | null;
  capacitySource?: string | null;
  commissioningYear?: number | null;
  sourceUrls: string[];
  resources: ResourceMapping[];
  notes?: string | null;
  reviewFlag?: boolean;
}

/** One hourly observation for one IESO resource. */
export interface Observation {
  iesoName: string;
  tsUtc: string; // ISO string, hour-ending instant in UTC
  reportDate: string; // YYYY-MM-DD (IESO market day, EST)
  hour: number; // 1..24 hour ending (EST)
  outputMW: number | null;
  /** <Capability> for dispatchable/conventional resources. */
  capabilityMW: number | null;
  /** <Capability> for WIND/SOLAR, which the IESO defines as the Forecast. */
  forecastMW: number | null;
  /** <AvailCapacity> (for WIND/SOLAR: max output less outages/derates, ignoring fuel). */
  availCapacityMW: number | null;
  iesoFuel: IesoFuel;
}

export interface ResourceState {
  iesoName: string;
  iesoFuel: IesoFuel;
  units?: string;
  outputMW: number | null;
  capabilityMW: number | null;
  forecastMW: number | null;
  availCapacityMW: number | null;
  referenceMW: number | null;
  referenceBasis: string | null;
  status: OperationalStatus;
  storageMode?: StorageMode;
  derateMW: number | null;
  deratePct: number | null;
  explanation: string[];
  hasData: boolean;
}

export interface FacilityState extends FacilityMeta {
  resourceStates: ResourceState[];
  outputMW: number | null;
  /** Conventional capability, or available capacity for VG / storage. */
  capabilityMW: number | null;
  forecastMW: number | null;
  availCapacityMW: number | null;
  referenceMW: number | null;
  utilizationPct: number | null;
  status: OperationalStatus;
  storageMode?: StorageMode;
  derateMW: number | null;
  deratePct: number | null;
  explanation: string[];
  isGenerating: boolean;
  partialData: boolean;
}

export interface CoverageSummary {
  reportResources: number;
  matchedResources: number;
  unmatchedResources: string[]; // in the IESO report but not mapped to a facility
  mappedButMissing: string[]; // mapped in metadata but absent from the report
  facilitiesTotal: number;
  facilitiesPlotted: number;
  facilitiesNeedingReview: string[];
  duplicateMappings: string[];
}

export interface DataMeta {
  mode: "latest" | "historical";
  selectedTsUtc: string | null;
  latestTsUtc: string | null;
  earliestTsUtc: string | null;
  reportDate: string | null;
  hourEnding: number | null;
  reportCreatedAt: string | null;
  lastSuccessfulFetch: string | null;
  lastAttempt: string | null;
  lastError: string | null;
  stale: boolean;
  staleReason: string | null;
  source: string;
}

export interface StateResponse {
  meta: DataMeta;
  facilities: FacilityState[];
  coverage: CoverageSummary;
  unmatched: { iesoName: string; iesoFuel: string; outputMW: number | null; capabilityMW: number | null }[];
}
