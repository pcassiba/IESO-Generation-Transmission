"use client";

import { useCallback, useEffect, useState } from "react";
import type { TxRiskResponse } from "@/lib/txrisk/types";
import type { HorizonPreset } from "@/lib/txrisk/ui";

/** State and data loading for the outages & congestion risk layer. */
export function useTxRisk() {
  const [enabled, setEnabled] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [flashing, setFlashing] = useState(true);
  const [preset, setPreset] = useState<HorizonPreset>("current");
  const [tUtc, setT] = useState<string | null>(null);
  const [data, setData] = useState<TxRiskResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Respect the OS "reduce motion" setting: flashing starts off and stays static while it is set.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      setReducedMotion(mq.matches);
      if (mq.matches) setFlashing(false);
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const h = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/txrisk${tUtc ? `?t=${encodeURIComponent(tUtc)}` : ""}`, { cache: "no-store" });
        const j = await res.json();
        if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);
        if (!cancelled) {
          setData(j);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(h);
    };
  }, [enabled, tUtc, tick]);

  // In the current view, re-read every 5 minutes (the server re-checks IESO on each report's own cadence).
  useEffect(() => {
    if (!enabled || tUtc) return;
    const i = setInterval(() => setTick((x) => x + 1), 5 * 60_000);
    return () => clearInterval(i);
  }, [enabled, tUtc]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const r = await fetch("/api/txrisk", { method: "POST" });
      const j = await r.json();
      setRefreshMsg(j.ok ? "IESO reports re-checked." : (j.message ?? "Refresh failed"));
      setTick((x) => x + 1);
    } catch (e) {
      setRefreshMsg(String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  return { enabled, setEnabled, flashing, setFlashing, reducedMotion, preset, setPreset, tUtc, setT, data, error, loading, selectedId, setSelectedId, refresh, refreshing, refreshMsg };
}
