"use client";

/**
 * Assets on the Robinhood Chain side (Joshua, 2026-10-03): what is usable on testnet first, then Robinhood's Stock
 * Tokens, which exist only on mainnet, each tagged "Needs mainnet". Read-only: no prices, no trading, no advice.
 */
import { useEffect, useMemo, useState } from "react";
import { erc20Abi } from "viem";

import Shell from "@/components/othello/Shell";
import { USDG, explorerAddress } from "@/lib/robinhood/chain";
import { fmtUsdg } from "@/lib/robinhood/copy";
import { STOCK_TOKENS, STOCK_TOKENS_SNAPSHOT, STOCK_TOKENS_SOURCE } from "@/lib/robinhood/stock-tokens";
import { robinhoodPublicClient, useEvmWallet } from "@/lib/robinhood/wallet";

import s from "./Robinhood.module.css";

const NETWORK = { chip: "Robinhood Chain testnet", note: "Test USDG only. It has no value." };

export default function RobinhoodAssets() {
  const w = useEvmWallet();
  const [balance, setBalance] = useState<bigint | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState("");

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
    return k ? STOCK_TOKENS.filter(([sym, name]) => sym.toLowerCase().includes(k) || name.toLowerCase().includes(k)) : STOCK_TOKENS;
  }, [q]);

  return (
    <Shell active="Assets" side="robinhood" network={NETWORK}>
      <main className={s.page}>
        <header className={s.head}>
          <div className={s.pills}><span className={s.pill}>Robinhood Chain</span></div>
          <h1 className={s.title}>Assets on Robinhood Chain</h1>
          <p className={s.sub}>What you can use in a circle on testnet comes first. Robinhood&apos;s Stock Tokens follow; they are issued on Robinhood Chain mainnet, so each one needs mainnet.</p>
        </header>

        <section className={s.section} aria-labelledby="usable">
          <h2 id="usable" className={s.sectionTitle}>Usable on testnet</h2>
          <div className={s.member}>
            <span className={s.turn}>$</span>
            <div className={s.memberBody}>
              <a className={s.addr} href={explorerAddress(USDG)} target="_blank" rel="noreferrer">Test USDG (Paxos Global Dollar)</a>
              <span className={s.tags}>
                <span className={s.tag}>Usable on testnet</span>
                <span className={s.tag}>What circles are paid in and locked in</span>
                {w.address && balance !== null && <span className={s.tag}>Your wallet: {fmtUsdg(balance)}</span>}
                {w.address && failed && <span className={s.tag}>Your balance could not be read</span>}
              </span>
              <span className={s.muted}>Test USDG only; it has no value.</span>
            </div>
          </div>
        </section>

        <section className={s.section} aria-labelledby="stock-tokens">
          <h2 id="stock-tokens" className={s.sectionTitle}>Robinhood Stock Tokens: needs mainnet</h2>
          <p className={s.muted}>
            {STOCK_TOKENS.length} Stock Tokens from Robinhood&apos;s public registry (<a href={STOCK_TOKENS_SOURCE} target="_blank" rel="noreferrer">source</a>,
            snapshot {STOCK_TOKENS_SNAPSHOT}). All are on Robinhood Chain mainnet and none are on testnet; Othello&apos;s
            testnet circles do not use them. Listed for reference only: no prices, and nothing here is advice.
          </p>
          <label className={s.field}>
            <span>Find a Stock Token</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Symbol or name" aria-label="Find a Stock Token" />
          </label>
          {shown.length === 0 && <p className={s.muted}>No Stock Token matches “{q}”.</p>}
          <ol className={s.tokenGrid}>
            {shown.map(([sym, name]) => (
              <li key={sym} className={s.member}>
                <span className={s.turn}>{sym.slice(0, 1)}</span>
                <div className={s.memberBody}>
                  <span className={s.addr}>{sym}</span>
                  <span className={s.tags}>
                    <span className={s.tag}>{name}</span>
                    <span className={s.tag}>Needs mainnet</span>
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </main>
    </Shell>
  );
}
