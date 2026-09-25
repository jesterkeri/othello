"use client";

/**
 * The connected wallet's mainnet USDC and SOL as a small block (Joshua: "these need a better
 * design"): a token badge, the amount in the display face, the unit. Digits are exact (exactTokens),
 * only trailing zeros are dropped, so nothing is rounded.
 */
import type { WalletFunds as Funds } from "@/app/api/wallet/route";
import { exactTokens } from "@/lib/format";

import s from "./WalletFunds.module.css";

const trim = (x: string) => (x.includes(".") ? x.replace(/0+$/, "").replace(/\.$/, "") : x);

export default function WalletFunds({ funds, error, compact = false }: { funds: Funds | null; error: string | null; compact?: boolean }) {
  return (
    <div className={`${s.wallet} ${compact ? s.compact : ""}`} aria-live="polite">
      <span className={s.kicker}>Your wallet · mainnet</span>
      {funds ? (
        <span className={s.row}>
          <span className={s.token}>
            <span className={`${s.badge} ${s.usdc}`} aria-hidden>$</span>
            <b>{trim(exactTokens(funds.usdcRaw, 6))}</b>
            <small>USDC</small>
          </span>
          <span className={s.token}>
            <span className={`${s.badge} ${s.sol}`} aria-hidden>◎</span>
            <b>{trim(exactTokens(funds.lamports, 9))}</b>
            <small>SOL for fees</small>
          </span>
        </span>
      ) : (
        <span className={s.note}>{error ? `Balance unavailable: ${error}` : "Reading your balance…"}</span>
      )}
    </div>
  );
}
