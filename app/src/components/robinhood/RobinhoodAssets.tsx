"use client";

/**
 * Assets on the Robinhood Chain side (Joshua, 2026-10-03/04): what is on testnet first (test USDG, which circles use,
 * then the five Stock Tokens Robinhood's testnet faucet sends, with the wallet's balance of each), then the rest of
 * Robinhood's Stock Tokens, which are only on mainnet, each tagged "Needs mainnet". Read-only: balanceOf only; no
 * prices, no trading, no advice.
 */
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { erc20Abi, formatUnits } from "viem";

import board from "@/components/assets/AssetsIndex.module.css";
import frame from "@/components/circle/Circle.module.css";
import Shell from "@/components/othello/Shell";
import { USDG, explorerAddress } from "@/lib/robinhood/chain";
import { fmtUsdg } from "@/lib/robinhood/copy";
import { STOCK_TOKENS, STOCK_TOKENS_SNAPSHOT, STOCK_TOKENS_SOURCE } from "@/lib/robinhood/stock-tokens";
import { TESTNET_FAUCET, TESTNET_STOCK_DECIMALS, TESTNET_STOCK_TOKENS } from "@/lib/robinhood/testnet-stocks";
import { robinhoodPublicClient, useEvmWallet } from "@/lib/robinhood/wallet";

import s from "./RobinhoodAssets.module.css";

const NETWORK = { chip: "Robinhood Chain testnet", note: "Test tokens only. They have no value." };
const ON_TESTNET = new Set<string>(TESTNET_STOCK_TOKENS.map((t) => t.symbol));
/** The Stock Tokens only on mainnet: the registry less the five on testnet. */
const MAINNET_ONLY = STOCK_TOKENS.filter(([sym]) => !ON_TESTNET.has(sym));
const STOCK_SLOTS = ["acid", "sky", "cobalt", "clay", "acid"] as const;
/** A whole-token amount with at most four decimals, trailing zeros dropped. */
const fmtStock = (b: bigint) => {
  const [i, f = ""] = formatUnits(b, TESTNET_STOCK_DECIMALS).split(".");
  const d = f.slice(0, 4).replace(/0+$/, "");
  return d ? `${i}.${d}` : i!;
};
const SORTS = ["Symbol", "Name"] as const;
const VIEWS = ["List", "Grid"] as const;
type Sort = (typeof SORTS)[number];
type View = (typeof VIEWS)[number];

export default function RobinhoodAssets() {
  const w = useEvmWallet();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [failed, setFailed] = useState(false);
  const [stocks, setStocks] = useState<Record<string, bigint | "failed">>({});
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

  useEffect(() => {
    setStocks({});
    if (!w.address) return;
    let live = true;
    for (const t of TESTNET_STOCK_TOKENS) {
      robinhoodPublicClient
        .readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [w.address as `0x${string}`] })
        .then((b) => { if (live) setStocks((m) => ({ ...m, [t.symbol]: b })); })
        .catch(() => { if (live) setStocks((m) => ({ ...m, [t.symbol]: "failed" })); });
    }
    return () => { live = false; };
  }, [w.address]);

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    const matched = k ? MAINNET_ONLY.filter(([sym, name]) => sym.toLowerCase().includes(k) || name.toLowerCase().includes(k)) : MAINNET_ONLY;
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
            <p className={board.lede}>What is on testnet comes first: test USDG, which circles use, and the Stock Tokens Robinhood&apos;s testnet faucet sends. The rest of Robinhood&apos;s Stock Tokens need mainnet.</p>
          </div>
          <label className={board.search}>
            <svg viewBox="0 0 24 24" width={19} height={19} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" aria-hidden>
              <path d="M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13M15.4 15.4 20 20" />
            </svg>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or symbol" aria-label="Find a Stock Token" />
            {q && <button type="button" className={board.clear} aria-label="Clear search" onClick={() => setQ("")}>×</button>}
            <span className={board.count}>{q.trim() ? `${shown.length} of ${MAINNET_ONLY.length}` : MAINNET_ONLY.length}</span>
          </label>
        </header>

        <section className={board.section} aria-labelledby="usable">
          <div className={board.sectionHead}>
            <h2 id="usable" className={board.label}>Usable on testnet</h2>
            <span className={board.note}>{1 + TESTNET_STOCK_TOKENS.length} tokens</span>
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
            {TESTNET_STOCK_TOKENS.map((t, i) => {
              const b = stocks[t.symbol];
              const slot = STOCK_SLOTS[i % STOCK_SLOTS.length];
              return (
                <article key={t.symbol} className={board.cover} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)` }}>
                  <span aria-hidden className={board.glint} />
                  <span aria-hidden className={board.rings}><span /></span>
                  <span className={board.coverTop}>
                    <span className={board.coverName}>{t.name}</span>
                    <span className={board.coverTag}>On testnet</span>
                  </span>
                  <Link className={board.coverSym} href={`/robinhood/assets/${t.symbol}`}>{t.symbol}</Link>
                  <span className={board.coverPrice}><span className={board.per}>Robinhood test Stock Token</span></span>
                  <span className={board.coverChips}>
                    <span><span>Source</span>Testnet faucet</span>
                    {w.address && typeof b === "bigint" && <span><span>Wallet</span>{fmtStock(b)} {t.symbol}</span>}
                    {w.address && b === "failed" && <span className={board.thin}>Balance unavailable</span>}
                  </span>
                  <span className={board.lockLine}>Test token; it has no value. Not used by circles yet.</span>
                </article>
              );
            })}
          </div>
          <p className={s.footnote}>
            Robinhood&apos;s <a href={TESTNET_FAUCET} target="_blank" rel="noreferrer">testnet faucet</a> sends 0.01 test ETH and five of each of these Stock Tokens, once every 24 hours. Othello&apos;s testnet circles are paid and locked in test USDG.
          </p>
        </section>

        <section className={board.section} aria-labelledby="stock-tokens">
          <div className={board.sectionHead}>
            <h2 id="stock-tokens" className={board.label}>Not available on testnet: needs mainnet</h2>
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
            {MAINNET_ONLY.length} more Stock Tokens from Robinhood&apos;s public registry (<a href={STOCK_TOKENS_SOURCE} target="_blank" rel="noreferrer">source</a>, snapshot {STOCK_TOKENS_SNAPSHOT}), only on Robinhood Chain mainnet, so unavailable on testnet. No prices or advice.
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
                  <span className={board.noPrice}>Not available on testnet</span>
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
                  <span className={board.noPrice}>Not on testnet. Needs mainnet</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>
    </Shell>
  );
}
