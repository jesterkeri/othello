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

        <div className={d.bento}>
          <section className={`${d.card} ${d.chartArea} ${s.readCard}`} aria-label="Testnet balance and supply">
            <span className={d.cardKicker}>Read on Robinhood Chain testnet</span>
            <span className={s.reading}>
              {!w.address ? "Connect a wallet" : balance === null ? "Reading…" : balance === "failed" ? "Unavailable" : `${fmt(balance)} ${t.symbol}`}
            </span>
            <span className={s.readingNote}>Your wallet balance. This test token has no value.</span>
            <div className={d.stats}>
              <span><small>Total supply</small><b>{supply === null ? "Reading…" : supply === "failed" ? "Unavailable" : `${fmt(supply)} ${t.symbol}`}</b></span>
              <span><small>Decimals</small><b>{TESTNET_STOCK_DECIMALS}</b></span>
              <span><small>Price</small><b>Not shown on testnet</b></span>
              <span><small>Network</small><b>Robinhood Chain testnet</b></span>
            </div>
          </section>

          <section className={`${d.card} ${d.buyArea} ${d.buyCard}`} aria-label={`Get ${t.symbol}`}>
            <span className={d.buyHead}>
              <b>Get {t.symbol}</b>
              <span className={d.realMoney}>Test tokens</span>
            </span>
            <span className={s.faucetCopy}>Robinhood&apos;s faucet sends 0.01 test ETH and five of each Stock Token, once every 24 hours.</span>
            <a className={d.btnInk} href={TESTNET_FAUCET} target="_blank" rel="noreferrer">Open testnet faucet ↗</a>
          </section>

          <section className={`${d.card} ${d.multArea}`} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)` }} aria-label="In Othello">
            <span className={d.outlined}>In Othello</span>
            <b className={d.multBig}>USDG</b>
            <span className={d.dotted} />
            <span className={d.changeLine}><b>Not used by circles yet</b></span>
            <p className={d.multNote}>Othello&apos;s testnet circles are paid and locked in test USDG. Nothing here is advice.</p>
          </section>

          <section className={`${d.ident} ${d.identArea}`} aria-label="Token identity">
            <span className={d.identItem}><small>Contract</small><a className={d.addr} href={explorerAddress(t.address)} target="_blank" rel="noreferrer">{t.address}</a></span>
            <span className={d.identItem}><small>Token</small><span>Robinhood test Stock Token</span></span>
            <span className={d.identItem}><small>Status</small><span>On testnet, read only</span></span>
          </section>
        </div>
      </main>
    </Shell>
  );
}
