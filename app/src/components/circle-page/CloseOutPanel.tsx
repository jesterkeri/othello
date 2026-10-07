"use client";

/**
 * A finished circle (Joshua, 2026-10-05: "a completed circle doesnt even say properly how to refund everyone"), on
 * either chain (the shared circle page, 2026-10-07): who has collected, what the connected member gets, and their one
 * action. Facts from each chain's close-out (lib/core/circle-page.ts CloseOut); the withdrawal itself is the chain's
 * own withdraw, for the caller's own seat only. Where the chain's read gives no amount (Solana values the stock at
 * withdraw time) the panel names what is collected, not a number.
 */
import type { ChainWords, CloseOut } from "@/lib/core/circle-page";

import r from "./PayoutPanel.module.css";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function CloseOutPanel({ words, close, completed, canWrite, blocker, busy, onWithdraw }: {
  words: ChainWords;
  close: CloseOut;
  completed: boolean;
  canWrite: boolean;
  blocker: string | null;
  busy: boolean;
  onWithdraw: () => void;
}) {
  const mine = close.mine;
  const { fmt, locked } = words;
  return (
    <section className={r.panel} aria-label="Collect your share" aria-live="polite">
      <span className={r.kicker}>Circle finished: {close.collected} of {close.owedCount} shares collected</span>
      <b className={r.title}>{close.title}</b>
      <p className={r.note}>{close.body}</p>
      <ol className={r.steps}>
        {close.seats.map((x) => (
          <li key={x.turn} className={`${r.step} ${x.collected ? r.done : x.owed ? r.todo : ""}`}>
            <span className={r.dot} aria-hidden>{x.collected ? "✓" : ""}</span>
            <span className={r.stepText}>
              <b>{x.label}{x.you ? " (you)" : ""} · {short(x.wallet)}</b>
              <span>{!x.owed ? "Did not join: nothing to collect" : x.collected ? "Collected" : x.amount !== null ? `Not collected yet: ${fmt(x.amount)} waiting` : "Not collected yet"}</span>
            </span>
          </li>
        ))}
      </ol>
      {mine && mine.owed && !mine.collected && (
        <>
          <p className={r.blocker}>
            {mine.total === null || mine.locked === null || mine.pooled === null
              ? !completed
                ? `You collect your locked ${locked}, guarantee and top ups.`
                : `You collect your locked ${locked} and your share of what is left in the shared reserve.`
              : !completed
                ? `You collect ${fmt(mine.total)}: your locked ${locked}, guarantee and top ups.`
                : mine.pooled > 0n
                  ? `You collect ${fmt(mine.total)}: your ${fmt(mine.locked)} locked ${locked} and ${fmt(mine.pooled)} from the shared reserve.`
                  : mine.total > 0n
                    ? `You collect ${fmt(mine.total)}: your locked ${locked}. Your guarantee went to cover a missed payment, so there is no reserve share.`
                    : `Nothing is left for your seat: its locked ${locked} and guarantee covered a missed payment. Withdrawing closes your seat.`}
          </p>
          <button type="button" className={r.release} disabled={!canWrite} onClick={onWithdraw}>{busy ? "Confirm in your wallet…" : mine.total !== null ? `Withdraw ${fmt(mine.total)}` : "Withdraw"}</button>
          {blocker && <p className={r.note}>{blocker}</p>}
        </>
      )}
      {mine?.collected && <p className={r.blocker}>You have collected your share. Nothing more to do here.</p>}
      {!mine && <p className={r.note}>This wallet is not a member of this circle, so it has nothing to collect.</p>}
      <p className={r.note}>{words.testNote}</p>
    </section>
  );
}
