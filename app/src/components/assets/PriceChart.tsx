"use client";

/**
 * One xStock's price history from /api/chart: daily closes from its busiest USDC pool on a Solana
 * DEX (GeckoTerminal), PER RAW TOKEN, beside Jupiter's current price PER DISPLAYED TOKEN. The two
 * differ by the multiplier; the chart says which it shows. A scheduled multiplier change inside
 * the range is marked on the time axis.
 */
import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import type { ChartData } from "@/app/api/chart/route";
import s from "@/components/circle/Circle.module.css";

import { usd, usdShort } from "./AssetsIndex";
import { mult } from "./useLiveXStocks";

const RANGES = [
  { label: "1M", days: 30 },
  { label: "3M", days: 91 },
  { label: "All", days: Infinity },
] as const;

const day = (t: number) => new Date(t * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });

export default function PriceChart({
  symbol,
  multiplierNow,
  change,
}: {
  symbol: string;
  multiplierNow: number;
  change: { from: number; to: number; at: number } | null;
}) {
  const [data, setData] = useState<ChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<(typeof RANGES)[number]["label"]>("3M");

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    fetch(`/api/chart?symbol=${encodeURIComponent(symbol)}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<ChartData | { error: string }>)
      .then((body) => {
        if (!alive) return;
        if ("error" in body) throw new Error(body.error);
        setData(body);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [symbol]);

  const points = useMemo(() => {
    if (!data) return [];
    const days = RANGES.find((r) => r.label === range)!.days;
    const from = Number.isFinite(days) ? data.readAt - days * 86400 : 0;
    return data.candles.filter((c) => c.t >= from).map((c) => ({ t: c.t, close: c.c }));
  }, [data, range]);

  if (error) {
    return (
      <div className={s.chartBox}>
        <span className={s.bannerTitle}>Price history unavailable</span>
        <p className={s.panelNote}>{error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className={s.chartBox}>
        <p className={s.panelNote}>Reading {symbol}&apos;s price history…</p>
      </div>
    );
  }

  const first = points[0]?.close ?? 0;
  const last = points.at(-1)?.close ?? 0;
  const moved = first ? ((last - first) / first) * 100 : 0;
  const thin = data.pool.liquidityUsd < 50_000;
  const marker = change && points.length && change.at >= points[0]!.t && change.at <= points.at(-1)!.t + 86400 ? change : null;

  return (
    <div className={s.chartBox}>
      <div className={s.sectionHead}>
        <span className={s.bannerTitle}>
          {usd(last)} per raw token{" "}
          <span className={`${s.tag} ${moved >= 0 ? s.tagYes : s.tagGone}`}>
            {moved >= 0 ? "+" : ""}
            {moved.toFixed(1)}% · {range}
          </span>
        </span>
        <span className={s.ranges} role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r.label} type="button" className={`${s.stateLink} ${range === r.label ? s.rangeOn : ""}`} aria-pressed={range === r.label} onClick={() => setRange(r.label)}>
              {r.label}
            </button>
          ))}
        </span>
      </div>

      <div className={s.chartArea}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={day} tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--line)" minTickGap={40} />
            <YAxis dataKey="close" domain={["auto", "auto"]} tickFormatter={(v: number) => `$${v.toFixed(0)}`} tick={{ fontSize: 11, fill: "var(--muted)" }} stroke="var(--line)" width={56} />
            <Tooltip
              formatter={(v) => [usd(Number(v)), "Close, per raw token"]}
              labelFormatter={(t) => day(Number(t))}
              contentStyle={{ border: "3px solid #0B0B0B", borderRadius: 14, fontWeight: 700 }}
            />
            {marker && <ReferenceLine x={marker.at} stroke="var(--line)" strokeDasharray="4 3" label={{ value: `${mult(marker.from)} to ${mult(marker.to)}`, position: "insideTopLeft", fontSize: 11, fontWeight: 800 }} />}
            <Area type="monotone" dataKey="close" stroke="var(--line)" strokeWidth={2.5} fill="var(--sky)" fillOpacity={0.55} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <p className={s.panelNote}>
        Daily closes per raw token (before the multiplier) from the {data.pool.name} pool on a Solana DEX, via GeckoTerminal;
        pool size {usdShort(data.pool.liquidityUsd)}.{thin ? " A thin pool: its price moves on small trades." : ""}{" "}
        {data.displayed
          ? `Jupiter prices it at ${usd(data.displayed.usdPrice)} per token as wallets show it${data.displayed.stockPrice ? `, and the underlying share at ${usd(data.displayed.stockPrice)}` : ""}.`
          : "Jupiter's current price is unavailable."}{" "}
        {Math.abs(multiplierNow - 1) > 1e-9 ? `The two differ by the multiplier, ${mult(multiplierNow)}.` : ""}
        {change && !marker ? ` The ${mult(change.from)} to ${mult(change.to)} change on ${day(change.at)} is outside this pool's history.` : ""}
      </p>
    </div>
  );
}
