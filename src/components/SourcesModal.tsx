"use client";

import { useEffect, useState } from "react";
import type { SourceEntry, SourcesResponse } from "@/lib/sources";
import { formatOntario, hourEndingLabel } from "@/lib/time";
import { Modal } from "./Modals";

const link = "break-all text-sky-400 hover:underline";

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <tr className="align-top">
      <td className="w-36 py-0.5 pr-2 text-[var(--muted)]">{k}</td>
      <td className="py-0.5">{children}</td>
    </tr>
  );
}

function Entry({ e }: { e: SourceEntry }) {
  const hour = e.hourTsUtc ? `${hourEndingLabel(e.hourTsUtc)} (${formatOntario(e.hourTsUtc)})` : e.deliveryDate ? `Delivery date ${e.deliveryDate}` : null;
  return (
    <section className="rounded border border-[var(--border)] p-3">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{e.dataset}</h3>
        <span className="text-[10px] text-[var(--muted)]">{e.shownIn}</span>
      </div>
      <table className="w-full">
        <tbody>
          <Row k="Report">
            <a className={link} href={e.reportUrl} target="_blank" rel="noreferrer">
              {e.report}
            </a>
          </Row>
          {hour && (
            <Row k="Hour shown">
              <span className="font-mono">{hour}</span>
              {e.complete === false && <span className="ml-2 text-amber-300">partial hour (fewer than 12 intervals published yet)</span>}
            </Row>
          )}
          {e.archiveUrl && (
            <Row k="File to check">
              <a className={`${link} font-mono`} href={e.archiveUrl} target="_blank" rel="noreferrer">
                {e.archiveUrl}
              </a>
            </Row>
          )}
          {e.fileUrl && e.fileUrl !== e.archiveUrl && (
            <Row k="File the app read">
              <a className={`${link} font-mono`} href={e.fileUrl} target="_blank" rel="noreferrer">
                {e.fileUrl}
              </a>
            </Row>
          )}
          {e.publishedEst && (
            <Row k="IESO created at">
              <span className="font-mono">{e.publishedEst.replace(/ EST$/, "").replace("T", " ")} EST</span>
            </Row>
          )}
          <Row k={e.id === "transmission-map" ? "Downloaded" : "Downloaded by app"}>{e.fetchedAtUtc ? formatOntario(e.fetchedAtUtc, { seconds: true }) : "—"}</Row>
          <Row k="How to check">{e.howToCheck}</Row>
          {e.examples.length > 0 && (
            <Row k="Values shown">
              <ul>
                {e.examples.map((x) => (
                  <li key={x.label}>
                    <span className="font-mono">{x.label}</span>: {x.value}
                  </li>
                ))}
              </ul>
            </Row>
          )}
          {e.note && (
            <Row k="Note">
              <span className="text-amber-300">{e.note}</span>
            </Row>
          )}
        </tbody>
      </table>
    </section>
  );
}

/** Which IESO report, file and hour each dataset on screen comes from, so it can be checked at the source. */
export function SourcesModal({ ts, onClose }: { ts: string | null; onClose: () => void }) {
  const [data, setData] = useState<SourcesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/sources${ts ? `?ts=${encodeURIComponent(ts)}` : ""}`, { cache: "no-store" })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        if (!cancelled) setData(j);
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [ts]);

  return (
    <Modal title="Data sources" onClose={onClose}>
      <p className="mb-3">
        For the hour on screen ({ts ? hourEndingLabel(ts) : "latest"}), each dataset with the IESO report and the exact file it came from. IESO hours are <b>hour ending, Eastern Standard
        Time</b> all year (HE 14 EST = 13:00–14:00 EST, which is 14:00–15:00 EDT in summer). Prices are averages of the 12 five-minute intervals in the hour.
      </p>
      {error && <p className="text-red-300">Could not load data sources: {error}</p>}
      {!data && !error && <p className="text-[var(--muted)]">Loading…</p>}
      {data && (
        <div className="space-y-2">
          {data.entries.map((e) => (
            <Entry key={e.id} e={e} />
          ))}
        </div>
      )}
    </Modal>
  );
}
