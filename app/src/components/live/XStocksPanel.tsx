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
import { useEffect, useState, type CSSProperties } from "react";

import type { LiveXStocks } from "@/app/api/live/route";
import s from "@/components/circle/Circle.module.css";
import { formatDuration, shortAddress } from "@/lib/circle";
import { multiplierAt } from "@/lib/scaledUi";

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
    // Only the latest request may write: a slow response must not land after a newer one.
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
        // S2b: "never a stale or made-up number". A failed refresh drops the
        // previous read rather than leaving it under "Multiplier now".
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

  // Circle.dc.html handoff: a quiet reference list, not anyone's holdings (Joshua, T18e).
  const SLOT: Record<string, string> = { SPYx: "teal", NVDAx: "cobalt", AAPLx: "sky", NFLXx: "acid" };
  return (
    <section className={s.section} aria-label="Stocks a circle can accept as cover">
      <div className={s.sectionHead}>
        <span className={s.refTitle}>Stocks a circle can accept as cover</span>
        <span className={s.refChip}>Real, on mainnet · read only</span>
        <span className={s.sectionNote}>
          Reference list. The demo members lock the {mirror.label}; each member&apos;s stake is under Members.
          {data ? ` Mainnet slot ${data.slot.toLocaleString("en-US")}, read ${formatDuration(Date.now() / 1000 - data.readAt)} ago.` : ""}
        </span>
      </div>
      {error ? (
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
        <div className={s.refList}>
          {data.mints
            .filter((m) => m.accepted)
            .map((m) => {
              const slot = SLOT[m.symbol] ?? "raised";
              return (
                <a
                  key={m.address}
                  href={`/assets/${m.symbol}`}
                  className={s.refRow}
                  style={{ "--slot": `var(--${slot})` } as CSSProperties}
                  aria-label={`${m.symbol}, ${m.name}: open its stock page`}
                >
                  <span className={s.refBadge} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)` }} aria-hidden>
                    {m.symbol.slice(0, 2)}
                  </span>
                  <span className={s.refName}>
                    <b>{m.symbol}</b>
                    <span>
                      {m.name} · Mint <u>{shortAddress(m.address)}</u>
                    </span>
                  </span>
                  {/* By this browser's clock at render, not the server's cached moment,
                      so a change that takes effect mid-cache shows at once. */}
                  <span className={s.refFacts}>
                    <span className={s.refFact}>Multiplier now {mult(multiplierAt(m, Date.now() / 1000))}</span>
                    <span className={s.refFact}>Last change: {change(m)}</span>
                  </span>
                  <span className={s.refArrow} aria-hidden>
                    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round">
                      <path d="M7 17 17 7M9 7h8v8" />
                    </svg>
                  </span>
                  {m.symbol === "NFLXx" && (
                    <span className={s.refNote}>
                      The circle above locks the {mirror.label}, now at {mult(mirror.multiplierNow)}. The demo replays
                      this split on it.
                    </span>
                  )}
                </a>
              );
            })}
        </div>
      )}
    </section>
  );
}
