"use client";

/**
 * The four real xStocks from /api/live (one cached mainnet read, shared).
 * A failed read clears the data: S2b, "never a stale or made-up number".
 */
import { useEffect, useState } from "react";

import type { LiveXStocks } from "@/app/api/live/route";

const REFRESH_MS = 60_000;

export function useLiveXStocks(): { data: LiveXStocks | null; error: string | null } {
  const [data, setData] = useState<LiveXStocks | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // T18 adversary: a slow response must not land after a newer one. Only
    // the latest request may write what the page shows.
    let latest = 0;
    const load = async () => {
      const mine = ++latest;
      try {
        const res = await fetch("/api/live", { cache: "no-store" });
        const body = (await res.json()) as LiveXStocks | { error: string };
        if (!alive || mine !== latest) return;
        if ("error" in body) throw new Error(body.error);
        setData(body);
        setError(null);
      } catch (e) {
        if (alive && mine === latest) {
          setData(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    };
    void load();
    const id = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  return { data, error };
}

/** Up to 4 decimals, trailing zeros dropped: x10, x1.0033. The exact f64 is on the mint. */
export function mult(x: number): string {
  return `x${Number(x.toFixed(4))}`;
}

export function when(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** A raw u64 supply in whole tokens, times a multiplier when given (what wallets display). */
export function tokens(raw: string, decimals: number, multiplier = 1): string {
  const whole = (Number(BigInt(raw)) / 10 ** decimals) * multiplier;
  return whole.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * A raw u64 supply in whole tokens, EXACTLY: every digit of the on-chain integer, split at the
 * mint's decimals with string arithmetic, so nothing is rounded (Codex T18 r2: "Supply, raw" was
 * a rounded decimal). 15505685531324 at 8 decimals -> "155,056.85531324".
 */
export function exactTokens(raw: string, decimals: number): string {
  const digits = BigInt(raw).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = decimals ? digits.slice(digits.length - decimals) : "";
  return frac ? `${whole}.${frac}` : whole;
}
