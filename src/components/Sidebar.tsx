"use client";

import { ChevronDown, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { FacilityState, OperationalStatus, Technology } from "@/lib/types";
import { STATUSES, STATUS_LABEL, TECHNOLOGIES, TECHNOLOGY_LABEL } from "@/lib/types";
import { REGIONS, fmtMW } from "@/lib/ui";
import { StatusDot, TechIcon } from "./Icons";

export interface Filters {
  query: string;
  techs: Set<Technology>;
  statuses: Set<OperationalStatus>;
  operator: string;
  region: string;
  minCapacity: number;
  minOutput: number;
  includeUnplotted: boolean;
}

export const defaultFilters = (): Filters => ({
  query: "",
  techs: new Set(TECHNOLOGIES),
  statuses: new Set(STATUSES),
  operator: "all",
  region: "all",
  minCapacity: 0,
  minOutput: 0,
  includeUnplotted: true,
});

export function matchesQuery(f: FacilityState, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return (
    f.name.toLowerCase().includes(s) ||
    f.id.includes(s) ||
    (f.municipality ?? "").toLowerCase().includes(s) ||
    (f.operator ?? "").toLowerCase().includes(s) ||
    f.resources.some((r) => r.ieso.toLowerCase().includes(s))
  );
}

export function applyFilters(list: FacilityState[], fl: Filters): FacilityState[] {
  return list.filter(
    (f) =>
      fl.techs.has(f.technology) &&
      fl.statuses.has(f.status) &&
      (fl.operator === "all" || (f.operator ?? "Not verified") === fl.operator) &&
      (fl.region === "all" || f.region === fl.region) &&
      (fl.minCapacity <= 0 || (f.installedCapacityMW ?? 0) >= fl.minCapacity) &&
      (fl.minOutput <= 0 || (f.outputMW ?? 0) >= fl.minOutput) &&
      matchesQuery(f, fl.query),
  );
}

function Section({ title, children, defaultOpen = true, right }: { title: string; children: React.ReactNode; defaultOpen?: boolean; right?: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-[var(--border)]">
      <div className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">
        <button className="flex items-center gap-1 hover:text-[var(--fg)]" onClick={() => setOpen((o) => !o)}>
          <ChevronDown size={12} className={open ? "" : "-rotate-90"} /> {title}
        </button>
        {right}
      </div>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

export default function Sidebar({
  all,
  filtered,
  filters,
  setFilters,
  onPick,
  collapsed,
  setCollapsed,
}: {
  all: FacilityState[];
  filtered: FacilityState[];
  filters: Filters;
  setFilters: (f: Filters) => void;
  onPick: (id: string) => void;
  collapsed: boolean;
  setCollapsed: (c: boolean) => void;
}) {
  const operators = useMemo(() => [...new Set(all.map((f) => f.operator ?? "Not verified"))].sort(), [all]);
  const techCounts = useMemo(() => {
    const m = new Map<Technology, number>();
    for (const f of all) m.set(f.technology, (m.get(f.technology) ?? 0) + 1);
    return m;
  }, [all]);
  const statusCounts = useMemo(() => {
    const m = new Map<OperationalStatus, number>();
    for (const f of all) m.set(f.status, (m.get(f.status) ?? 0) + 1);
    return m;
  }, [all]);
  const results = useMemo(() => (filters.query ? all.filter((f) => matchesQuery(f, filters.query)).slice(0, 12) : []), [all, filters.query]);

  const toggle = <T,>(set: Set<T>, v: T, only = false): Set<T> => {
    if (only) return new Set([v]);
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    return n;
  };

  if (collapsed) {
    return (
      <aside className="flex w-9 shrink-0 flex-col items-center border-r border-[var(--border)] bg-[var(--panel)] pt-2">
        <button onClick={() => setCollapsed(false)} className="rounded p-1 text-[var(--muted)] hover:bg-white/10" title="Expand filters">
          <ChevronRight size={16} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex w-[290px] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel)] text-xs">
      <div className="flex items-center gap-2 border-b border-[var(--border)] p-2">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--muted)]" />
          <input
            value={filters.query}
            onChange={(e) => setFilters({ ...filters, query: e.target.value })}
            placeholder="Search facility or IESO resource ID…"
            className="w-full rounded border border-[var(--border)] bg-[var(--bg)] py-1.5 pl-7 pr-2 outline-none focus:border-sky-500"
          />
          {results.length > 0 && (
            <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded border border-[var(--border)] bg-[var(--panel)] shadow-xl">
              {results.map((f) => (
                <button key={f.id} onClick={() => onPick(f.id)} className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-white/5">
                  <TechIcon tech={f.technology} size={13} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{f.name}</span>
                    <span className="block truncate font-mono text-[10px] text-[var(--muted)]">{f.resources.map((r) => r.ieso).join(", ")}</span>
                  </span>
                  <StatusDot status={f.status} size={10} />
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => setCollapsed(true)} className="rounded p-1 text-[var(--muted)] hover:bg-white/10" title="Collapse">
          <ChevronLeft size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <Section
          title="Generation type"
          right={
            <button className="text-[10px] normal-case text-sky-400 hover:underline" onClick={() => setFilters({ ...filters, techs: new Set(TECHNOLOGIES) })}>
              all
            </button>
          }
        >
          <div className="grid grid-cols-1 gap-0.5">
            {TECHNOLOGIES.map((t) => (
              <label key={t} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-white/5" onDoubleClick={() => setFilters({ ...filters, techs: toggle(filters.techs, t, true) })}>
                <input type="checkbox" checked={filters.techs.has(t)} onChange={() => setFilters({ ...filters, techs: toggle(filters.techs, t) })} className="accent-sky-500" />
                <TechIcon tech={t} size={14} />
                <span className="flex-1">{TECHNOLOGY_LABEL[t]}</span>
                <span className="tabular-nums text-[var(--muted)]">{techCounts.get(t) ?? 0}</span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-[var(--muted)]">Double-click a type to show only that type.</p>
        </Section>

        <Section
          title="Operational status"
          right={
            <button className="text-[10px] normal-case text-sky-400 hover:underline" onClick={() => setFilters({ ...filters, statuses: new Set(STATUSES) })}>
              all
            </button>
          }
        >
          {STATUSES.map((s) => (
            <label key={s} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-white/5" onDoubleClick={() => setFilters({ ...filters, statuses: toggle(filters.statuses, s, true) })}>
              <input type="checkbox" checked={filters.statuses.has(s)} onChange={() => setFilters({ ...filters, statuses: toggle(filters.statuses, s) })} className="accent-sky-500" />
              <StatusDot status={s} size={11} />
              <span className="flex-1">{STATUS_LABEL[s]}</span>
              <span className="tabular-nums text-[var(--muted)]">{statusCounts.get(s) ?? 0}</span>
            </label>
          ))}
        </Section>

        <Section title="Other filters">
          <div className="space-y-2">
            <label className="block">
              <span className="text-[var(--muted)]">Operator</span>
              <select value={filters.operator} onChange={(e) => setFilters({ ...filters, operator: e.target.value })} className="mt-0.5 w-full rounded border border-[var(--border)] bg-[var(--bg)] p-1">
                <option value="all">All operators</option>
                {operators.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-[var(--muted)]">Region (IESO zone)</span>
              <select value={filters.region} onChange={(e) => setFilters({ ...filters, region: e.target.value })} className="mt-0.5 w-full rounded border border-[var(--border)] bg-[var(--bg)] p-1">
                <option value="all">All regions</option>
                {REGIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="flex justify-between text-[var(--muted)]">
                Min. installed capacity <b className="text-[var(--fg)]">{filters.minCapacity} MW</b>
              </span>
              <input type="range" min={0} max={1000} step={10} value={filters.minCapacity} onChange={(e) => setFilters({ ...filters, minCapacity: +e.target.value })} className="w-full accent-sky-500" />
            </label>
            <label className="block">
              <span className="flex justify-between text-[var(--muted)]">
                Min. reported output <b className="text-[var(--fg)]">{filters.minOutput} MW</b>
              </span>
              <input type="range" min={0} max={1000} step={5} value={filters.minOutput} onChange={(e) => setFilters({ ...filters, minOutput: +e.target.value })} className="w-full accent-sky-500" />
            </label>
            <button onClick={() => setFilters(defaultFilters())} className="w-full rounded border border-[var(--border)] py-1 hover:bg-white/5">
              Reset all filters
            </button>
          </div>
        </Section>

        <Section title={`Facilities (${filtered.length})`} defaultOpen={false}>
          <div className="max-h-80 space-y-0.5 overflow-y-auto">
            {[...filtered]
              .sort((a, b) => (b.outputMW ?? -1) - (a.outputMW ?? -1))
              .map((f) => (
                <button key={f.id} onClick={() => onPick(f.id)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-white/5">
                  <TechIcon tech={f.technology} size={12} />
                  <span className="min-w-0 flex-1 truncate">
                    {f.name}
                    {f.lat === null ? <span className="ml-1 text-[10px] text-amber-400">(not plotted)</span> : null}
                  </span>
                  <span className="font-mono tabular-nums text-[var(--muted)]">{fmtMW(f.outputMW)}</span>
                  <StatusDot status={f.status} size={10} />
                </button>
              ))}
          </div>
        </Section>
      </div>
    </aside>
  );
}
