"use client";

/**
 * The connected wallet's mainnet USDC and SOL as a small block (Joshua: "these need a better
 * design"): a token badge, the amount in the display face, the unit. Digits are exact (exactTokens),
 * only trailing zeros are dropped, so nothing is rounded.
 */
import type { WalletFunds as Funds } from "@/app/api/wallet/route";
import { exactTokens } from "@/lib/format";

import { TokenChip } from "./TokenChip";
import s from "./WalletFunds.module.css";

const trim = (x: string) => (x.includes(".") ? x.replace(/0+$/, "").replace(/\.$/, "") : x);

export default function WalletFunds({ funds, error, compact = false, devnet = false, label }: { funds: Funds | null; error: string | null; compact?: boolean; /** Also show the devnet balances the circle spends. */ devnet?: boolean; label?: string }) {
  return (
    <div className={`${s.wallet} ${compact ? s.compact : ""}`} aria-live="polite">
      {devnet && funds && (
        <>
          <span className={s.kicker}>Devnet · the demo circle</span>
          {funds.devnet ? (
            <span className={s.row}>
              <TokenChip badge="S" tone="sol" amount={trim(exactTokens(funds.devnet.lamports, 9))} unit="devnet SOL" />
              <TokenChip badge="$" tone="test" amount={trim(exactTokens(funds.devnet.testUsdcRaw, 6))} unit="test USDC" />
            </span>
          ) : (
            <span className={s.note}>Devnet balance unavailable right now.</span>
          )}
        </>
      )}
      <span className={s.kicker}>{label ?? (devnet ? "Mainnet · for Buy" : "Your wallet · mainnet, for Buy")}</span>
      {funds ? (
        <span className={s.row}>
          <TokenChip badge="$" tone="usdc" amount={trim(exactTokens(funds.usdcRaw, 6))} unit="USDC" />
          <TokenChip badge="S" tone="sol" amount={trim(exactTokens(funds.lamports, 9))} unit="SOL for fees" />
        </span>
      ) : (
        <span className={s.note}>{error ? `Balance unavailable: ${error}` : "Reading your balance…"}</span>
      )}
    </div>
  );
}
