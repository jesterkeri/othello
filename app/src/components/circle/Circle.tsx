"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ThemeRoot } from "@/components/theme/ThemeRoot";
import {
  derive,
  formatDuration,
  formatRaw,
  formatUsdc,
  seatSet,
  shortAddress,
  type CircleView,
} from "@/lib/circle";
import { STATE_KEYS, type CircleStateKey } from "@/fixtures/circles";

import s from "./Circle.module.css";

// Every product string on this screen is design/FLOWS.md §8 verbatim, either the
// Circle row of "Copy per place" or a row of "Errors and refusals". Do not
// rewrite copy here; design/ wins.

const USDC_SUFFIX = "USDC";

export type CircleProps = {
  circle: CircleView;
  /** The clock this screen reads. Fixtures carry their own, so the countdown
   *  runs from the fixture's moment rather than from today. */
  startNow: number;
  stateKey: CircleStateKey;
};

function Dots() {
  return (
    <span className={s.dotRun} aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <span key={i} />
      ))}
    </span>
  );
}

function Banner({
  kind,
  title,
  text,
  mark,
}: {
  kind: "neutral" | "refusal";
  title: string;
  text: string;
  mark: string;
}) {
  return (
    <div
      className={`${s.banner} ${kind === "refusal" ? s.bannerRefusal : s.bannerNeutral}`}
      role="status"
    >
      <span className={s.bannerMark} aria-hidden>
        {mark}
      </span>
      <span className={s.bannerBody}>
        <span className={s.bannerTitle}>{title}</span>
        <p className={s.bannerText}>{text}</p>
      </span>
    </div>
  );
}

export default function Circle({ circle, startNow, stateKey }: CircleProps) {
  // Starts at the fixture's own moment so the server and the first client paint
  // agree, then ticks, which is what carries a round from open to overdue to
  // grace without anyone reloading.
  const [now, setNow] = useState(startNow);

  useEffect(() => {
    const id = window.setInterval(() => setNow((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const d = derive(circle, now);
  const c = circle;

  const statusWord = d.repricing
    ? "Repricing"
    : d.paused
      ? "Paused"
      : c.status;

  const statusClass = d.repricing
    ? s.statusRepricing
    : d.paused
      ? s.statusPaused
      : c.status === "Forming"
        ? s.statusForming
        : c.status === "Active"
          ? s.statusActive
          : c.status === "Completed"
            ? s.statusCompleted
            : s.statusCancelled;

  const isActive = c.status === "Active";
  const heading =
    isActive && d.recipient
      ? `Round ${c.round + 1} of ${c.n} · ${d.recipient.name}'s turn`
      : c.status === "Forming"
        ? "Waiting for members to join"
        : c.status === "Completed"
          ? "Every seat has been paid"
          : "This circle was cancelled";

  // SPEC §7's halt arithmetic: what the next gate needs is what remains plus
  // what it is short by.
  const gateNeeded = d.available + c.nextGateShortBy;

  return (
    <ThemeRoot className={s.root}>
      <div className={s.frame}>
        <header className={s.nav}>
          <span className={s.logo} aria-label="Othello">
            O
          </span>
          <Link href="/" className={s.back}>
            <span aria-hidden>{"←"}</span> Back
          </Link>
          <span className={s.navSpacer} />
          <span className={`${s.viewerPill} ${s.micro}`}>Viewing, no wallet</span>
        </header>

        <div className={s.devnet}>
          <span className={s.devnetPill}>
            <Dots />
            <span className={s.micro}>Devnet demo</span>
          </span>
          <p className={s.devnetText}>
            This circle renders from a committed fixture, not from a live devnet account.
          </p>
        </div>

        <div className={s.banners}>
          {d.repricing && (
            <Banner
              kind="neutral"
              mark="!"
              title="Repricing. Price and split disagree."
              text="Payouts wait. The demo admin sets a price for the new multiplier, then anyone can update coverage."
            />
          )}
          {d.stale && (
            <Banner
              kind="neutral"
              mark="?"
              title={`Prices are ${formatDuration(d.priceAge)} old`}
              text="Recheck after update."
            />
          )}
          {d.paused && (
            <Banner
              kind="refusal"
              mark="!"
              title="Payouts paused."
              text={`The next payout needs ${formatUsdc(gateNeeded)} ${USDC_SUFFIX} of reserve and ${formatUsdc(d.available)} remains. Top up ${formatUsdc(c.nextGateShortBy)} ${USDC_SUFFIX}, returned pro rata at the end, minus any default losses.`}
            />
          )}
          {isActive && !d.funded && !d.repricing && (
            <Banner
              kind="neutral"
              mark={String(d.missing)}
              title={`${d.missing} contributions still missing`}
              text="Wait, or remind them."
            />
          )}
          {!isActive && c.status !== "Forming" && (
            <Banner
              kind="neutral"
              mark="i"
              title={`This circle isn't running right now (${c.status})`}
              text="Each member withdraws their stock, unused guarantee and top-ups."
            />
          )}
        </div>

        <section className={s.head}>
          <div className={s.headTop}>
            <span className={`${s.statusPill} ${statusClass} ${s.micro}`}>{statusWord}</span>
            <span className={`${s.stockPill} ${s.micro}`}>{c.stockSymbol} locked as cover</span>
          </div>
          <h1 className={`${s.display} ${s.h1}`}>{heading}</h1>
          <p className={s.sub}>
            {formatUsdc(c.contribution)} {USDC_SUFFIX} per member per round. Each seat receives
            the whole pot once, in turn.
          </p>

          {isActive && (
            <div className={s.clock}>
              <span className={`${s.clockBox} ${d.toDeadline <= 0 ? s.clockOver : ""}`}>
                <span className={s.clockLabel}>
                  {d.toDeadline > 0 ? "Round closes in" : "Round closed"}
                </span>
                <span className={`${s.display} ${s.clockValue}`}>
                  {d.toDeadline > 0 ? formatDuration(d.toDeadline) : "Overdue"}
                </span>
              </span>
              {d.toDeadline <= 0 && (
                <span className={s.clockBox}>
                  <span className={s.clockLabel}>
                    {d.toGraceEnd > 0 ? "Grace ends in" : "Grace ended"}
                  </span>
                  <span className={`${s.display} ${s.clockValue}`}>
                    {d.toGraceEnd > 0 ? formatDuration(d.toGraceEnd) : "Elapsed"}
                  </span>
                </span>
              )}
              <span className={s.clockBox}>
                <span className={s.clockLabel}>Pot this round</span>
                <span className={`${s.display} ${s.clockValue}`}>
                  {formatUsdc(c.contribution * c.n, 0)}
                </span>
              </span>
            </div>
          )}
        </section>

        {c.status === "Forming" ? (
          <div className={s.section}>
            <div className={s.empty}>
              <span className={`${s.display} ${s.emptyTitle}`}>
                Waiting for {c.n - d.joined} members to join
              </span>
              <p className={s.bannerText}>
                {d.joined} of {c.n} have locked their stock and put{" "}
                {formatUsdc(c.guaranteePerMember)} {USDC_SUFFIX} into the shared reserve. The
                creator activates the circle when everyone has joined.
              </p>
            </div>
          </div>
        ) : (
          <div className={s.section}>
            <div className={s.sectionHead}>
              <span className={s.sectionLabel}>Turn order</span>
              <span className={s.sectionLabel}>
                {c.roundSecs}s rounds, {c.graceSecs}s grace
              </span>
            </div>
            <div className={s.timeline}>
              {c.members.map((m) => {
                const done = seatSet(c.receivedBitmap, m.turn);
                const nowRound = isActive && m.turn === c.round;
                return (
                  <div
                    key={m.address}
                    className={`${s.round} ${nowRound ? s.roundNow : done ? s.roundDone : ""}`}
                  >
                    <span className={s.roundNum}>Round {m.turn + 1}</span>
                    <span className={s.roundName}>{m.name}</span>
                    <span className={s.roundNote}>
                      {done ? "Pot paid" : nowRound ? "Receiving now" : "Upcoming"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className={s.cards}>
          <div className={s.cardReserve}>
            <span className={s.micro}>Shared reserve</span>
            <span className={`${s.display} ${s.cardBig}`}>
              {formatUsdc(d.available, 0)} {USDC_SUFFIX}
            </span>
            <div className={s.bar} aria-hidden>
              <span
                className={s.barFill}
                style={{
                  width: `${c.reserveTotal > 0 ? Math.round((d.available / c.reserveTotal) * 100) : 0}%`,
                }}
              />
            </div>
            <div className={s.rows}>
              <span className={s.row}>
                <span className={s.rowLabel}>Deposited</span>
                <span className={s.rowValue}>{formatUsdc(c.reserveTotal)}</span>
              </span>
              <span className={s.row}>
                <span className={s.rowLabel}>Spent on defaults</span>
                <span className={s.rowValue}>{formatUsdc(c.reserveLosses)}</span>
              </span>
              <span className={s.row}>
                <span className={s.rowLabel}>Next payout needs</span>
                <span className={s.rowValue}>{formatUsdc(gateNeeded)}</span>
              </span>
            </div>
          </div>

          <div className={s.cardCoverage}>
            <span className={s.micro}>Cover per member</span>
            <span className={`${s.display} ${s.cardBig}`}>
              {formatUsdc(c.members[0]?.stockCover ?? 0, 0)} {USDC_SUFFIX}
            </span>
            <div className={s.rows}>
              <span className={s.row}>
                <span className={s.rowLabel}>Minimum to join</span>
                <span className={s.rowValue}>{formatUsdc(c.minStockCover)}</span>
              </span>
              <span className={s.row}>
                <span className={s.rowLabel}>Safety margin</span>
                <span className={s.rowValue}>{c.haircutBps / 100}%</span>
              </span>
              <span className={s.row}>
                <span className={s.rowLabel}>Coverage target</span>
                <span className={s.rowValue}>{c.coverageBps / 100}%</span>
              </span>
              <span className={s.row}>
                <span className={s.rowLabel}>Held this round</span>
                <span className={s.rowValue}>{formatUsdc(c.heldContributions)}</span>
              </span>
            </div>
          </div>
        </div>

        <div className={s.section}>
          <div className={s.sectionHead}>
            <span className={s.sectionLabel}>Members</span>
            <span className={s.sectionLabel}>
              {d.joined} of {c.n} joined
            </span>
          </div>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">Seat</th>
                  <th scope="col">This round</th>
                  <th scope="col">Pot</th>
                  <th scope="col">Locked {c.stockSymbol}</th>
                  <th scope="col">Stock cover</th>
                </tr>
              </thead>
              <tbody>
                {c.members.map((m) => {
                  const joined = seatSet(c.joinedBitmap, m.turn);
                  const paid = seatSet(c.paidBitmap, m.turn);
                  const received = seatSet(c.receivedBitmap, m.turn);
                  const defaulted = seatSet(c.defaultedBitmap, m.turn);
                  const withdrawn = seatSet(c.withdrawnBitmap, m.turn);
                  const isNow = isActive && m.turn === c.round;
                  return (
                    <tr key={m.address}>
                      <td>
                        <span className={s.seatCell}>
                          <span className={`${s.seatDisc} ${isNow ? s.seatDiscNow : ""}`}>
                            {m.turn + 1}
                          </span>
                          <span className={s.seatName}>
                            <span>{m.name}</span>
                            <span className={s.seatAddr}>{shortAddress(m.address)}</span>
                          </span>
                        </span>
                      </td>
                      <td>
                        {defaulted ? (
                          <span className={`${s.tag} ${s.tagGone}`}>Defaulted</span>
                        ) : !joined ? (
                          <span className={`${s.tag} ${s.tagNo}`}>Not joined</span>
                        ) : !isActive ? (
                          <span className={`${s.tag} ${s.tagDone}`}>
                            {withdrawn ? "Withdrawn" : "To withdraw"}
                          </span>
                        ) : paid ? (
                          <span className={`${s.tag} ${s.tagYes}`}>Paid</span>
                        ) : (
                          <span className={`${s.tag} ${s.tagDue}`}>Due</span>
                        )}
                      </td>
                      <td>
                        <span className={`${s.tag} ${received ? s.tagDone : s.tagNo}`}>
                          {received ? "Received" : isNow ? "Receiving" : "Waiting"}
                        </span>
                      </td>
                      <td className={s.num}>{joined ? formatRaw(m.lockedRaw) : "—"}</td>
                      <td className={s.num}>
                        {joined ? `${formatUsdc(m.stockCover)} ${USDC_SUFFIX}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className={s.footer}>
          <p className={s.helper}>
            Coverage uses prices from {formatDuration(d.coverageAge)} ago. Counted at the lower
            of its market price and its share price, minus a {c.haircutBps / 100}% safety
            margin.
          </p>
          <nav className={s.states} aria-label="Circle states">
            {STATE_KEYS.map((k) => (
              <Link
                key={k}
                href={`/circle/${k}`}
                className={`${s.stateLink} ${k === stateKey ? s.stateOn : ""}`}
              >
                {k}
              </Link>
            ))}
            <Link
              href="/circle/stale"
              className={`${s.stateLink} ${stateKey === "active" && d.stale ? s.stateOn : ""}`}
            >
              stale
            </Link>
          </nav>
        </div>
      </div>
    </ThemeRoot>
  );
}
