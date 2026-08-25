"use client";

/**
 * Read hooks.
 *
 * Deliberately calm. StudioNet rate-limits, and a dashboard that refetches
 * every second is the fastest way to make a demo look broken — a sibling
 * project spent an afternoon on 429s traced to eager defaults. Nothing here
 * polls faster than 15s, polling pauses when the tab is hidden, and an
 * in-flight request is never stacked on top of another.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { read } from "./genlayer";

export interface ReadState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useRead<T>(
  functionName: string | null,
  args: unknown[] = [],
  pollMs = 0
): ReadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const key = functionName ? `${functionName}:${JSON.stringify(args)}` : null;

  const refresh = useCallback(async () => {
    if (!functionName || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await read<T>(functionName, args);
      setData(result);
      setError(null);
    } catch (e) {
      setError((e as Error).message ?? "Could not read contract state.");
    } finally {
      inFlight.current = false;
    }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!functionName) return;

    // Deferred so the mount fetch never sets state synchronously inside the
    // effect, which React 19 flags as a cascading-render hazard.
    const kickoff = window.setTimeout(() => void refresh(), 0);

    let timer: number | null = null;
    if (pollMs) {
      timer = window.setInterval(() => {
        if (document.visibilityState === "visible") void refresh();
      }, Math.max(15_000, pollMs));
    }

    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      window.clearTimeout(kickoff);
      if (timer) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, pollMs, functionName]);

  // Derived rather than tracked: one less piece of state that can disagree
  // with the data it describes.
  const loading = functionName !== null && data === null && error === null;

  return { data, error, loading, refresh };
}

/**
 * Wall-clock seconds, for countdowns.
 *
 * This is the BROWSER's clock and it is only ever used for display. Every
 * deadline is enforced by the contract against its own consensus clock, so a
 * user with a skewed machine sees a wrong countdown and still cannot act
 * outside a window. The UI must never gate on this value alone.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = window.setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      intervalMs
    );
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}
