import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { ReportParseError } from "../ieso/parser";
import { parseIesoEst } from "../time";
import type { LimitRecord, OutageEquipment, OutageRecord, ParsedLimits, ParsedOutages, TxReportHeader } from "./types";

/**
 * Parsers for the IESO transmission outage and limits reports. Schemas were read from the live
 * files published 2026-10-17 (all use the default namespace http://www.ieso.ca/schema, no prefixes,
 * and an <?xml-stylesheet?> instruction before the root):
 *
 *  TxOutagesTodayAll (hourly)
 *    Document[@docID] > DocHeader > { DocTitle, DocRevision, DocConfidentiality > DocConfClass, CreatedAt }
 *    Document > DocBody > { OutageRangeStart, OutageRangeEnd, OutageRequest* }
 *    OutageRequest > { OutageID, PlannedStart, PlannedEnd, Priority, Recurrence,
 *                      EquipmentRequested* { EquipmentName, EquipmentType, EquipmentVoltage, ConstraintType },
 *                      EquipmentRecallTime, OutageRequestStatus }
 *
 *  TxLimitsOutage0to2Days, TxLimitsOutage3to34Days, TxLimitsAllInService0to34Days
 *    Document > DocBody > { DateRangeStart, DateRangeEnd, TransmissionFacilityData* }
 *    TransmissionFacilityData > { TransmissionFacility ("Internal" | "Intertie"),
 *                                 InterfaceData* { InterfaceName, IssueDate, StartDate, EndDate, OperatingLimit, Comments } }
 *
 * Timestamps carry no offset; like every IESO market report they are Eastern Standard Time
 * all year. The raw text is kept and a UTC value is derived with the fixed −5 h offset.
 * Not published (so never shown): outage station lists as separate fields (stations appear only
 * inside EquipmentName), actual outage start/end, interchange scheduling limits, flows.
 */

const ARRAY_TAGS = new Set(["OutageRequest", "EquipmentRequested", "TransmissionFacilityData", "InterfaceData"]);

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

type Node = Record<string, unknown>;

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object") {
    const t = (v as Node)["#text"];
    return t === undefined ? null : String(t).replace(/\s+/g, " ").trim() || null;
  }
  const s = String(v).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
};

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function parseDoc(body: string, expectedDocId: string): { root: Node; docBody: Node; header: TxReportHeader } {
  if (!body || typeof body !== "string") throw new ReportParseError("Empty report body");
  if (/^\s*<!doctype html|^\s*<html/i.test(body)) throw new ReportParseError("Received an HTML page instead of XML");
  let doc: Node;
  try {
    doc = xml.parse(body);
  } catch (e) {
    throw new ReportParseError(`XML parse failure: ${(e as Error).message}`);
  }
  const root = doc.Document as Node | undefined;
  if (!root) throw new ReportParseError("Missing <Document> root element");
  const docId = str(root["@_docID"]);
  if (docId && docId !== expectedDocId) throw new ReportParseError(`Unexpected report: docID "${docId}", expected "${expectedDocId}"`);
  const docBody = root.DocBody as Node | undefined;
  if (!docBody) throw new ReportParseError("Missing Document/DocBody");
  const h = (root.DocHeader ?? {}) as Node;
  const createdAtRaw = str(h.CreatedAt);
  return {
    root,
    docBody,
    header: { docId: docId ?? expectedDocId, title: str(h.DocTitle), createdAtRaw, createdAtUtc: parseIesoEst(createdAtRaw) },
  };
}

function checkedTime(raw: string | null, label: string, warnings: string[]): string | null {
  if (raw === null) return null;
  if (!DATETIME.test(raw)) {
    warnings.push(`${label}: unrecognised timestamp "${raw}"`);
    return null;
  }
  return parseIesoEst(raw);
}

/** "230 kV" → 230. "NULL", "LT" or anything else → null. */
export function parseKv(raw: string | null): number | null {
  if (!raw) return null;
  const m = /^(\d+(?:\.\d+)?)\s*kV$/i.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

export function parseTxOutages(body: string): ParsedOutages {
  const { docBody, header } = parseDoc(body, "TxOutagesTodayAll");
  const warnings: string[] = [];
  const byId = new Map<string, OutageRecord>();
  for (const r of (docBody.OutageRequest as Node[] | undefined) ?? []) {
    const outageId = str(r.OutageID);
    if (!outageId) {
      warnings.push("Outage request without OutageID skipped");
      continue;
    }
    const equipment: OutageEquipment[] = [];
    for (const e of (r.EquipmentRequested as Node[] | undefined) ?? []) {
      const name = str(e.EquipmentName);
      if (!name) continue;
      const rawVoltage = str(e.EquipmentVoltage);
      const voltageKv = parseKv(rawVoltage);
      if (rawVoltage && voltageKv === null && !/^(NULL|LT)$/i.test(rawVoltage)) warnings.push(`${outageId}: unrecognised voltage "${rawVoltage}"`);
      equipment.push({ name, type: str(e.EquipmentType), voltageKv, rawVoltage, constraintType: str(e.ConstraintType) });
    }
    const rec: OutageRecord = {
      outageId,
      plannedStartRaw: str(r.PlannedStart),
      plannedEndRaw: str(r.PlannedEnd),
      plannedStartUtc: null,
      plannedEndUtc: null,
      priority: str(r.Priority),
      recurrence: str(r.Recurrence),
      recallTime: str(r.EquipmentRecallTime),
      status: str(r.OutageRequestStatus),
      equipment,
    };
    rec.plannedStartUtc = checkedTime(rec.plannedStartRaw, `${outageId} PlannedStart`, warnings);
    rec.plannedEndUtc = checkedTime(rec.plannedEndRaw, `${outageId} PlannedEnd`, warnings);
    const prev = byId.get(outageId);
    if (!prev) {
      byId.set(outageId, rec);
      continue;
    }
    // Same OutageID twice: keep one record, merge equipment, and flag any disagreement.
    for (const k of ["plannedStartRaw", "plannedEndRaw", "priority", "recurrence", "status"] as const) {
      if (prev[k] !== rec[k]) warnings.push(`${outageId}: duplicate OutageID with different ${k} ("${prev[k]}" vs "${rec[k]}"); first kept`);
    }
    const seen = new Set(prev.equipment.map((e) => e.name));
    for (const e of rec.equipment) if (!seen.has(e.name)) prev.equipment.push(e);
    warnings.push(`${outageId}: duplicate OutageID merged`);
  }
  return { header, rangeStartRaw: str(docBody.OutageRangeStart), rangeEndRaw: str(docBody.OutageRangeEnd), outages: [...byId.values()], warnings };
}

export function limitId(facilityType: string | null, name: string, startRaw: string | null, endRaw: string | null, limit: number | null, comments: string | null): string {
  return crypto
    .createHash("sha1")
    .update([facilityType, name, startRaw, endRaw, limit, comments].map((x) => String(x ?? "")).join("|"))
    .digest("hex")
    .slice(0, 12);
}

export function parseTxLimits(body: string, expectedDocId: string): ParsedLimits {
  const { docBody, header } = parseDoc(body, expectedDocId);
  const warnings: string[] = [];
  const out = new Map<string, LimitRecord>();
  for (const fd of (docBody.TransmissionFacilityData as Node[] | undefined) ?? []) {
    const facilityType = str(fd.TransmissionFacility);
    for (const d of (fd.InterfaceData as Node[] | undefined) ?? []) {
      const interfaceName = str(d.InterfaceName);
      if (!interfaceName) {
        warnings.push("Interface record without InterfaceName skipped");
        continue;
      }
      const rawLimit = str(d.OperatingLimit);
      let operatingLimitMW: number | null = null;
      if (rawLimit !== null) {
        if (/^-?\d+(\.\d+)?$/.test(rawLimit) && Number(rawLimit) >= 0) operatingLimitMW = Number(rawLimit);
        else warnings.push(`${interfaceName}: invalid OperatingLimit "${rawLimit}"`);
      }
      const startRaw = str(d.StartDate);
      const endRaw = str(d.EndDate);
      const comments = str(d.Comments);
      const id = limitId(facilityType, interfaceName, startRaw, endRaw, operatingLimitMW, comments);
      if (out.has(id)) {
        warnings.push(`${interfaceName}: identical record listed twice; deduplicated`);
        continue;
      }
      out.set(id, {
        id,
        facilityType,
        interfaceName,
        issueDateRaw: str(d.IssueDate),
        startRaw,
        endRaw,
        startUtc: checkedTime(startRaw, `${interfaceName} StartDate`, warnings),
        endUtc: checkedTime(endRaw, `${interfaceName} EndDate`, warnings),
        operatingLimitMW,
        comments,
      });
    }
  }
  return { header, dateRangeStart: str(docBody.DateRangeStart), dateRangeEnd: str(docBody.DateRangeEnd), limits: [...out.values()], warnings };
}
