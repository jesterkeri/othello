"use client";

/**
 * Releasing a round's pot (Joshua, 2026-10-05), on either chain (the shared circle page, 2026-10-07): one button whose
 * label says truly who receives, the exact blocker when it cannot run, and six steps that follow the real transaction
 * (lib/core/circle-page.ts payoutSteps). Nothing shows as paid before the receipt, and "Confirmed" waits for a fresh
 * read.
 */
import type { ChainWords, FlowStep, ReleaseButton, ReleasePhase } from "@/lib/core/circle-page";

import r from "./PayoutPanel.module.css";

const MARK = { done: "✓", now: "", todo: "", blocked: "!" } as const;

export default function PayoutPanel({ words, button, steps, phase, showSafetyCheck, canWrite, onRelease, onCheckSafety, onClose }: {
  words: ChainWords;
  button: ReleaseButton;
  steps: FlowStep[];
  phase: ReleasePhase;
  showSafetyCheck: boolean;
  canWrite: boolean;
  onRelease: () => void;
  onCheckSafety: () => void;
  onClose: () => void;
}) {
  const hash = phase.kind === "sent" || phase.kind === "released" ? phase.hash : null;
  const confirmed = steps.find((s) => s.key === "confirmed")?.status === "done";
  return (
    <section className={r.panel} aria-label="Release this round's pot" aria-live="polite">
      <span className={r.kicker}>This round&apos;s payout</span>
      <ol className={r.steps}>
        {steps.map((s) => (
          <li key={s.key} className={`${r.step} ${r[s.status]}`}>
            <span className={r.dot} aria-hidden>{MARK[s.status]}</span>
            <span className={r.stepText}>
              <b>{s.label}</b>
              <span>{s.detail}</span>
            </span>
            <span className={r.srOnly}>{{ done: "done", now: "in progress", todo: "not yet", blocked: "blocked" }[s.status]}</span>
          </li>
        ))}
      </ol>
      {confirmed && phase.kind === "released" ? (
        <div className={r.final}>
          <b>{steps.find((s) => s.key === "confirmed")!.detail}</b>
          <span><a className={r.link} href={words.txUrl(phase.hash)} target="_blank" rel="noreferrer">See the transaction on the explorer</a></span>
          <button type="button" className={r.quiet} onClick={onClose}>Done</button>
        </div>
      ) : (
        <>
          <button type="button" className={r.release} disabled={!button.enabled || phase.kind === "wallet" || phase.kind === "sent"} onClick={onRelease}>
            {phase.kind === "wallet" ? "Confirm in your wallet…" : phase.kind === "sent" ? "Releasing…" : button.label}
          </button>
          {button.blocker && phase.kind !== "wallet" && phase.kind !== "sent" && <p className={r.blocker}>{button.blocker}</p>}
          {phase.kind === "failed" && <p className={r.blocker} role="alert">{phase.message}</p>}
          {/* a release that was sent and then refused or not confirmed: its transaction, to check (adversary on a76dfd8) */}
          {phase.kind === "failed" && phase.hash && <a className={r.link} href={words.txUrl(phase.hash)} target="_blank" rel="noreferrer">See the transaction on the explorer</a>}
          {hash && phase.kind === "sent" && <a className={r.link} href={words.txUrl(hash)} target="_blank" rel="noreferrer">Watch it on the explorer</a>}
          {/* released, and the read has not yet shown the recipient paid: its transaction, from the moment it is done
              (adversary on 115079f) */}
          {hash && phase.kind === "released" && <a className={r.link} href={words.txUrl(hash)} target="_blank" rel="noreferrer">See the transaction on the explorer</a>}
        </>
      )}
      {showSafetyCheck && (
        <button type="button" className={r.quiet} disabled={!canWrite} onClick={onCheckSafety}>Check payout safety</button>
      )}
      <p className={r.note}>Any member can release a settled pot; it always goes to the seat whose turn it is. {words.testNote}</p>
    </section>
  );
}
