"use client";

/**
 * A finished circle (Joshua, 2026-10-05: "a completed circle doesnt even say properly how to refund everyone"): who
 * has collected, what the connected member gets, and their one action. Facts from lib/robinhood/circle-view.ts
 * closeOutOf; the withdrawal itself is the contract's withdraw(), for the caller's own seat only.
 */
import type { CloseOut } from "@/lib/robinhood/circle-view";
import { fmtUsdg } from "@/lib/robinhood/copy";

import r from "./PayoutPanel.module.css";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function CloseOutPanel({ close, completed, canWrite, blocker, busy, onWithdraw }: {
  close: CloseOut;
  completed: boolean;
  canWrite: boolean;
  blocker: string | null;
  busy: boolean;
  onWithdraw: () => void;
}) {
  const mine = close.mine;
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
              <span>{!x.owed ? "Did not join: nothing to collect" : x.collected ? "Collected" : "Not collected yet"}</span>
            </span>
          </li>
        ))}
      </ol>
      {mine && mine.owed && !mine.collected && (
        <>
          <p className={r.blocker}>
            {completed
              ? `You collect your ${fmtUsdg(mine.exact)} locked USDG plus your share of the shared reserve.`
              : `You collect ${fmtUsdg(mine.exact)}: your locked USDG, guarantee and top ups.`}
          </p>
          <button type="button" className={r.release} disabled={!canWrite} onClick={onWithdraw}>{busy ? "Confirm in your wallet…" : "Withdraw your share"}</button>
          {blocker && <p className={r.note}>{blocker}</p>}
        </>
      )}
      {mine?.collected && <p className={r.blocker}>You have collected your share. Nothing more to do here.</p>}
      {!mine && <p className={r.note}>This wallet is not a member of this circle, so it has nothing to collect.</p>}
      <p className={r.note}>Test USDG only; it has no value.</p>
    </section>
  );
}
