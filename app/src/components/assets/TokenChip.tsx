/**
 * One wallet balance as a chip: a round badge, the amount in the display face, the unit. Shared by WalletFunds (the
 * Solana pages' USDC and SOL) and the Robinhood portfolio (USDG and testnet ETH), so both draw the same chip. The badge
 * takes either one of WalletFunds' token tones or a palette slot (its colour and ink from the theme).
 */
import type { ReactNode } from "react";

import s from "./WalletFunds.module.css";

export function TokenChip({ badge, tone, slot, amount, unit }: { badge: string; tone?: "usdc" | "sol" | "test"; slot?: string; amount: string; unit: string }) {
  return (
    <span className={s.token}>
      <span className={tone ? `${s.badge} ${s[tone]}` : s.badge} style={slot ? { background: `var(--${slot})`, color: `var(--${slot}Ink)` } : undefined} aria-hidden>{badge}</span>
      <b>{amount}</b>
      <small>{unit}</small>
    </span>
  );
}

/** A labelled group of chips, or a note in their place (reading, or a read that failed). */
export function TokenChips({ label, note, children }: { label: string; note: string | null; children: ReactNode }) {
  return (
    <div className={s.wallet} aria-live="polite">
      <span className={s.kicker}>{label}</span>
      {note ? <span className={s.note}>{note}</span> : <span className={s.row}>{children}</span>}
    </div>
  );
}
