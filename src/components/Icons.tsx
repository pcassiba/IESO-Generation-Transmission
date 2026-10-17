"use client";

import { STATUS_LABEL, type OperationalStatus, type Technology } from "@/lib/types";
import { glyphSvg, statusBadgeSvg, TECH_COLOR } from "@/lib/ui";

export function TechIcon({ tech, size = 16, boxed = false }: { tech: Technology; size?: number; boxed?: boolean }) {
  if (boxed) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full"
        style={{ background: TECH_COLOR[tech], width: size + 10, height: size + 10 }}
        dangerouslySetInnerHTML={{ __html: glyphSvg(tech, size, "white") }}
      />
    );
  }
  return <span className="inline-flex shrink-0" dangerouslySetInnerHTML={{ __html: glyphSvg(tech, size, TECH_COLOR[tech]) }} />;
}

export function StatusDot({ status, size = 12 }: { status: OperationalStatus; size?: number }) {
  return <span className="inline-flex shrink-0" title={STATUS_LABEL[status]} dangerouslySetInnerHTML={{ __html: statusBadgeSvg(status, size) }} />;
}

export function StatusBadge({ status, extra }: { status: OperationalStatus; extra?: string }) {
  const tone: Record<OperationalStatus, string> = {
    generating: "bg-green-500/15 text-green-400 ring-green-500/30",
    available: "bg-blue-500/15 text-blue-400 ring-blue-500/30",
    derated: "bg-amber-500/15 text-amber-400 ring-amber-500/30",
    potential_oos: "bg-transparent text-red-400 ring-red-500/60 ring-dashed",
    confirmed_oos: "bg-red-600/25 text-red-300 ring-red-600/50",
    unknown: "bg-slate-500/15 text-slate-400 ring-slate-500/30",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium ring-1 ${tone[status]}`}>
      <StatusDot status={status} size={10} />
      {STATUS_LABEL[status]}
      {extra ? <span className="opacity-75">· {extra}</span> : null}
    </span>
  );
}
