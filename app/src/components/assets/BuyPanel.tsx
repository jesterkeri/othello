"use client";

/**
 * Buy (Joshua, 2026-09-25: "people will buy the stocks from our platform to stake them"). A live
 * Jupiter quote for USDC into this xStock, then Jupiter's own swap page with the pair filled in:
 * the purchase is made on mainnet, with real funds, in the buyer's own wallet. Othello never
 * holds the funds and builds no transaction here. An in-app swap can replace the hand-off later.
 */
import { useEffect, useState } from "react";

import type { Quote } from "@/app/api/quote/route";
import s from "@/components/circle/Circle.module.css";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Checked in a browser 2026-09-25: jup.ag/swap/<in>-<out> redirects to buying SOL; the query form
// ?sell=<in>&buy=<out> opens the right pair.

export default function BuyPanel({ symbol, address, decimals, multiplier, accepted, embedded = false }: { symbol: string; address: string; decimals: number; multiplier: number; accepted: boolean; /** Inside the stock page's Buy card: no box or title of its own. */ embedded?: boolean }) {
  const [amount, setAmount] = useState("50");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const usdc = Number(amount);
    setQuote(null);
    setError(null);
    if (!Number.isFinite(usdc) || usdc <= 0) return;
    let alive = true;
    const id = window.setTimeout(() => {
      fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}&usdc=${usdc}`, { cache: "no-store" })
        .then((r) => r.json() as Promise<Quote | { error: string }>)
        .then((b) => {
          if (!alive) return;
          if ("error" in b) throw new Error(b.error);
          setQuote(b);
        })
        .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [amount, symbol]);

  const raw = quote ? Number(quote.outRaw) / 10 ** decimals : 0;
  const shown = raw * multiplier;

  return (
    <div className={embedded ? s.chartBare : s.chartBox}>
      {!embedded && <span className={s.bannerTitle}>Buy {symbol}</span>}
      <label className={s.panelNote}>
        Pay{" "}
        <input className={s.search} style={{ width: 140, display: "inline-block", padding: "8px 12px" }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="USDC to pay" />{" "}
        USDC
      </label>
      {error ? (
        <p className={s.panelNote}>No quote: {error}</p>
      ) : !quote ? (
        <p className={s.panelNote}>Asking Jupiter for a quote…</p>
      ) : (
        <div className={s.rows}>
          <span className={s.row}>
            <span className={s.rowLabel}>You receive, as your wallet shows it</span>
            <span className={s.rowValue}>
              about {shown.toLocaleString("en-US", { maximumFractionDigits: 6 })} {symbol}
            </span>
          </span>
          <span className={s.row}>
            <span className={s.rowLabel}>Raw (before the multiplier)</span>
            <span className={s.rowValue}>{raw.toLocaleString("en-US", { maximumFractionDigits: decimals })}</span>
          </span>
          <span className={s.row}>
            <span className={s.rowLabel}>Price impact</span>
            <span className={s.rowValue}>
              {quote.priceImpactPct.toFixed(2)}%{quote.priceImpactPct >= 1 ? " (thin pool: consider a smaller amount)" : ""}
            </span>
          </span>
          <span className={s.row}>
            <span className={s.rowLabel}>Route</span>
            <span className={s.rowValue}>{quote.route.join(" → ") || "direct"}</span>
          </span>
        </div>
      )}
      <a className={s.pay} style={{ alignSelf: "flex-start", textDecoration: "none" }} href={`https://jup.ag/swap?sell=${USDC}&buy=${address}`} target="_blank" rel="noreferrer">
        Buy on Jupiter ↗
      </a>
      <p className={s.panelNote}>
        Mainnet, real money: you complete the swap on Jupiter, in your own wallet, and Othello never holds your funds. Quote with 1%
        slippage; the final amount is set when you sign.{" "}
        {accepted
          ? "A circle can lock it as cover once Othello is on mainnet; today's demo circle runs on devnet with a labelled mirror."
          : "Circles do not accept it as cover yet."}
      </p>
    </div>
  );
}
