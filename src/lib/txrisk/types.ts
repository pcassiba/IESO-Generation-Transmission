/**
 * Shared types for the Transmission Outages & Congestion Risk layer.
 *
 * Everything that comes straight from an IESO report keeps its original text (`raw…` fields,
 * EST local timestamps) next to the parsed value, so the UI can show exactly what IESO published.
 */

export type TxReportKind = "outages" | "limits0to2" | "limits3to34" | "allInService";

export interface TxReportHeader {
  docId: string;
  title: string | null;
  /** <CreatedAt> exactly as published (IESO local time, EST, no offset in the file). */
  createdAtRaw: string | null;
  /** CreatedAt interpreted as EST (UTC−5) → UTC ISO. */
  createdAtUtc: string | null;
}

/** One <EquipmentRequested> entry of TxOutagesTodayAll. */
export interface OutageEquipment {
  name: string;
  type: string | null;
  /** "230 kV" → 230; "NULL" / missing → null. */
  voltageKv: number | null;
  rawVoltage: string | null;
  constraintType: string | null;
}

/** One <OutageRequest> of TxOutagesTodayAll (deduplicated by OutageID). */
export interface OutageRecord {
  outageId: string;
  plannedStartRaw: string | null;
  plannedEndRaw: string | null;
  plannedStartUtc: string | null;
  plannedEndUtc: string | null;
  priority: string | null;
  recurrence: string | null;
  recallTime: string | null;
  status: string | null;
  equipment: OutageEquipment[];
}

export interface ParsedOutages {
  header: TxReportHeader;
  rangeStartRaw: string | null;
  rangeEndRaw: string | null;
  outages: OutageRecord[];
  warnings: string[];
}

/** One <InterfaceData> of a TxLimits report. */
export interface LimitRecord {
  /** Stable id: hash of the identifying fields (same record in a later publication → same id). */
  id: string;
  facilityType: string | null;
  interfaceName: string;
  issueDateRaw: string | null;
  startRaw: string | null;
  endRaw: string | null;
  startUtc: string | null;
  endUtc: string | null;
  /** MW. IESO does not state the unit in the file; the report help pages describe limits in MW. */
  operatingLimitMW: number | null;
  comments: string | null;
}

export interface ParsedLimits {
  header: TxReportHeader;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  limits: LimitRecord[];
  warnings: string[];
}

export interface ReportStatus {
  kind: TxReportKind;
  label: string;
  url: string;
  /** Publication time from the report header (UTC). */
  publishedUtc: string | null;
  publishedRaw: string | null;
  lastAttemptUtc: string | null;
  lastSuccessUtc: string | null;
  lastError: string | null;
  stale: boolean;
  staleReason: string | null;
  records: number;
  warnings: string[];
}

export type RiskCategory = "outage" | "restriction" | "potential" | "binding" | "future" | "info";

export type MatchLevel = "circuit" | "circuit-section" | "station" | "interface-stations" | "none";

export interface Evidence {
  text: string;
  /** "ieso" = stated in an IESO report; "app" = derived by this application. */
  source: "ieso" | "app";
}

export interface ScoreFactor {
  label: string;
  points: number;
}

export interface TxRiskItem {
  id: string;
  kind: "outage" | "limit" | "binding";
  title: string;
  subtitle: string | null;
  category: RiskCategory;
  categoryLabel: string;
  /** Animate on the map (red flashing / orange pulsing). */
  animate: "flash" | "pulse" | null;
  activeAtT: boolean;
  statusText: string;
  region: string | null;
  voltageKv: number | null;
  startUtc: string | null;
  endUtc: string | null;
  startRaw: string | null;
  endRaw: string | null;
  // Outage fields
  outageId?: string;
  priority?: string | null;
  priorityLabel?: string | null;
  recurrence?: string | null;
  recurrenceLabel?: string | null;
  requestStatus?: string | null;
  requestStatusLabel?: string | null;
  equipment?: (OutageEquipment & { circuit: string | null; station: string | null; match: MatchLevel; terminals?: string[] })[];
  // Limit fields
  interfaceName?: string;
  interfaceCode?: string | null;
  facilityType?: string | null;
  operatingLimitMW?: number | null;
  baselineMW?: number[] | null;
  baselineNote?: string | null;
  reductionMW?: [number, number] | null;
  reductionPct?: [number, number] | null;
  comments?: string | null;
  issueDateRaw?: string | null;
  sourceReport?: TxReportKind;
  // Binding constraint fields
  constraintName?: string;
  shadowPrice?: number | null;
  // Assessment
  evidence: Evidence[];
  score: { points: number; factors: ScoreFactor[] } | null;
  implications: string[];
  limitations: string[];
  nearbyGeneration: { id: string; name: string; mw: number | null; km: number }[];
  // Geometry (OSM ids from public/geo)
  match: MatchLevel;
  matchNote: string;
  lineIds: number[];
  stationIds: number[];
  bbox: [number, number, number, number] | null;
  sourceUrl: string;
}

export interface TxRiskResponse {
  tUtc: string;
  nowUtc: string;
  mode: "current" | "future" | "past";
  reports: ReportStatus[];
  items: TxRiskItem[];
  networkLoaded: boolean;
  bindingDataThroughUtc: string | null;
  notes: string[];
}
