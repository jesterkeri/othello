"use client";

/**
 * The Solana-only details of a circle (Joshua 2026-10-07: they sit in their own panel below the shared circle page):
 * the stock's price and its age, the split (multiplier) and any scheduled change, whether price and split agree, and
 * the liquidation pool that buys a defaulted seat's stock; then the real xStocks beside the devnet mirror.
 */
import s from "@/components/circle/Circle.module.css";
import { formatDuration, formatUsdc, type CircleView } from "@/lib/circle";

import XStocksPanel from "./XStocksPanel";

export default function SolanaPanel({ c, now, split, pool, stockUnit, mirror }: {
  c: CircleView;
  now: number;
  split: { multiplier: number; newMultiplier: number; effectiveAt: number };
  pool: { discountBps: number; usdc: number };
  stockUnit: string;
  mirror: { multiplierNow: number; label: string };
}) {
  const priced = c.feed.wrapperPrice > 0 && c.feed.sharePrice > 0;
  const age = now - c.feed.updatedAt;
  const scheduled = split.effectiveAt > now && split.newMultiplier !== split.multiplier;
  const rows: [string, string][] = [
    ["Price", priced ? `${formatUsdc(c.feed.wrapperPrice)} test USDC per ${stockUnit} token, ${formatUsdc(c.feed.sharePrice)} per share` : "Not set yet"],
    ["Price age", priced ? `${formatDuration(age)} old; the program acts on a price up to ${formatDuration(c.maxPriceAge)} old` : "No price yet"],
    ["Split", `x${split.multiplier}${scheduled ? `, changing to x${split.newMultiplier} in ${formatDuration(split.effectiveAt - now)}` : ""}`],
    ["Price and split", c.feed.pricedForMultiplier === c.effectiveMultiplier ? "Agree" : "Disagree (repricing): payouts wait for a price set for the new split"],
    ["Liquidation pool", `${formatUsdc(pool.usdc)} test USDC, buys a defaulted seat's stock at ${pool.discountBps / 100}% off`],
  ];
  return (
    <section className={s.section} aria-label="Stock and price">
      <div className={s.sectionHead}>
        <span className={s.sectionLabel}>Stock and price</span>
        <span className={s.sectionNote}>What Solana circles read on top of the shared rules: the stock that is locked as cover.</span>
      </div>
      <dl className={s.ledger}>
        {rows.map(([k, v]) => (
          <div key={k} className={s.ledgerRow}><span className={s.ledgerSign} aria-hidden>·</span><dt>{k}</dt><dd>{v}</dd></div>
        ))}
      </dl>
      <XStocksPanel mirror={mirror} />
    </section>
  );
}
