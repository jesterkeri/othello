"use client";

/**
 * /assets: every buyable xStock (lib/xstocks.ts), read live from mainnet. The four a circle
 * accepts as cover today (the program's allowlist) are pinned and marked; the rest can be bought
 * and held, not yet locked.
 */
import Link from "next/link";
import { useMemo, useState } from "react";

import type { LiveXStock } from "@/app/api/live/route";
import s from "@/components/circle/Circle.module.css";
import { multiplierAt } from "@/lib/scaledUi";

import AssetShell, { Unavailable } from "./Shell";
import { mult, useLiveXStocks } from "./useLiveXStocks";

export function usd(n: number, dp = 2): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export function usdShort(n: number): string {
  return n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`;
}

function Card({ m }: { m: LiveXStock }) {
  const now = Date.now() / 1000;
  const change = m.market?.change24h ?? null;
  return (
    <Link href={`/assets/${m.symbol}`} className={`${s.card} ${m.accepted ? s.cardReserve : s.cardCoverage}`}>
      <span className={s.micro}>{m.info.metadata?.name ?? m.name}</span>
      <span className={`${s.display} ${s.cardBig}`}>{m.symbol}</span>
      {m.accepted && <span className={`${s.tag} ${s.tagYes}`}>Accepted as cover</span>}
      {m.info.pausable?.paused && <span className={`${s.tag} ${s.tagDue}`}>Paused by issuer</span>}
      <div className={s.rows}>
        <span className={s.row}>
          <span className={s.rowLabel}>Price (per token shown)</span>
          <span className={s.rowValue}>
            {m.market ? usd(m.market.usdPrice) : "unavailable"}
            {change !== null ? ` ${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : ""}
          </span>
        </span>
        <span className={s.row}>
          <span className={s.rowLabel}>Liquidity</span>
          <span className={s.rowValue}>{m.market?.liquidity != null ? usdShort(m.market.liquidity) : "unavailable"}</span>
        </span>
        <span className={s.row}>
          <span className={s.rowLabel}>Multiplier now</span>
          <span className={s.rowValue}>{mult(multiplierAt(m, now))}</span>
        </span>
      </div>
    </Link>
  );
}

export default function AssetsIndex() {
  const { data, error } = useLiveXStocks();
  const [q, setQ] = useState("");

  const [pinned, rest] = useMemo(() => {
    const all = data?.mints ?? [];
    const needle = q.trim().toLowerCase();
    const hit = (m: LiveXStock) =>
      !needle || m.symbol.toLowerCase().includes(needle) || (m.info.metadata?.name ?? m.name).toLowerCase().includes(needle);
    const byLiquidity = (a: LiveXStock, b: LiveXStock) => (b.market?.liquidity ?? 0) - (a.market?.liquidity ?? 0);
    return [all.filter((m) => m.accepted && hit(m)).sort(byLiquidity), all.filter((m) => !m.accepted && hit(m)).sort(byLiquidity)];
  }, [data, q]);

  return (
    <AssetShell back={{ href: "/", label: "Back" }}>
      <section className={s.head}>
        <div className={s.headTop}>
          <span className={`${s.stockPill} ${s.micro}`}>Tokenized stocks on Solana</span>
        </div>
        <h1 className={`${s.display} ${s.h1}`}>Buy it. Lock it. Get paid in turn.</h1>
        <p className={s.sub}>
          {data ? `${data.mints.length} xStocks you can buy on Solana today` : "The xStocks you can buy on Solana today"}, each
          read live from its own mint. The four a circle accepts as cover are pinned first. Othello knows every one by its
          mint address, never its name: anyone can make a token called NFLXx.
        </p>
        <input
          className={s.search}
          type="search"
          placeholder="Search by name or symbol"
          aria-label="Search xStocks"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </section>

      {error ? (
        <Unavailable error={error} />
      ) : !data ? (
        <div className={s.section}>
          <p className={s.panelNote}>Reading mainnet…</p>
        </div>
      ) : (
        <>
          {pinned.length > 0 && (
            <div className={s.section}>
              <div className={s.sectionHead}>
                <span className={s.sectionLabel}>Accepted as cover in a circle</span>
                <span className={s.sectionLabel}>{pinned.length}</span>
              </div>
            </div>
          )}
          <div className={s.cards}>{pinned.map((m) => <Card key={m.address} m={m} />)}</div>
          <div className={s.section}>
            <div className={s.sectionHead}>
              <span className={s.sectionLabel}>More xStocks to buy and hold</span>
              <span className={s.sectionLabel}>{rest.length}</span>
            </div>
          </div>
          <div className={s.cards}>
            {rest.length ? rest.map((m) => <Card key={m.address} m={m} />) : <p className={s.panelNote}>No xStock matches &quot;{q}&quot;.</p>}
          </div>
        </>
      )}
      <div className={s.footer}>
        <p className={s.helper}>
          {data ? `Mainnet slot ${data.slot.toLocaleString("en-US")}. Prices from Jupiter, per token as wallets show it.` : ""}
          {data && data.unavailable.length > 0
            ? ` Could not be read this time: ${data.unavailable.map((u) => u.symbol).join(", ")}.`
            : ""}
        </p>
      </div>
    </AssetShell>
  );
}
