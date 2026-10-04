"use client";

/**
 * One Robinhood Stock Token on testnet (Joshua, 2026-10-04: "build the inner pages"): the Solana asset page's band and
 * cards, with what is true on testnet only. Read-only: balanceOf and totalSupply; no price (a test token has none), no
 * trading, no advice. Circles are paid and locked in test USDG; this token is shown, not used by circles.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { erc20Abi, formatUnits } from "viem";

import d from "@/components/assets/AssetDetail.module.css";
import frame from "@/components/circle/Circle.module.css";
import Shell from "@/components/othello/Shell";
import { explorerAddress } from "@/lib/robinhood/chain";
import { TESTNET_FAUCET, TESTNET_STOCK_DECIMALS, TESTNET_STOCK_TOKENS } from "@/lib/robinhood/testnet-stocks";
import { robinhoodPublicClient, useEvmWallet } from "@/lib/robinhood/wallet";

import s from "./RobinhoodAssets.module.css";

const NETWORK = { chip: "Robinhood Chain testnet", note: "Test tokens only. They have no value." };
const SLOTS = ["acid", "sky", "cobalt", "clay", "acid"] as const;

/** A whole-token amount with at most four decimals, trailing zeros dropped, grouped in thousands. */
function fmt(b: bigint): string {
  const [i, f = ""] = formatUnits(b, TESTNET_STOCK_DECIMALS).split(".");
  const d4 = f.slice(0, 4).replace(/0+$/, "");
  const whole = BigInt(i!).toLocaleString("en-US");
  return d4 ? `${whole}.${d4}` : whole;
}

export default function RobinhoodAssetDetail({ symbol }: { symbol: string }) {
  const i = TESTNET_STOCK_TOKENS.findIndex((t) => t.symbol === symbol);
  const t = TESTNET_STOCK_TOKENS[i]!;
  const slot = SLOTS[i % SLOTS.length];
  const w = useEvmWallet();
  const [balance, setBalance] = useState<bigint | "failed" | null>(null);
  const [supply, setSupply] = useState<bigint | "failed" | null>(null);

  useEffect(() => {
    let live = true;
    robinhoodPublicClient
      .readContract({ address: t.address, abi: erc20Abi, functionName: "totalSupply" })
      .then((v) => { if (live) setSupply(v); })
      .catch(() => { if (live) setSupply("failed"); });
    return () => { live = false; };
  }, [t.address]);

  useEffect(() => {
    setBalance(null);
    if (!w.address) return;
    let live = true;
    robinhoodPublicClient
      .readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [w.address as `0x${string}`] })
      .then((v) => { if (live) setBalance(v); })
      .catch(() => { if (live) setBalance("failed"); });
    return () => { live = false; };
  }, [t.address, w.address]);

  return (
    <Shell active="Assets" side="robinhood" network={NETWORK}>
      <main className={frame.frame}>
        <section className={d.band} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)` }}>
          <div className={d.bandRow}>
            <Link href="/robinhood/assets" className={d.back}>‹ All assets</Link>
            <span className={d.readChip}><span className={d.dot} aria-hidden />Robinhood Chain testnet, read only</span>
          </div>
          <div className={d.bandRow}>
            <span className={d.titleLine}>
              <h1 className={d.sym}>{t.symbol}</h1>
              <span className={d.says}>Robinhood test Stock Token: <b>{t.name}</b></span>
            </span>
            <span className={d.bandRight}>
              <span className={d.kicker}>Contract</span>
              <a className={d.mintPill} href={explorerAddress(t.address)} target="_blank" rel="noreferrer">{t.address.slice(0, 6)}…{t.address.slice(-4)}</a>
            </span>
          </div>
        </section>

        <div className={s.detailGrid}>
          <section className={d.card} aria-label="Your wallet">
            <span className={d.cardKicker}>Your wallet</span>
            <span className={s.big}>
              {!w.address ? "Connect a wallet" : balance === null ? "Reading…" : balance === "failed" ? "Unavailable" : `${fmt(balance)} ${t.symbol}`}
            </span>
            <span className={s.footnote}>Read from Robinhood Chain testnet. A test token; it has no value.</span>
          </section>
          <section className={d.card} aria-label="On testnet">
            <span className={d.cardKicker}>On testnet</span>
            <span className={s.big}>{supply === null ? "Reading…" : supply === "failed" ? "Unavailable" : `${fmt(supply)} ${t.symbol}`}</span>
            <span className={s.footnote}>Total supply on testnet. An ERC-20 with {TESTNET_STOCK_DECIMALS} decimals; no price on testnet.</span>
          </section>
          <section className={d.card} aria-label="Get it">
            <span className={d.cardKicker}>Get it</span>
            <span className={s.big}>Testnet faucet</span>
            <span className={s.footnote}>
              Robinhood&apos;s <a href={TESTNET_FAUCET} target="_blank" rel="noreferrer">testnet faucet</a> sends 0.01 test ETH and five of each Stock Token, once every 24 hours.
            </span>
          </section>
          <section className={d.card} aria-label="In Othello">
            <span className={d.cardKicker}>In Othello</span>
            <span className={s.big}>Not used by circles yet</span>
            <span className={s.footnote}>Othello&apos;s testnet circles are paid and locked in test USDG. Nothing here is advice.</span>
          </section>
        </div>
      </main>
    </Shell>
  );
}
