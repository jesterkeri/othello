"use client";

/**
 * Assets on the Robinhood Chain side (Joshua, 2026-10-03): what is usable on testnet first, then Robinhood's Stock
 * Tokens, which exist only on mainnet, each tagged "Needs mainnet". Read-only: no prices, no trading, no advice.
 */
import { useEffect, useMemo, useState } from "react";
import { erc20Abi } from "viem";

import board from "@/components/assets/AssetsIndex.module.css";
import frame from "@/components/circle/Circle.module.css";
import Shell from "@/components/othello/Shell";
import { USDG, explorerAddress } from "@/lib/robinhood/chain";
import { fmtUsdg } from "@/lib/robinhood/copy";
import { STOCK_TOKENS, STOCK_TOKENS_SNAPSHOT, STOCK_TOKENS_SOURCE } from "@/lib/robinhood/stock-tokens";
import { robinhoodPublicClient, useEvmWallet } from "@/lib/robinhood/wallet";

import s from "./RobinhoodAssets.module.css";

const NETWORK = { chip: "Robinhood Chain testnet", note: "Test USDG only. It has no value." };
const SORTS = ["Symbol", "Name"] as const;
const VIEWS = ["List", "Grid"] as const;
type Sort = (typeof SORTS)[number];
type View = (typeof VIEWS)[number];

export default function RobinhoodAssets() {
  const w = useEvmWallet();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("Symbol");
  const [view, setView] = useState<View>("List");

  useEffect(() => {
    setBalance(null);
    setFailed(false);
    if (!w.address) return;
    let live = true;
    robinhoodPublicClient
      .readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [w.address as `0x${string}`] })
      .then((b) => { if (live) setBalance(b); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [w.address]);

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    const matched = k ? STOCK_TOKENS.filter(([sym, name]) => sym.toLowerCase().includes(k) || name.toLowerCase().includes(k)) : STOCK_TOKENS;
    return [...matched].sort(([symbolA, nameA], [symbolB, nameB]) =>
      (sort === "Symbol" ? symbolA : nameA).localeCompare(sort === "Symbol" ? symbolB : nameB),
    );
  }, [q, sort]);

  return (
    <Shell active="Assets" side="robinhood" network={NETWORK}>
      <main className={frame.frame}>
        <header className={board.head}>
          <div className={board.headText}>
            <span className={s.eyebrow}>Robinhood Chain testnet</span>
            <h1 className={board.h1}>Assets on Robinhood Chain</h1>
            <p className={board.lede}>What a testnet circle can use comes first. Robinhood Stock Tokens are listed below for reference and need mainnet.</p>
          </div>
          <label className={board.search}>
            <svg viewBox="0 0 24 24" width={19} height={19} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" aria-hidden>
              <path d="M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13M15.4 15.4 20 20" />
            </svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or symbol" aria-label="Find a Stock Token" />
            {q && <button type="button" className={board.clear} aria-label="Clear search" onClick={() => setQ("")}>×</button>}
            <span className={board.count}>{q.trim() ? `${shown.length} of ${STOCK_TOKENS.length}` : STOCK_TOKENS.length}</span>
          </label>
        </header>

        <section className={board.section} aria-labelledby="usable">
          <div className={board.sectionHead}>
            <h2 id="usable" className={board.label}>Usable on testnet</h2>
            <span className={board.note}>One token</span>
          </div>
          <div className={board.coverGrid}>
            <article className={`${board.cover} ${s.usdgCover}`}>
              <span aria-hidden className={board.glint} />
              <span aria-hidden className={board.rings}><span /></span>
              <span className={board.coverTop}>
                <span className={board.coverName}>Paxos Global Dollar</span>
                <span className={board.coverTag}>Usable</span>
              </span>
              <a className={board.coverSym} href={explorerAddress(USDG)} target="_blank" rel="noreferrer">USDG</a>
              <span className={board.coverPrice}><span className={board.per}>Test USDG for a testnet circle</span></span>
              <span className={board.coverChips}>
                <span><span>Purpose</span>Pay and lock</span>
                {w.address && balance !== null && <span><span>Wallet</span>{fmtUsdg(balance)}</span>}
                {w.address && failed && <span className={board.thin}>Balance unavailable</span>}
              </span>
              <span className={board.lockLine}>Test USDG only; it has no value.</span>
            </article>
          </div>
        </section>

        <section className={board.section} aria-labelledby="stock-tokens">
          <div className={board.sectionHead}>
            <h2 id="stock-tokens" className={board.label}>Waiting for mainnet</h2>
            <span className={board.controls}>
              <span role="group" aria-label="View" className={board.sorts}>
                <span>View</span>
                {VIEWS.map((item) => <button key={item} type="button" aria-pressed={view === item} className={view === item ? board.sortOn : ""} onClick={() => setView(item)}>{item}</button>)}
              </span>
              <span role="group" aria-label="Sort" className={board.sorts}>
                <span>Sort</span>
                {SORTS.map((item) => <button key={item} type="button" aria-pressed={sort === item} className={sort === item ? board.sortOn : ""} onClick={() => setSort(item)}>{item}</button>)}
              </span>
            </span>
          </div>
          <p className={s.footnote}>
            {STOCK_TOKENS.length} Stock Tokens from Robinhood&apos;s public registry (<a href={STOCK_TOKENS_SOURCE} target="_blank" rel="noreferrer">source</a>, snapshot {STOCK_TOKENS_SNAPSHOT}). They are not used by testnet circles. No prices or advice.
          </p>
          {shown.length === 0 ? (
            <p className={board.none}>No Stock Token matches “{q}”.</p>
          ) : view === "Grid" ? (
            <ol className={board.tileGrid}>
              {shown.map(([sym, name]) => (
                <li key={sym} className={`${board.tile} ${s.staticTile}`}>
                  <span className={board.tileTop}>
                    <span className={board.tileName}><b>{sym}</b><span>{name}</span></span>
                    <span className={board.multPill}>Needs mainnet</span>
                  </span>
                  <span className={board.noPrice}>Reference only</span>
                </li>
              ))}
            </ol>
          ) : (
            <ol className={board.rowGrid}>
              {shown.map(([sym, name]) => (
                <li key={sym} className={`${board.row} ${s.staticRow}`}>
                  <span className={board.badge} aria-hidden>{sym.slice(0, 2)}</span>
                  <span className={board.name}>
                    <span className={board.symLine}><b>{sym}</b></span>
                    <span className={board.sub}>{name}</span>
                  </span>
                  <span className={board.noPrice}>Needs mainnet</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>
    </Shell>
  );
}
