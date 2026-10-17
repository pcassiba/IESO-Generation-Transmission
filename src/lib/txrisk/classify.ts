import { findBaseline, findInterface, interfaceKey, reduction, type InterfaceDef } from "./interfaces";
import { equipmentInComment, findStation, kmBetween, matchEquipment, type NetworkIndex } from "./network";
import { RECURRENCE_LABEL, occurrenceAt } from "./recurrence";
import type { Evidence, LimitRecord, MatchLevel, OutageRecord, ParsedLimits, ParsedOutages, RiskCategory, ScoreFactor, TxReportKind, TxRiskItem } from "./types";

/**
 * Evidence-based classification of transmission outages and limits at a chosen instant t.
 *
 *  Category 1  outage       IESO outage request with constraint OOS, status IMPL (Implemented),
 *                           and in effect at t under its recurrence code. Only for the current view.
 *  Category 2  restriction  An outage-related operating limit from TxLimitsOutage* in effect at t
 *                           (and already in effect now). Not proof of binding congestion.
 *  Category 3  potential    A Category 2 limit whose transparent evidence score (below) reaches
 *                           POTENTIAL_MIN_POINTS from at least two different kinds of evidence.
 *                           The score is a count of supporting facts, not a probability.
 *  Category 4  binding      A constraint with a non-zero shadow price in IESO's real-time
 *                           constraint shadow price report for the hour containing t. Never
 *                           inferred from outages or limits.
 *  future                   Scheduled (approved or implemented) outage, or a limit that starts
 *                           after now, at a future t. Never shown as congestion.
 *  info                     Listed for completeness: not in effect at t, not out of service
 *                           (e.g. protection-only work), or only requested.
 *
 * Score factors for a limit in effect at t:
 *   +2  published limit ≥ 10 % below the comparable all-in-service limit (+1 for 5–10 %)
 *   +1  per confirmed out-of-service equipment linked to the interface (max +2)
 *   +1  another outage limit on the same interface in effect at the same time
 *   +1  a constraint on this interface was binding in the last 7 days of IESO shadow price data
 *   +1  installed generation within 30 km of the interface's stations exceeds the published limit
 */

export const POTENTIAL_MIN_POINTS = 3;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CURRENT_TOLERANCE = HOUR;

export const PRIORITY_LABEL: Record<string, string> = { P: "Planned", O: "Opportunity", U: "Urgent", F: "Forced", FE: "Forced extended", I: "Informational" };
export const STATUS_LABEL: Record<string, string> = {
  SUB: "Submitted",
  STDY: "Under study",
  NEG: "Negotiate",
  AA: "Advance approved",
  RISK: "At risk",
  FA: "Final approved",
  IMPL: "Implemented",
};
export const CONSTRAINT_LABEL: Record<string, string> = {
  OOS: "Out of service",
  IS: "In service",
  DRATE: "Derated",
  MUSTRUN: "Must run",
  HOLDOFF: "Auto-reclose hold-off (in service)",
  "AVR/PSS OOS": "Voltage regulator / stabiliser out of service",
  "ASP OOS": "Ancillary service out of service",
  "PROT OOS": "Protection out of service (equipment in service)",
  "BF PROT OOS": "Breaker-failure protection out of service",
  BTCT: "Breaker trip coil test",
  INFO: "Information only",
  ABNO: "Available but not operating",
};

export const CATEGORY_LABEL: Record<RiskCategory, string> = {
  outage: "Confirmed equipment outage",
  restriction: "Published transmission restriction",
  potential: "Potential congestion",
  binding: "Confirmed binding constraint",
  future: "Scheduled / future restriction",
  info: "Listed, not in effect or not out of service",
};

export const REPORT_URL: Record<TxReportKind, string> = {
  outages: "https://reports-public.ieso.ca/public/TxOutagesTodayAll/PUB_TxOutagesTodayAll.xml",
  limits0to2: "https://reports-public.ieso.ca/public/TxLimitsOutage0to2Days/PUB_TxLimitsOutage0to2Days.xml",
  limits3to34: "https://reports-public.ieso.ca/public/TxLimitsOutage3to34Days/PUB_TxLimitsOutage3to34Days.xml",
  allInService: "https://reports-public.ieso.ca/public/TxLimitsAllInService0to34Days/PUB_TxLimitsAllInService0to34Days.xml",
};
const SHADOW_URL = "https://reports-public.ieso.ca/public/RealtimeConstrShadowPrices/";

export interface GenSite {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  mw: number | null;
  region: string | null;
}

export interface BindingHour {
  constraintName: string;
  interfaceCode: string | null;
  tsUtc: string;
  avgShadowPrice: number | null;
}

export interface ClassifyInput {
  t: number;
  now: number;
  outages: ParsedOutages | null;
  limits0to2: ParsedLimits | null;
  limits3to34: ParsedLimits | null;
  allInService: ParsedLimits | null;
  network: NetworkIndex;
  interfaces: InterfaceDef[];
  generation: GenSite[];
  /** Binding constraint hours (from the shadow price report), any time range. */
  binding: BindingHour[];
  bindingDataThroughUtc: string | null;
}

const MATCH_RANK: Record<MatchLevel, number> = { circuit: 4, "circuit-section": 3, "interface-stations": 2, station: 2, none: 0 };
const fmtRange = ([a, b]: [number, number], unit: string) => (a === b ? `${a}${unit}` : `${a}–${b}${unit}`);

function geometryInfo(net: NetworkIndex, lineIds: number[], stationIds: number[]) {
  let bbox: [number, number, number, number] | null = null;
  const grow = (x0: number, y0: number, x1: number, y1: number) => {
    bbox = bbox ? [Math.min(bbox[0], x0), Math.min(bbox[1], y0), Math.max(bbox[2], x1), Math.max(bbox[3], y1)] : [x0, y0, x1, y1];
  };
  const pts: [number, number][] = [];
  for (const id of lineIds) {
    const l = net.lines.get(id);
    if (!l) continue;
    grow(...l.bbox);
    pts.push(...l.pts);
  }
  for (const id of stationIds) {
    const s = net.stations.get(id);
    if (!s) continue;
    grow(s.lon, s.lat, s.lon, s.lat);
    pts.push([s.lon, s.lat]);
  }
  return { bbox: bbox as [number, number, number, number] | null, pts };
}

function nearby(gen: GenSite[], pts: [number, number][], km: number) {
  if (!pts.length) return [];
  const out: TxRiskItem["nearbyGeneration"] = [];
  for (const g of gen) {
    if (g.lat === null || g.lon === null) continue;
    let best = Infinity;
    for (const p of pts) best = Math.min(best, kmBetween(p, [g.lon, g.lat]));
    if (best <= km) out.push({ id: g.id, name: g.name, mw: g.mw, km: Math.round(best) });
  }
  return out.sort((a, b) => (b.mw ?? 0) - (a.mw ?? 0)).slice(0, 12);
}

/** IESO zone of the nearest located generator within 60 km (approximate, labelled as such). */
function regionOf(gen: GenSite[], pts: [number, number][]): string | null {
  let best: { d: number; r: string } | null = null;
  for (const g of gen) {
    if (g.lat === null || g.lon === null || !g.region) continue;
    for (const p of pts) {
      const d = kmBetween(p, [g.lon, g.lat]);
      if (d <= 60 && (!best || d < best.d)) best = { d, r: g.region };
    }
  }
  return best?.r ?? null;
}

const active = (start: string | null, end: string | null, t: number) => (!start || Date.parse(start) <= t) && (!end || t < Date.parse(end));

interface OutageCtx {
  item: TxRiskItem;
  oosCircuits: Set<string>;
  confirmed: boolean;
  activeAtT: boolean;
}

function classifyOutage(o: OutageRecord, inp: ClassifyInput, mode: "current" | "future" | "past"): OutageCtx {
  const net = inp.network;
  const equipment = o.equipment.map((e) => {
    const m = matchEquipment(net, e.name, e.type);
    return { ...e, circuit: m.parsed.circuit, station: m.parsed.station, terminals: m.parsed.terminals, match: m.match, _m: m };
  });
  const oos = equipment.filter((e) => (e.constraintType ?? "").toUpperCase() === "OOS");
  const drawn = oos.length ? oos : [];
  const lineIds = [...new Set(drawn.flatMap((e) => e._m.lineIds))];
  const stationIds = [...new Set(drawn.flatMap((e) => e._m.stationIds))];
  const match = drawn.reduce<MatchLevel>((best, e) => (MATCH_RANK[e.match] > MATCH_RANK[best] ? e.match : best), "none");
  const occ = occurrenceAt(o, inp.t);
  const status = (o.status ?? "").toUpperCase();
  const prio = (o.priority ?? "").toUpperCase();
  const requested = ["SUB", "STDY", "NEG", "RISK"].includes(status);
  const approved = ["AA", "FA"].includes(status);

  let category: RiskCategory = "info";
  let statusText: string;
  let animate: TxRiskItem["animate"] = null;
  if (!oos.length) {
    const kinds = [...new Set(equipment.map((e) => CONSTRAINT_LABEL[(e.constraintType ?? "").toUpperCase()] ?? e.constraintType ?? "not stated"))];
    statusText = `No equipment out of service (${kinds.join("; ")})`;
  } else if (occ.active === false) {
    const start = o.plannedStartUtc ? Date.parse(o.plannedStartUtc) : null;
    const end = o.plannedEndUtc ? Date.parse(o.plannedEndUtc) : null;
    if (end !== null && inp.t >= end) statusText = "Planned end has passed at the selected time";
    else if (start !== null && inp.t < start) {
      statusText = `Starts later (${STATUS_LABEL[status] ?? status})`;
      if (!requested && start > inp.now) category = "future";
    } else statusText = occ.note ?? "Not in effect at the selected time";
  } else if (requested) {
    statusText = `Requested, not approved (${STATUS_LABEL[status] ?? status})`;
  } else if (mode === "current" && occ.active === true && status === "IMPL") {
    category = "outage";
    animate = "flash";
    statusText = `Out of service (IESO status: Implemented${prio === "F" || prio === "FE" ? ", forced" : ""})`;
  } else if (mode === "past") {
    statusText = "Today's outage report cannot confirm status at a past time";
  } else {
    category = "future";
    statusText =
      occ.active === "unknown"
        ? `${STATUS_LABEL[status] ?? status}; in effect at unpublished times within the window`
        : mode === "future"
          ? `Scheduled (${STATUS_LABEL[status] ?? status}); not confirmed for the selected time`
          : approved
            ? `Approved (${STATUS_LABEL[status]}), implementation not yet confirmed`
            : `${STATUS_LABEL[status] ?? status}`;
  }

  const geo = geometryInfo(net, lineIds, stationIds);
  const evidence: Evidence[] = [
    { source: "ieso", text: `Outage request ${o.outageId}: ${PRIORITY_LABEL[prio] ?? o.priority ?? "priority not stated"}, status ${STATUS_LABEL[status] ?? o.status ?? "not stated"}` },
    { source: "ieso", text: `Planned ${o.plannedStartRaw ?? "?"} to ${o.plannedEndRaw ?? "?"} EST, recurrence ${RECURRENCE_LABEL[(o.recurrence ?? "").toUpperCase()] ?? o.recurrence ?? "not stated"}` },
    ...equipment.map((e) => ({ source: "ieso" as const, text: `${e.name} (${e.type ?? "type not stated"}, ${e.rawVoltage ?? "voltage not stated"}): ${CONSTRAINT_LABEL[(e.constraintType ?? "").toUpperCase()] ?? e.constraintType ?? "constraint not stated"}` })),
    ...(occ.note ? [{ source: "app" as const, text: occ.note }] : []),
    ...[...new Set(drawn.map((e) => e._m.note).filter(Boolean))].map((n) => ({ source: "app" as const, text: n })),
  ];
  const lines = oos.filter((e) => e.circuit);
  const implications: string[] = [];
  if (lines.length)
    implications.push(
      `With ${[...new Set(lines.map((e) => e.circuit))].join(", ")} out, its flow moves to parallel paths. Interfaces that include it may carry a reduced operating limit (see restriction records naming it).`,
    );
  if (oos.some((e) => /transformer|bus/i.test(e.type ?? ""))) implications.push("Station transformer or bus outages reduce redundancy at the station; supply or connection capacity there may be limited.");
  const ng = nearby(inp.generation, geo.pts, 20);
  if (ng.length && category === "outage") implications.push(`${ng.length} generating facilit${ng.length === 1 ? "y is" : "ies are"} within 20 km; whether their output is restricted is not published here.`);

  const limitations = [
    "Times are IESO planned times, not actual switching times.",
    "Status is as of the report's publication; IESO updates this report hourly.",
  ];
  if (match === "circuit-section") limitations.push("Only one section of the circuit is out; the highlight covers the whole circuit as mapped in OpenStreetMap.");
  if (match === "none" && oos.length) limitations.push("No verified map geometry for this equipment, so it is listed but not drawn.");

  const kv = Math.max(...(oos.length ? oos : equipment).map((e) => e.voltageKv ?? 0));
  const first = (oos[0] ?? equipment[0])?.name ?? o.outageId;
  const item: TxRiskItem = {
    id: `outage:${o.outageId}`,
    kind: "outage",
    title: first + (equipment.length > 1 ? ` +${equipment.length - 1}` : ""),
    subtitle: `Outage ${o.outageId}`,
    category,
    categoryLabel: CATEGORY_LABEL[category],
    animate,
    activeAtT: occ.active === true,
    statusText,
    region: regionOf(inp.generation, geo.pts),
    voltageKv: kv > 0 ? kv : null,
    startUtc: o.plannedStartUtc,
    endUtc: o.plannedEndUtc,
    startRaw: o.plannedStartRaw,
    endRaw: o.plannedEndRaw,
    outageId: o.outageId,
    priority: o.priority,
    priorityLabel: PRIORITY_LABEL[prio] ?? null,
    recurrence: o.recurrence,
    recurrenceLabel: RECURRENCE_LABEL[(o.recurrence ?? "").toUpperCase()] ?? null,
    requestStatus: o.status,
    requestStatusLabel: STATUS_LABEL[status] ?? null,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    equipment: equipment.map(({ _m, ...e }) => e),
    evidence,
    score: null,
    implications,
    limitations,
    nearbyGeneration: ng,
    match: oos.length ? match : "none",
    matchNote: oos.length ? [...new Set(drawn.map((e) => e._m.note))].join(" · ") : "Not drawn: no equipment out of service",
    lineIds: category === "info" ? [] : lineIds,
    stationIds: category === "info" ? [] : stationIds,
    bbox: geo.bbox,
    sourceUrl: REPORT_URL.outages,
  };
  return { item, oosCircuits: new Set(oos.map((e) => e.circuit).filter((c): c is string => !!c)), confirmed: category === "outage", activeAtT: occ.active === true };
}

export function classify(inp: ClassifyInput): TxRiskItem[] {
  const { t, now, network: net } = inp;
  const mode: "current" | "future" | "past" = Math.abs(t - now) <= CURRENT_TOLERANCE ? "current" : t > now ? "future" : "past";
  const items: TxRiskItem[] = [];

  // --- Outages
  const outageCtx = (inp.outages?.outages ?? []).map((o) => classifyOutage(o, inp, mode));
  items.push(...outageCtx.map((c) => c.item));
  const liveOutages = outageCtx.filter((c) => c.activeAtT && (c.confirmed || (mode === "future" && c.item.category === "future")));

  // --- Limits: union of the 0–2 and 3–34 day reports, identical records counted once.
  const limitRecs = new Map<string, { rec: LimitRecord; src: TxReportKind }>();
  for (const r of inp.limits0to2?.limits ?? []) limitRecs.set(r.id, { rec: r, src: "limits0to2" });
  for (const r of inp.limits3to34?.limits ?? []) if (!limitRecs.has(r.id)) limitRecs.set(r.id, { rec: r, src: "limits3to34" });
  const ais = inp.allInService?.limits ?? [];
  const activeByKey = new Map<string, number>();
  for (const { rec } of limitRecs.values()) if (active(rec.startUtc, rec.endUtc, t)) activeByKey.set(interfaceKey(rec.interfaceName), (activeByKey.get(interfaceKey(rec.interfaceName)) ?? 0) + 1);

  const bindingThrough = inp.bindingDataThroughUtc ? Date.parse(inp.bindingDataThroughUtc) : null;
  const recentBinding = (code: string | null) => {
    if (!code || bindingThrough === null) return [];
    const to = Math.min(t, bindingThrough);
    return inp.binding.filter((b) => b.interfaceCode === code && Date.parse(b.tsUtc) > to - 7 * DAY && Date.parse(b.tsUtc) <= to);
  };

  for (const { rec, src } of limitRecs.values()) {
    const def = findInterface(inp.interfaces, rec.interfaceName);
    const fromComment = equipmentInComment(net, rec.comments);
    const defStations = (def?.stations ?? []).flatMap((s) => findStation(net, s).ids);
    const defLines = (def?.circuits ?? []).flatMap((c) => net.byCircuit.get(c.toUpperCase()) ?? []);
    const lineIds = [...new Set([...defLines, ...fromComment.lineIds])];
    const stationIds = [...new Set([...defStations, ...fromComment.stationIds])];
    const geo = geometryInfo(net, lineIds, stationIds);
    const isActive = active(rec.startUtc, rec.endUtc, t);
    const activeNow = active(rec.startUtc, rec.endUtc, now);
    const startsLater = rec.startUtc !== null && Date.parse(rec.startUtc) > t;

    const base = findBaseline(rec, ais, t);
    const red = reduction(rec.operatingLimitMW, base);
    const evidence: Evidence[] = [
      { source: "ieso", text: `${rec.facilityType ?? ""} interface "${rec.interfaceName}": operating limit ${rec.operatingLimitMW ?? "not stated"} MW from ${rec.startRaw ?? "?"} to ${rec.endRaw ?? "?"} EST` },
      ...(rec.comments ? [{ source: "ieso" as const, text: `IESO comment: ${rec.comments}` }] : []),
      ...(base ? [{ source: "ieso" as const, text: base.note }] : []),
      ...(red ? [{ source: "app" as const, text: `Reduction vs all-in-service: ${fmtRange(red.mw, " MW")} (${fmtRange(red.pct, " %")})` }] : []),
    ];

    let category: RiskCategory = "info";
    let animate: TxRiskItem["animate"] = null;
    let statusText: string;
    let score: TxRiskItem["score"] = null;
    if (!isActive) statusText = startsLater ? "Starts later" : "Ended before the selected time";
    else if (mode === "past") statusText = "In effect (per current report)";
    else if (activeNow) {
      category = "restriction";
      animate = "pulse";
      statusText = "Outage-related limit in effect";
    } else {
      category = "future";
      statusText = "Scheduled limit (starts after now)";
    }
    if (!isActive && startsLater && Date.parse(rec.startUtc!) > now) category = "future";

    const ng = nearby(inp.generation, defStations.map((id) => net.stations.get(id)!).map((s) => [s.lon, s.lat] as [number, number]), 30);
    if (isActive && mode !== "past") {
      const factors: ScoreFactor[] = [];
      if (red) {
        const p = red.pct[0];
        if (p >= 10) factors.push({ label: `Limit ${fmtRange(red.pct, " %")} below all-in-service`, points: 2 });
        else if (p >= 5) factors.push({ label: `Limit ${fmtRange(red.pct, " %")} below all-in-service`, points: 1 });
      }
      const linked = liveOutages.filter(
        (c) =>
          c.item.lineIds.some((id) => lineIds.includes(id)) ||
          c.item.stationIds.some((id) => stationIds.includes(id)) ||
          fromComment.circuits.some((cc) => c.oosCircuits.has(cc.toUpperCase())),
      );
      if (linked.length)
        factors.push({ label: `${linked.length} ${mode === "future" ? "scheduled" : "confirmed"} outage(s) linked to this interface (${linked.map((c) => c.item.outageId).join(", ")})`, points: Math.min(2, linked.length) });
      if ((activeByKey.get(interfaceKey(rec.interfaceName)) ?? 0) > 1) factors.push({ label: "Another outage limit on the same interface at the same time", points: 1 });
      const rb = recentBinding(def?.code ?? null);
      if (rb.length) factors.push({ label: `Constraint on ${def!.code} binding in ${rb.length} hour(s) of the last 7 days of IESO shadow price data`, points: 1 });
      const genMW = ng.reduce((a, g) => a + (g.mw ?? 0), 0);
      if (rec.operatingLimitMW !== null && genMW > 0 && genMW >= rec.operatingLimitMW && ng.length)
        factors.push({ label: `Installed generation within 30 km (${Math.round(genMW)} MW) exceeds the limit (${rec.operatingLimitMW} MW)`, points: 1 });
      const points = factors.reduce((a, f) => a + f.points, 0);
      score = { points, factors };
      if (points >= POTENTIAL_MIN_POINTS && factors.length >= 2) {
        category = "potential";
        animate = mode === "current" || activeNow ? "pulse" : null;
      }
      for (const f of factors) evidence.push({ source: "app", text: `Score +${f.points}: ${f.label}` });
    }

    const implications: string[] = [];
    if (rec.operatingLimitMW !== null)
      implications.push(
        `IESO will keep scheduled transfers on "${rec.interfaceName.trim()}" within ${rec.operatingLimitMW} MW while this limit applies. A published limit does not show that flows actually reach it.`,
      );
    if (ng.length) implications.push(`Generators near the interface stations (${ng.slice(0, 4).map((g) => g.name).join(", ")}${ng.length > 4 ? "…" : ""}) could be held back if transfers would otherwise exceed the limit.`);
    const limitations = [
      "IESO publishes interface limits, not real-time flows on internal interfaces, so utilisation is unknown.",
      ...(def ? [] : ["This interface has no entry in the mapping table (data/transmission/interfaces.json)."]),
      ...(base ? [] : ["No all-in-service record with the same interface name, so no reduction is calculated."]),
      ...(fromComment.unmatched.length ? [`Equipment named in the comment but not on the map: ${fromComment.unmatched.join(", ")}`] : []),
    ];
    const matchParts = [
      defStations.length ? `${defStations.length} interface station(s) from the mapping table (${def?.basis})` : null,
      defLines.length ? `interface circuit(s) ${def?.circuits.join(", ")}` : null,
      fromComment.circuits.length ? `circuit(s) named in the IESO comment: ${fromComment.circuits.join(", ")}` : null,
      fromComment.stationIds.length ? "station named in the IESO comment" : null,
    ].filter(Boolean);
    const drawable = category !== "info";
    items.push({
      id: `limit:${rec.id}`,
      kind: "limit",
      title: rec.interfaceName.trim(),
      subtitle: rec.comments,
      category,
      categoryLabel: category === "potential" ? `${CATEGORY_LABEL.potential} (evidence score ${score!.points})` : CATEGORY_LABEL[category],
      animate,
      activeAtT: isActive,
      statusText,
      region: def?.zones ?? regionOf(inp.generation, geo.pts),
      voltageKv: Math.max(0, ...lineIds.map((id) => net.lines.get(id)?.kv ?? 0)) || null,
      startUtc: rec.startUtc,
      endUtc: rec.endUtc,
      startRaw: rec.startRaw,
      endRaw: rec.endRaw,
      interfaceName: rec.interfaceName.trim(),
      interfaceCode: def?.code ?? null,
      facilityType: rec.facilityType,
      operatingLimitMW: rec.operatingLimitMW,
      baselineMW: base?.values ?? null,
      baselineNote: base?.note ?? null,
      reductionMW: red?.mw ?? null,
      reductionPct: red?.pct ?? null,
      comments: rec.comments,
      issueDateRaw: rec.issueDateRaw,
      sourceReport: src,
      evidence,
      score,
      implications,
      limitations,
      nearbyGeneration: ng,
      match: lineIds.length || stationIds.length ? "interface-stations" : "none",
      matchNote: matchParts.length ? `Drawn: ${matchParts.join("; ")}. Stations mark the interface; no route is drawn between them.` : "No verified geometry for this interface",
      lineIds: drawable ? lineIds : [],
      stationIds: drawable ? stationIds : [],
      bbox: geo.bbox,
      sourceUrl: REPORT_URL[src],
    });
  }

  // --- Binding constraints for the hour containing t (only when the shadow price data covers it).
  if (bindingThrough !== null && t <= bindingThrough) {
    const hourEnd = Math.ceil(t / HOUR) * HOUR;
    for (const b of inp.binding.filter((x) => Date.parse(x.tsUtc) === hourEnd)) {
      const def = b.interfaceCode ? inp.interfaces.find((d) => d.code.toUpperCase() === b.interfaceCode) : null;
      const stationIds = (def?.stations ?? []).flatMap((s) => findStation(net, s).ids);
      const lineIds = (def?.circuits ?? []).flatMap((c) => net.byCircuit.get(c.toUpperCase()) ?? []);
      const geo = geometryInfo(net, lineIds, stationIds);
      items.push({
        id: `binding:${b.constraintName}:${b.tsUtc}`,
        kind: "binding",
        title: b.constraintName,
        subtitle: def ? `Interface ${def.code}` : null,
        category: "binding",
        categoryLabel: CATEGORY_LABEL.binding,
        animate: null,
        activeAtT: true,
        statusText: `Binding in the hour ending ${b.tsUtc} (shadow price ${b.avgShadowPrice ?? "?"} $/MWh)`,
        region: def?.zones ?? null,
        voltageKv: null,
        startUtc: new Date(Date.parse(b.tsUtc) - HOUR).toISOString(),
        endUtc: b.tsUtc,
        startRaw: null,
        endRaw: null,
        constraintName: b.constraintName,
        shadowPrice: b.avgShadowPrice,
        interfaceCode: def?.code ?? null,
        evidence: [
          { source: "ieso", text: `IESO real-time constraint shadow price report: "${b.constraintName}" had a non-zero shadow price (${b.avgShadowPrice} $/MWh average over binding intervals)` },
          ...(def ? [{ source: "app" as const, text: `Constraint name contains interface code ${def.code}` }] : []),
        ],
        score: null,
        implications: ["A binding constraint means the market dispatch was limited by this transmission constraint in that hour."],
        limitations: ["Shadow price reports are published several days after the fact.", ...(def ? [] : ["Constraint not linked to mapped geometry."])],
        nearbyGeneration: [],
        match: lineIds.length || stationIds.length ? "interface-stations" : "none",
        matchNote: def ? `Interface ${def.code} stations/circuits from the mapping table` : "Constraint name not linked to an interface",
        lineIds,
        stationIds,
        bbox: geo.bbox,
        sourceUrl: SHADOW_URL,
      });
    }
  }
  return items;
}
