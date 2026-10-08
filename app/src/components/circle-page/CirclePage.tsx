"use client";

/**
 * The shared single-circle page (Joshua 2026-10-07): the Robinhood circle page's layout, made chain-neutral, for
 * /circle/rh:<address>, /circle/sol:<address> and /circle/demo. It draws only what a chain hands it: its own words,
 * money, links and actions (components/robinhood/RobinhoodCircle.tsx, components/live/LiveCircle.tsx), so a Solana
 * visitor never sees a Robinhood word and the reverse. Banners; the ring hero with the payout or close-out panel;
 * "Your next step"; turn order; the reserve and what each seat locks; members; the chain's own panel; the footer.
 */
import type { ReactNode } from "react";

import Shell from "@/components/othello/Shell";
import CircleRing from "@/components/robinhood/CircleRing";
import type { ChainSide } from "@/lib/chains";
import type { Ring } from "@/lib/core/ring";

import s from "@/components/circle/Circle.module.css";
import rh from "@/components/robinhood/Robinhood.module.css";

const SEAT_SLOTS = ["teal", "acid", "cobalt", "clay", "sky"] as const;

export type PageBanner = { kind: "refusal" | "neutral"; mark: string; title: string; text: ReactNode };
export type PageStatus = "Forming" | "Active" | "Completed" | "Cancelled" | "Paused" | "Repricing";
export type Tone = "teal" | "acid" | "cobalt" | "clay" | "";
export type MemberCard = {
  turn: number;
  you: boolean;
  wallet: string;
  creator: boolean;
  explorer: string;
  /** What this seat has locked, in the chain's own words (a line, or the "not joined" line). */
  stake: ReactNode;
  chips: { label: string; value: string; tone: Tone }[];
};

export type CirclePageProps = {
  side: ChainSide;
  network?: { chip: string; note: string };
  /** A line above the banners (Solana: which circle, read how long ago). */
  topLine?: ReactNode;
  banners: PageBanner[];
  ring: Ring;
  pot: bigint;
  round: number;
  fmt: (base: bigint) => string;
  /** What a seat locks, in the ring's legend ("USDG", the circle's stock). */
  collateral: string;
  /** What pays a defaulted seat's share, in the ring (lib/core/ring.ts RingWords.covered). */
  covered?: string;
  status: PageStatus;
  /** The money pill beside the status, e.g. "Test USDG on Robinhood Chain". */
  moneyPill: string;
  heading: string;
  sub: ReactNode;
  clock: { label: string; value: string; over?: boolean }[];
  /** The close-out panel of a finished circle (it then lists the seats, so the ring's list is hidden). */
  closeOut: ReactNode | null;
  /** The payout panel of a running circle. */
  payout: ReactNode | null;
  /** "Your next step" (NextStep with ActionRows). */
  act: ReactNode;
  turns: { forming: { title: string; text: string } | null; label: string; note: string; rounds: { turn: number; name: string; note: string; state: "now" | "done" | "" }[] };
  reserve: { heading: string; amount: string; unit: string; coins: number[]; coinNote: string; lines: readonly (readonly [string, string, string])[] };
  locks: { label: string; kicker: string; intro: ReactNode; steps: readonly (readonly [string, string])[]; chips: readonly (readonly [string, string])[] };
  members: { head: string; note: ReactNode; cards: MemberCard[] };
  /** The chain's own panel (Solana: price, split, coverage, pool, xStocks). */
  extras?: ReactNode;
  footer: ReactNode;
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The "Your next step" section: a chain fills it with ActionRows, connect prompts and its status line. */
export function NextStep({ children }: { children: ReactNode }) {
  return (
    <section className={s.act} aria-live="polite">
      <span className={s.kicker}>Your next step</span>
      {children}
    </section>
  );
}

/** One step a visitor can take: a title, what it does, and its buttons or inputs. */
export function ActionRow({ title, text, children }: { title: ReactNode; text?: ReactNode; children?: ReactNode }) {
  return (
    <div className={s.action}>
      <span className={s.actionText}>
        <span className={s.bannerTitle}>{title}</span>
        {text !== undefined && <span className={s.actFixture}>{text}</span>}
      </span>
      {children}
    </div>
  );
}

/** The page's own class names, for a chain's action buttons and inputs. */
export const pageStyles = s;

export default function CirclePage(p: CirclePageProps) {
  const statusClass = {
    Paused: s.statusPaused,
    Repricing: s.statusRepricing,
    Forming: s.statusForming,
    Active: s.statusActive,
    Completed: s.statusCompleted,
    Cancelled: s.statusCancelled,
  }[p.status];
  const finished = p.closeOut !== null;
  return (
    <Shell active="Circles" side={p.side} network={p.network}>
      <main className={s.frame}>
        {p.topLine && <div className={s.devnet}><p className={s.devnetText}>{p.topLine}</p></div>}
        <div className={s.banners}>
          {p.banners.map((b) => (
            <section key={b.title} className={`${s.banner} ${b.kind === "refusal" ? s.bannerRefusal : s.bannerNeutral}`} role="status">
              <span className={s.bannerMark} aria-hidden>{b.mark}</span>
              <span className={s.bannerBody}>
                <span className={s.bannerTitle}>{b.title}</span>
                <p className={s.bannerText}>{b.text}</p>
              </span>
            </section>
          ))}
        </div>

        <section className={`${s.hero} ${rh.ringHero}`} aria-label="This savings circle">
          {/* a finished circle lists its seats once, in the close-out panel */}
          <div className={rh.ringCol}>
            <CircleRing ring={p.ring} pot={p.pot} round={p.round} showList={!finished} fmt={p.fmt} collateral={p.collateral} covered={p.covered} />
            {finished && p.act}
          </div>
          <div className={s.heroMain}>
            <div className={s.headTop}>
              <span className={`${s.statusPill} ${statusClass} ${s.micro}`}>{p.status}</span>
              <span className={`${s.stockPill} ${s.micro}`}>{p.moneyPill}</span>
            </div>
            <h1 className={`${s.display} ${s.h1}`}>{p.heading}</h1>
            <p className={s.sub}>{p.sub}</p>
            <div className={s.clock}>
              {p.clock.map((c) => (
                <span key={c.label} className={`${s.clockBox} ${c.over ? s.clockOver : ""}`}>
                  <span className={s.clockLabel}>{c.label}</span>
                  <span className={`${s.display} ${s.clockValue}`}>{c.value}</span>
                </span>
              ))}
            </div>
            {p.closeOut}
            {p.payout}
          </div>
        </section>

        {!finished && p.act}

        {p.turns.forming ? (
          <section className={s.section}>
            <div className={s.empty}>
              <span className={`${s.display} ${s.emptyTitle}`}>{p.turns.forming.title}</span>
              <p className={s.bannerText}>{p.turns.forming.text}</p>
            </div>
          </section>
        ) : (
          <section className={s.section}>
            <div className={s.sectionHead}>
              <span className={s.sectionLabel}>{p.turns.label}</span>
              <span className={s.sectionLabel}>{p.turns.note}</span>
            </div>
            <div className={s.timeline}>
              {p.turns.rounds.map((r) => (
                <div key={r.turn} className={`${s.round} ${r.state === "now" ? s.roundNow : r.state === "done" ? s.roundDone : ""}`}>
                  <span className={s.roundNum}>Round {r.turn + 1}</span>
                  <span className={s.roundName}>{r.name}</span>
                  <span className={s.roundNote}>{r.note}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <div className={s.money}>
          <section className={s.reserve} aria-label="Shared reserve">
            <span className={s.kicker}>{p.reserve.heading}</span>
            <div className={s.reserveTop}>
              <b className={`${s.display} ${s.reserveBig}`}>{p.reserve.amount}<small>{p.reserve.unit}</small></b>
              <span className={s.coins} aria-label={`${p.reserve.coins.length} joined seats`}>
                <span className={s.coinRow}>
                  {p.reserve.coins.map((turn, index) => {
                    const slot = SEAT_SLOTS[index % SEAT_SLOTS.length];
                    return <span key={turn} className={s.coin} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)`, transform: `rotate(${[-8, 4, -3, 7, -5][index % 5]}deg)` }}>{turn + 1}</span>;
                  })}
                </span>
                <span className={s.coinNote}>{p.reserve.coinNote}</span>
              </span>
            </div>
            <dl className={s.ledger}>
              {p.reserve.lines.map(([sign, label, amount]) => (
                <div key={label} className={`${s.ledgerRow} ${sign === "=" ? s.ledgerSum : ""}`}>
                  <span className={s.ledgerSign} aria-hidden>{sign}</span><dt>{label}</dt><dd>{amount}</dd>
                </div>
              ))}
            </dl>
          </section>
          <section className={s.cover} aria-label={p.locks.label}>
            <span className={s.kicker}>{p.locks.kicker}</span>
            <span className={s.coverIntro}>{p.locks.intro}</span>
            <ol className={s.steps}>
              {p.locks.steps.map(([amount, label], index) => (
                <li key={label} className={`${s.step} ${index === p.locks.steps.length - 1 ? s.stepLast : ""}`}>
                  <span className={s.stepN}>{index + 1}</span><b className={s.display}>{amount}</b><span>{label}</span>
                </li>
              ))}
            </ol>
            <span className={s.coverChips}>
              {p.locks.chips.map(([label, value]) => <span key={label} className={s.coverChip}><span>{label}</span>{value}</span>)}
            </span>
          </section>
        </div>

        <section className={s.section} aria-label="Members">
          <div className={s.sectionHead}><span className={s.sectionLabel}>{p.members.head}</span><span className={s.sectionNote}>{p.members.note}</span></div>
          <div className={s.memberGrid}>
            {p.members.cards.map((m) => {
              const slot = SEAT_SLOTS[m.turn % SEAT_SLOTS.length];
              const tone = { teal: s.tagTeal, acid: s.tagAcid, cobalt: s.tagCobalt, clay: s.tagClay, "": "" };
              return (
                <article key={m.turn} className={s.member}>
                  <span className={s.stub} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)` }}>
                    <span className={s.micro}>Seat</span><b className={`${s.display} ${s.stubNum}`}>{m.turn + 1}</b>
                    <span className={s.stubWho}><b>{m.you ? "You" : "Member"}</b><span>{short(m.wallet)}{m.creator ? " · creator" : ""}</span></span>
                  </span>
                  <span className={s.memberBody}>
                    <span className={s.memberTop}>
                      <span className={s.kicker}>{m.you ? "Your stake" : "Member stake"}</span>
                      {m.you && <span className={s.youTag}>You</span>}
                      <a className={s.arrow} href={m.explorer} target="_blank" rel="noreferrer" aria-label={`Open ${short(m.wallet)} in the explorer`}>↗</a>
                    </span>
                    {m.stake}
                    <span className={s.chips}>
                      {m.chips.map((c) => <span key={`${c.label}-${c.value}`} className={`${s.chip} ${tone[c.tone]}`}><span>{c.label}</span>{c.value}</span>)}
                    </span>
                  </span>
                </article>
              );
            })}
          </div>
        </section>

        {p.extras}

        <footer className={s.footer}>{p.footer}</footer>
      </main>
    </Shell>
  );
}
