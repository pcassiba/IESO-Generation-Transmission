"use client";

import { useEffect, useState } from "react";

/** Minutes without mouse, touch or keyboard input after which auto-refresh pauses. */
export const IDLE_MINUTES = 30;

/**
 * True while someone is actually looking at the page: the tab is visible and there has been
 * input in the last IDLE_MINUTES. Auto-refresh timers use it so a forgotten or background tab
 * stops querying the database, which lets a serverless Postgres (Neon) suspend and stop
 * using compute hours. Flips back to true (and callers refresh) as soon as the person returns.
 */
export function useActiveViewer(idleMinutes = IDLE_MINUTES): boolean {
  const [visible, setVisible] = useState(true);
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), idleMinutes * 60_000);
    };
    const onInput = () => {
      setIdle(false);
      // Mouse moves fire constantly; re-arm the timer at most every few seconds.
      const now = Date.now();
      if (now - last < 5_000) return;
      last = now;
      arm();
    };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"] as const;
    for (const e of events) window.addEventListener(e, onInput, { passive: true });
    arm();
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, onInput);
    };
  }, [idleMinutes]);

  return visible && !idle;
}
