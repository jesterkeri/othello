"use client";

/**
 * S2b: the four real xStocks, read from mainnet through /api/live, beside the
 * devnet circle. Each is identified by its mint address (ADR-012) and links to
 * it on the mainnet explorer. NFLXx sits next to its devnet mirror so the split
 * the demo replays is visibly the real one.
 *
 * On failure it says so and shows no number (PREFLIGHT: "/api/live failure
 * shows Live data unavailable, never breaks the page").
 */
import { useEffect, useState } from "react";

import type { LiveXStocks } from "@/app/api/live/route";
import s from "@/components/circle/Circle.module.css";
import { explorer } from "@/lib/devnet";
import { formatDuration, shortAddress } from "@/lib/circle";

const REFRESH_MS = 60_000;

/** Up to 4 decimals, trailing zeros dropped: x10, x1.0033. The exact f64 is on the mint. */
function mult(x: number): string {
  return `x${Number(x.toFixed(4))}`;
}

function change(m: { multiplier: number; newMultiplier: number; effectiveAt: number }): string {
  if (!m.effectiveAt || m.newMultiplier === m.multiplier) return "None scheduled";
  const when = new Date(m.effectiveAt * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return `${mult(m.multiplier)} to ${mult(m.newMultiplier)}, ${m.effectiveAt * 1000 <= Date.now() ? "took effect" : "takes effect"} ${when}`;
}

export default function XStocksPanel({ mirror }: { mirror: { multiplierNow: number; label: string } }) {
  const [data, setData] = useState<LiveXStocks | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/live", { cache: "no-store" });
        const body = (await res.json()) as LiveXStocks | { error: string };
        if (!alive) return;
        if ("error" in body) throw new Error(body.error);
        setData(body);
        setError(null);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const id = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  return (
    <div className={s.section}>
      <div className={s.sectionHead}>
        <span className={s.sectionLabel}>Real xStocks, read from mainnet</span>
        <span className={s.sectionLabel}>
          {data ? `slot ${data.slot.toLocaleString("en-US")}, ${formatDuration(Date.now() / 1000 - data.readAt)} ago` : ""}
        </span>
      </div>
      {error && !data ? (
        <div className={`${s.banner} ${s.bannerRefusal}`} role="status">
          <span className={s.bannerMark} aria-hidden>?</span>
          <span className={s.bannerBody}>
            <span className={s.bannerTitle}>Live data unavailable</span>
            <p className={s.bannerText}>{error}</p>
          </span>
        </div>
      ) : !data ? (
        <p className={s.panelNote}>Reading mainnet…</p>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">xStock</th>
                <th scope="col">Mint (mainnet)</th>
                <th scope="col">Multiplier now</th>
                <th scope="col">Last scheduled change</th>
              </tr>
            </thead>
            <tbody>
              {data.mints.map((m) => (
                <tr key={m.address}>
                  <td>
                    <span className={s.seatName}>
                      <span>{m.symbol}</span>
                      <span className={s.seatAddr}>{m.name}</span>
                    </span>
                  </td>
                  <td>
                    <a className={s.link} href={explorer("address", m.address, "mainnet")} target="_blank" rel="noreferrer">
                      {shortAddress(m.address)}
                    </a>
                  </td>
                  <td className={s.num}>{mult(m.multiplierNow)}</td>
                  <td>
                    {change(m)}
                    {m.symbol === "NFLXx" && (
                      <p className={s.panelNote}>
                        The circle above locks the {mirror.label}, now at {mult(mirror.multiplierNow)}. The demo
                        replays this split on it.
                      </p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {error && data && <p className={s.panelNote}>Last refresh failed ({error}); showing the previous read.</p>}
    </div>
  );
}
