/**
 * The circles board on a phone, its own layout rather than the desktop bento squeezed (Joshua 2026-10-06), kept plain:
 * one column of simple cards. The Needs-you strip, each running circle as a card in its colour, a "room for another"
 * row under three, and the finished pile last. Buttons are full width and at least 50px tall, as on the Solana side.
 */
import type { ChainSide } from "@/lib/chains";
import { CHAIN_PAGE, type ListCircle } from "@/lib/core/circle-list";
import { dueIn, type CircleCard as Card } from "@/lib/core/circle-card";
import { fmtMoney } from "@/lib/core/money";

import { Arrow, short, stage } from "./CircleCard";
import p from "./CirclesPhone.module.css";

type Item = { v: ListCircle; card: Card };

/** The tones the desktop tiles use, in the same order, so a circle keeps its colour across sizes. */
const TONES = ["var(--acid)", "var(--sky)", "var(--cobalt)"] as const;
const INKS = ["var(--acidInk)", "var(--skyInk)", "var(--cobaltInk)"] as const;

/**
 * A running circle as one plain card in its colour (Joshua 2026-10-06: the ticket version was "so complicated"): the
 * round, the step, the pot, one line of status, and one full-width button. The whole circle is on its own page.
 */
function CircleCardPhone({ v, card, index }: { v: ListCircle; card: Card; index: number }) {
  const href = v.href;
  const needs = card.group === "needs";
  const pot = fmtMoney(v.money, BigInt(v.n) * v.c);
  const paid = v.seats.filter((s) => s.paid).length;
  const joined = v.seats.filter((s) => s.joined).length;
  const due = dueIn(v);
  const label = card.action === "Pay" ? `Pay ${fmtMoney(v.money, v.c)}` : card.action === "Claim" ? `Claim ${pot}` : card.action;
  const status = [v.status === "Forming" ? `${joined} of ${v.n} joined` : `${paid} of ${v.n} paid`,
    due ? (due === "Late" || due === "Grace period" ? due : `${due} left`) : null].filter(Boolean).join(" · ");
  return (
    <article className={p.card} style={{ background: TONES[index % 3], color: INKS[index % 3] }} aria-label={`Circle ${short(v.address)}`}>
      <span className={p.cardTop}>
        <span className={p.round}>{stage(v)}</span>
        {needs && <span className={p.sticker}>Your move</span>}
      </span>
      <b className={p.headline}>{card.headline}</b>
      <span className={p.pot}>{pot}</span>
      <span className={p.status}>{status}</span>
      <a className={needs ? p.go : p.goQuiet} href={href} aria-label={`${needs ? label : "Open circle"}: circle ${short(v.address)}`}>
        {needs ? label : "Open circle"} <span aria-hidden>→</span>
      </a>
    </article>
  );
}

export default function CirclesPhone({ side, running, done, needsCount, waitingCount, onNeeds, onDone }: {
  side: ChainSide; running: Item[]; done: Item[]; needsCount: number; waitingCount: number; onNeeds: () => void; onDone: () => void;
}) {
  const toCollect = done.filter((x) => x.card.group === "needs").length;
  return (
    <div className={p.phone}>
      <button type="button" className={`${p.needs} ${needsCount > 0 ? p.needsHot : ""}`} onClick={onNeeds} disabled={waitingCount === 0}
        aria-haspopup="dialog">
        <span>{needsCount === 0 ? "All caught up" : needsCount === 1 ? "1 circle needs you" : `${needsCount} circles need you`}</span>
        <b className={p.needsCount}>{needsCount === 0 ? "✓" : needsCount}</b>
      </button>

      {running.map(({ v, card }, i) => <CircleCardPhone key={v.address} v={v} card={card} index={i} />)}

      {running.length < 3 && (
        <a className={p.room} href={CHAIN_PAGE[side].startHref}>
          <span>
            <b>{running.length === 0 ? "No circles running right now" : "Room for another circle"}</b>
            <span>You can be in up to three circles at once.</span>
          </span>
          <span className={p.roomGo}>Start <span aria-hidden>→</span></span>
        </a>
      )}

      <div className={p.pileWrap}>
        {done.length === 0 ? (
          <div className={`${p.card} ${p.finished}`}>
            <span className={p.round}>Finished</span>
            <b className={p.headline}>Your completed circles come here.</b>
          </div>
        ) : (
          <a className={`${p.card} ${p.finished}`} href={done.length === 1 ? done[0]!.v.href : undefined}
            role={done.length > 1 ? "button" : undefined} tabIndex={done.length > 1 ? 0 : undefined}
            onClick={done.length > 1 ? (e) => { e.preventDefault(); onDone(); } : undefined}
            onKeyDown={done.length > 1 ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onDone(); } } : undefined}>
            <span className={p.cardTop}>
              <span className={p.round}>Finished</span>
              {toCollect > 0 && <span className={p.sticker}>{toCollect} to collect</span>}
            </span>
            <span className={p.finishedRow}>
              <span className={p.pot}>{done.length}</span>
              <span className={p.status}>{done.length === 1 ? "circle paid out or cancelled" : "circles paid out or cancelled"}</span>
              <span className={p.arrow} aria-hidden><Arrow /></span>
            </span>
          </a>
        )}
      </div>
    </div>
  );
}
