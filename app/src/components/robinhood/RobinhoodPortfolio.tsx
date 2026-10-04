"use client";

/**
 * Robinhood Chain's read-only portfolio. It deliberately keeps testnet balances separate from the Solana portfolio:
 * USDG and the five faucet Stock Tokens have no price or real-world value here.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { erc20Abi, formatUnits } from "viem";

import Shell from "@/components/othello/Shell";
import portfolio from "@/components/portfolio/Portfolio.module.css";
import { USDG } from "@/lib/robinhood/chain";
import { fmtUsdg } from "@/lib/robinhood/copy";
import { TESTNET_STOCK_DECIMALS, TESTNET_STOCK_TOKENS } from "@/lib/robinhood/testnet-stocks";
import { robinhoodPublicClient, useEvmWallet } from "@/lib/robinhood/wallet";
import { useWalletUi } from "@/lib/wallet";

const NETWORK = { chip: "Robinhood Chain testnet", note: "Test tokens only. They have no value." };
const SLOTS = ["acid", "sky", "cobalt", "clay", "teal"] as const;

type TokenRead = bigint | "failed" | null;

function fmtStock(amount: bigint): string {
  const [whole, fraction = ""] = formatUnits(amount, TESTNET_STOCK_DECIMALS).split(".");
  const shown = fraction.slice(0, 4).replace(/0+$/, "");
  return shown ? `${whole}.${shown}` : whole!;
}

export default function RobinhoodPortfolio() {
  const wallet = useEvmWallet();
  const walletUi = useWalletUi();
  const [usdg, setUsdg] = useState<TokenRead>(null);
  const [stocks, setStocks] = useState<Record<string, TokenRead>>({});

  useEffect(() => {
    setUsdg(null);
    setStocks({});
    if (!wallet.address) return;
    let live = true;
    void robinhoodPublicClient
      .readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address as `0x${string}`] })
      .then((amount) => { if (live) setUsdg(amount); })
      .catch(() => { if (live) setUsdg("failed"); });
    for (const token of TESTNET_STOCK_TOKENS) {
      void robinhoodPublicClient
        .readContract({ address: token.address, abi: erc20Abi, functionName: "balanceOf", args: [wallet.address as `0x${string}`] })
        .then((amount) => { if (live) setStocks((current) => ({ ...current, [token.symbol]: amount })); })
        .catch(() => { if (live) setStocks((current) => ({ ...current, [token.symbol]: "failed" })); });
    }
    return () => { live = false; };
  }, [wallet.address]);

  return (
    <Shell active="Portfolio" side="robinhood" network={NETWORK}>
      <header className={portfolio.head}>
        <h1 className={portfolio.title}>Portfolio</h1>
        {wallet.address && <span className={portfolio.readLine}><span className={portfolio.read}><span style={{ background: "var(--teal)" }} />Robinhood Chain testnet</span><span>Read only. Othello never holds your keys.</span></span>}
      </header>

      {!wallet.address ? (
        <section className={portfolio.connect}>
          <span className={portfolio.tagLine}>Read only</span>
          <h2>See your Robinhood Chain testnet tokens in one place.</h2>
          <p>Connect an EVM wallet to read its test USDG and the Stock Tokens available from Robinhood&apos;s testnet faucet. No transaction is requested.</p>
          <button type="button" className={portfolio.btnInk} onClick={walletUi.openConnect}>Connect wallet</button>
        </section>
      ) : (
        <>
          {!wallet.onRobinhood && <section className={portfolio.connect}><span className={portfolio.tagLine}>Read-only view</span><h2>Balances below are read from Robinhood Chain testnet for this address.</h2><p>Switch to Robinhood Chain testnet before joining or managing a circle. Reading these testnet balances does not request a transaction.</p><button type="button" className={portfolio.btnInk} onClick={() => void wallet.switchToRobinhood()}>Switch network</button></section>}
          <div className={portfolio.top}>
            <section aria-label="Your testnet wallet" className={portfolio.total}>
              <div className={portfolio.pills}><span className={portfolio.pillLine}>Your testnet wallet</span><span className={portfolio.pillDay}>No market value</span></div>
              <b className={portfolio.big}>{typeof usdg === "bigint" ? fmtUsdg(usdg) : usdg === "failed" ? "Unavailable" : "Reading…"}</b>
              <span className={portfolio.holdLabel}>Test USDG used to pay and lock in Robinhood Chain testnet circles. It has no value and is not a dollar balance.</span>
              <section className={portfolio.xsub} aria-label="Testnet Stock Tokens">
                <span className={portfolio.pillLine}>Testnet Stock Tokens</span>
                <span className={portfolio.xsubNote}>Five tokens from Robinhood&apos;s faucet. They are visible assets, not circle collateral or payments.</span>
                <span className={portfolio.demoPills}>
                  {TESTNET_STOCK_TOKENS.map((token) => {
                    const amount = stocks[token.symbol] ?? null;
                    return <span key={token.symbol}><b>{amount === null ? "…" : amount === "failed" ? "Unavailable" : fmtStock(amount)}</b> {token.symbol}</span>;
                  })}
                </span>
              </section>
            </section>

            <section aria-label="Your circles" className={portfolio.circle}>
              <div className={portfolio.pillsSpread}><span className={portfolio.pillLine}>Your circles</span><span className={portfolio.pillCream}>Test USDG only</span></div>
              <div className={portfolio.down}><b>Circle positions stay on testnet.</b><span>Open your circles to see what is locked, what is due, and whether a payout can move. There is no dollar total because every asset on this page is a test token.</span><Link href="/robinhood" className={portfolio.btnCream}>Open your circles</Link></div>
              <Link href="/robinhood/assets" className={portfolio.allLink}>All Robinhood assets</Link>
            </section>
          </div>

          <section aria-label="Robinhood Chain testnet assets" className={portfolio.holdings}>
            <div className={portfolio.holdHead}><span className={portfolio.holdTitle}><span>Assets on Robinhood Chain testnet</span></span><Link href="/robinhood/assets" className={portfolio.allStocks}>All assets</Link></div>
            <Link href="/robinhood/assets" className={portfolio.row}>
              <span className={portfolio.badge} style={{ background: "var(--teal)", color: "var(--tealInk)" }}>US</span>
              <span className={portfolio.name}><b>USDG</b><span>Paxos Global Dollar · testnet</span></span>
              <span className={portfolio.value}><b>{typeof usdg === "bigint" ? fmtUsdg(usdg) : usdg === "failed" ? "Unavailable" : "Reading…"}</b><span>Used by circles</span></span>
            </Link>
            {TESTNET_STOCK_TOKENS.map((token, index) => {
              const amount = stocks[token.symbol] ?? null;
              const slot = SLOTS[index % SLOTS.length];
              return <Link key={token.symbol} href={`/robinhood/assets/${token.symbol}`} className={portfolio.row}>
                <span className={portfolio.badge} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)` }}>{token.symbol.slice(0, 2)}</span>
                <span className={portfolio.name}><b>{token.symbol}</b><span>{token.name} · testnet faucet</span></span>
                <span className={portfolio.value}><b>{amount === null ? "Reading…" : amount === "failed" ? "Unavailable" : `${fmtStock(amount)} ${token.symbol}`}</b><span>Not used by circles</span></span>
              </Link>;
            })}
          </section>
        </>
      )}

      <footer className={portfolio.foot}><span>Testnet only. These balances have no monetary value and are not financial advice.</span><Link href="/robinhood/assets">About these assets</Link></footer>
    </Shell>
  );
}
