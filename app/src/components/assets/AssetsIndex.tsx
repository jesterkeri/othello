"use client";

/**
 * /assets: every buyable xStock (lib/xstocks.ts), read live from mainnet. Stocks.dc.html "Market
 * board" (Claude Design): the four a circle accepts as cover (the program's allowlist) as big
 * pinned cards, then the rest as rows you can sort. Every price is Jupiter's, per token as wallets
 * show it; a mint that could not be read says so and shows no number.
 */
import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties } from "react";

import type { LiveXStock } from "@/app/api/live/route";
import { multiplierAt } from "@/lib/scaledUi";

import AssetShell, { Unavailable } from "./Shell";
import s from "./AssetsIndex.module.css";
import { useLiveXStocks } from "./useLiveXStocks";

export function usd(n: number, dp = 2): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export function usdShort(n: number): string {
  return n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`;
}

/** Each accepted stock's colour, as on the circle page; the rest cycle through the palette. */
const COVER_SLOT: Record<string, string> = { SPYx: "teal", NVDAx: "cobalt", AAPLx: "sky", NFLXx: "acid" };
const SLOTS = ["clay", "sky", "teal", "cobalt", "acid"] as const;
const SORTS = ["Liquidity", "Price", "24h change"] as const;
type Sort = (typeof SORTS)[number];
const VIEWS = ["List", "Grid"] as const;
type View = (typeof VIEWS)[number];
const VIEW_KEY = "othello.assets.view";

function Change({ c }: { c: number | null | undefined }) {
  if (c === null || c === undefined) return null;
  return (
    <span className={s.chg} style={{ background: `var(--${c >= 0 ? "teal" : "clay"})`, color: `var(--${c >= 0 ? "teal" : "clay"}Ink)` }}>
      {c >= 0 ? "+" : "−"}{Math.abs(c).toFixed(2)}%
    </span>
  );
}

const Arrow = () => (
  <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 17 17 7M9 7h8v8" />
  </svg>
);

function CoverCard({ m, i, now }: { m: LiveXStock; i: number; now: number }) {
  const slot = COVER_SLOT[m.symbol] ?? "raised";
  const liq = m.market?.liquidity ?? null;
  return (
    <Link href={`/assets/${m.symbol}`} className={s.cover} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)`, animationDelay: `${i * 0.06}s` }}>
      <span aria-hidden className={s.glint} />
      <span aria-hidden className={s.rings}><span /></span>
      <span className={s.coverTop}>
        <span className={s.coverName}>{m.info.metadata?.name ?? m.name}</span>
        <span className={s.coverTag}>Cover</span>
      </span>
      <b className={s.coverSym}>{m.symbol}</b>
      <span className={s.coverPrice}>
        {m.market ? (
          <>
            <span className={s.priceLine}><b>{usd(m.market.usdPrice)}</b><Change c={m.market.change24h} /></span>
            <span className={s.per}>per token, as wallets show it</span>
          </>
        ) : (
          <span className={s.per}>Jupiter has no price for it right now.</span>
        )}
      </span>
      <span className={s.coverChips}>
        {liq !== null && <span><span>Liq</span>{usdShort(liq)}</span>}
        <span><span>×</span>{Number(multiplierAt(m, now).toFixed(4))}</span>
        {liq !== null && liq < 50_000 && <span className={s.thin}>Thin pool</span>}
        {m.info.pausable?.paused && <span className={s.thin}>Paused by issuer</span>}
      </span>
      <span className={s.lockLine}>
        <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M7 11V8a5 5 0 0 1 10 0v3M5.5 11h13v9h-13z" />
        </svg>
        {m.symbol === "NFLXx" ? "The demo circle locks its devnet mirror" : "Accepted as cover in Othello's mainnet build"}
      </span>
    </Link>
  );
}

export default function AssetsIndex() {
  const { data, error } = useLiveXStocks();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("Liquidity");
  const [info, setInfo] = useState(false);
  // Stocks.dc.html has two layouts for the rest: rows ("Market board") and tiles ("Grid"). The
  // choice is a per-browser convenience; storage can be missing or blocked, so every access is guarded.
  const [view, setView] = useState<View>("List");
  useEffect(() => {
    try {
      if (localStorage.getItem(VIEW_KEY) === "Grid") setView("Grid");
    } catch {
      /* no storage: the default stands */
    }
  }, []);
  const pickView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* no storage: the choice lasts this visit */
    }
  };
  const now = Date.now() / 1000;

  const [pinned, rest] = useMemo(() => {
    const all = data?.mints ?? [];
    const needle = q.trim().toLowerCase();
    const hit = (m: LiveXStock) =>
      !needle || m.symbol.toLowerCase().includes(needle) || (m.info.metadata?.name ?? m.name).toLowerCase().includes(needle);
    const liq = (m: LiveXStock) => m.market?.liquidity ?? -1;
    // Unpriced stocks sort last under every key: a missing number is never ranked as zero.
    const key: Record<Sort, (m: LiveXStock) => number> = {
      Liquidity: liq,
      Price: (m) => m.market?.usdPrice ?? -Infinity,
      "24h change": (m) => m.market?.change24h ?? -Infinity,
    };
    return [
      all.filter((m) => m.accepted && hit(m)).sort((a, b) => liq(b) - liq(a)),
      all.filter((m) => !m.accepted && hit(m)).sort((a, b) => key[sort](b) - key[sort](a)),
    ];
  }, [data, q, sort]);
  const count = data?.mints.length ?? 0;
  // The grid's liquidity bar: log scale between the least and most liquid priced stock listed, so
  // it compares stocks on this page and says so; the dollar figure beside it is the real number.
  const liqs = (data?.mints ?? []).map((m) => m.market?.liquidity ?? 0).filter((x) => x > 0);
  const [lo, hi] = [Math.min(...liqs), Math.max(...liqs)];
  const liqPct = (x: number) => (hi > lo ? Math.max(10, Math.round(((Math.log(x) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * 100)) : 100);

  return (
    <AssetShell back={{ href: "/", label: "Back" }}>
      <header className={s.head}>
        <div className={s.headText}>
          <h1 className={s.h1}>Buy it. Lock it. Get paid in turn.</h1>
          <span className={s.lede}>
            {data ? `${count} xStocks on Solana, each read live from its own mint.` : "The xStocks on Solana, each read live from its own mint."}
            <button type="button" className={s.info} aria-expanded={info} aria-label="How Othello knows a stock" onClick={() => setInfo(!info)}>i</button>
            {info && (
              <span role="dialog" aria-label="How Othello knows a stock" className={s.infoPop}>
                <b>Known by address, not name.</b>
                <span>Anyone can make a token called NFLXx. Othello knows every xStock by its mint address, never its name. The four a circle accepts as cover are pinned first.</span>
              </span>
            )}
          </span>
        </div>
        <label className={s.search}>
          <svg viewBox="0 0 24 24" width={19} height={19} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" aria-hidden>
            <path d="M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13M15.4 15.4 20 20" />
          </svg>
          <input type="search" aria-label="Search assets by name or symbol" placeholder="Search by name or symbol" value={q} onChange={(e) => setQ(e.target.value)} />
          {q && (
            <button type="button" className={s.clear} aria-label="Clear search" onClick={() => setQ("")}>
              <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          )}
          {data && <span className={s.count}>{q.trim() ? `${pinned.length + rest.length} of ${count}` : count}</span>}
        </label>
      </header>

      {error ? (
        <Unavailable error={error} />
      ) : !data ? (
        <div aria-busy="true" className={s.loading}>
          <span>Reading the xStocks from Solana mainnet…</span>
          <div className={s.coverGrid}>{[0, 1, 2, 3].map((i) => <div key={i} className={s.skelCard} />)}</div>
        </div>
      ) : (
        <>
          {pinned.length + rest.length === 0 && <div className={s.none}>No xStock matches &quot;{q}&quot;.</div>}

          {pinned.length > 0 && (
            <section aria-label="Accepted as cover in a circle" className={s.section}>
              <div className={s.sectionHead}>
                <span className={s.label}>Accepted as cover in a circle ({pinned.length})</span>
                <span className={s.note}>Pinned. Sorted by liquidity</span>
              </div>
              <div className={s.coverGrid}>
                {pinned.map((m, i) => <CoverCard key={m.address} m={m} i={i} now={now} />)}
              </div>
            </section>
          )}

          {rest.length > 0 && (
            <section aria-label="More xStocks to buy and hold" className={s.section}>
              <div className={s.sectionHead}>
                <span className={s.label}>More xStocks to buy and hold ({rest.length})</span>
                <span className={s.controls}>
                <div role="group" aria-label="View" className={s.sorts}>
                  <span>View</span>
                  {VIEWS.map((v) => (
                    <button key={v} type="button" aria-pressed={view === v} className={view === v ? s.sortOn : ""} onClick={() => pickView(v)}>
                      {v}
                    </button>
                  ))}
                </div>
                <div role="group" aria-label="Sort" className={s.sorts}>
                  <span>Sort</span>
                  {SORTS.map((k) => (
                    <button key={k} type="button" aria-pressed={sort === k} className={sort === k ? s.sortOn : ""} onClick={() => setSort(k)}>{k}</button>
                  ))}
                </div>
                </span>
              </div>
              {view === "Grid" ? (
                <div className={s.tileGrid}>
                  {rest.map((m, i) => {
                    const slot = SLOTS[i % SLOTS.length]!;
                    const liq = m.market?.liquidity ?? null;
                    return (
                      <Link key={m.address} href={`/assets/${m.symbol}`} className={s.tile} style={{ animationDelay: `${0.1 + (i % 6) * 0.05}s`, "--slot": `var(--${slot})` } as CSSProperties}>
                        <span aria-hidden className={s.glint} />
                        <span className={s.tileTop}>
                          <span className={s.tileName}>
                            <b>{m.symbol}</b>
                            <span>{m.info.metadata?.name ?? m.name}</span>
                          </span>
                          {m.info.pausable?.paused && <span className={s.paused}>Paused</span>}
                          <span className={s.multPill}>×{Number(multiplierAt(m, now).toFixed(4))}</span>
                        </span>
                        {m.market ? (
                          <>
                            <span className={s.tilePrice}>
                              <b>{usd(m.market.usdPrice)}</b>
                              <Change c={m.market.change24h} />
                            </span>
                            {liq !== null && liq > 0 ? (
                              <span className={s.liq}>
                                <span className={s.liqLine}><span>Liquidity</span>{usdShort(liq)}</span>
                                <span role="img" aria-label={`Liquidity ${usdShort(liq)}, relative to the other stocks listed`} className={s.liqBar}>
                                  <span style={{ width: `${liqPct(liq)}%`, background: `var(--${slot})`, animationDelay: `${0.1 + (i % 6) * 0.05}s` }} />
                                </span>
                              </span>
                            ) : (
                              <span className={s.noPrice}>No liquidity figure</span>
                            )}
                          </>
                        ) : (
                          <span className={s.noPrice}>No price from Jupiter</span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              ) : (
              <div className={s.rowGrid}>
                {rest.map((m, i) => {
                  const slot = SLOTS[i % SLOTS.length]!;
                  const liq = m.market?.liquidity ?? null;
                  return (
                    <Link key={m.address} href={`/assets/${m.symbol}`} className={s.row} style={{ "--slot": `var(--${slot})` } as CSSProperties}>
                      <span className={s.badge} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)` }} aria-hidden>{m.symbol.slice(0, 2)}</span>
                      <span className={s.name}>
                        <span className={s.symLine}>
                          <b>{m.symbol}</b>
                          {m.info.pausable?.paused && <span className={s.paused}>Paused</span>}
                        </span>
                        <span className={s.sub}>
                          {m.info.metadata?.name ?? m.name}
                          {liq !== null ? ` · Liq ${usdShort(liq)}` : ""} · ×{Number(multiplierAt(m, now).toFixed(4))}
                        </span>
                      </span>
                      {m.market ? (
                        <span className={s.price}>
                          <b>{usd(m.market.usdPrice)}</b>
                          <Change c={m.market.change24h} />
                        </span>
                      ) : (
                        <span className={s.noPrice}>No price</span>
                      )}
                      <span className={s.arrow}><Arrow /></span>
                    </Link>
                  );
                })}
              </div>
              )}
            </section>
          )}
        </>
      )}

      <footer className={s.foot}>
        <span>
          {data ? `Mainnet slot ${data.slot.toLocaleString("en-US")}. Prices from Jupiter, per token as wallets show them.` : "Prices from Jupiter, per token as wallets show them."}
        </span>
        {data && data.unavailable.length > 0 && (
          <span className={s.failed}>Could not read this time: {data.unavailable.map((u) => u.symbol).join(", ")}.</span>
        )}
      </footer>
    </AssetShell>
  );
}
