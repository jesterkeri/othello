"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { WalletControl } from "@/components/othello/WalletConnect";
import { ThemeRoot } from "@/components/theme/ThemeRoot";
import {
  coverageLabel,
  derive,
  formatDuration,
  formatRaw,
  formatUsdc,
  obligations,
  seatSet,
  shortAddress,
  stockCover,
  type CircleView,
} from "@/lib/circle";
import { STATE_KEYS, type CircleStateKey } from "@/fixtures/circles";
import { explorer } from "@/lib/devnet";

import s from "./Circle.module.css";

// Every product string on this screen is design/FLOWS.md §8 verbatim, either the
// Circle row of "Copy per place" or a row of "Errors and refusals". Do not
// rewrite copy here; design/ wins.

/**
 * T18: set when the circle is read from devnet rather than a fixture. The
 * screen is the same; what changes is what it claims about its data, the
 * money word (test USDC is never shown as USDC), and the connected member's
 * action. Fixture screens pass nothing and render exactly as before.
 */
export type LiveProps = {
  circleAddress: string;
  /** Unix seconds of the last successful read. */
  readAt: number;
  /** The last refresh's failure, shown over the last good read, never hidden. */
  error: string | null;
  mirrorLabel: string;
  usdcWord: string;
  /** The connected wallet's seat, 0-based, or null. */
  yourTurn: number | null;
  split: { multiplier: number; newMultiplier: number; effectiveAt: number };
  action: ReactNode;
  below: ReactNode;
};

export type CircleProps = {
  circle: CircleView;
  /** The clock this screen reads. Fixtures carry their own, so the countdown
   *  runs from the fixture's moment rather than from today. */
  startNow: number;
  stateKey: CircleStateKey | "demo";
  live?: LiveProps;
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

export default function Circle({ circle, startNow, stateKey, live }: CircleProps) {
  const USDC_SUFFIX = live ? live.usdcWord : "USDC";
  // Starts at the fixture's own moment so the server and the first client paint
  // agree, then ticks, which is what carries a round from open to overdue to
  // grace without anyone reloading.
  const [now, setNow] = useState(startNow);

  useEffect(() => {
    const id = window.setInterval(() => setNow((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  // A fresh live read resets the clock to the chain's moment.
  useEffect(() => {
    if (live) setNow(live.readAt);
  }, [live?.readAt]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // SPEC §7's halt arithmetic. SPEC.md:126 is explicit that the gate's own word
  // is `remaining`, R - L, not the Guarantee panel's `free`, R - L - allocated.
  // Printing free here would understate what the reserve holds.
  const gateNeeded = d.remains + c.nextGateShortBy;

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
          {live ? (
            <WalletControl />
          ) : (
            <span className={`${s.viewerPill} ${s.micro}`}>Viewing, no wallet</span>
          )}
        </header>

        <div className={s.devnet}>
          <span className={s.devnetPill}>
            <Dots />
            <span className={s.micro}>Devnet demo</span>
          </span>
          {live ? (
            <p className={s.devnetText}>
              Live from devnet:{" "}
              <a className={s.link} href={explorer("address", live.circleAddress)} target="_blank" rel="noreferrer">
                circle {shortAddress(live.circleAddress)}
              </a>
              , read {formatDuration(now - live.readAt)} ago. Collateral is the {live.mirrorLabel}; money is{" "}
              {live.usdcWord}.
              {live.split.effectiveAt > now && live.split.newMultiplier !== live.split.multiplier
                ? ` Split scheduled: x${live.split.multiplier} to x${live.split.newMultiplier} in ${formatDuration(live.split.effectiveAt - now)}.`
                : ""}{" "}
              <Link className={s.link} href="/split-lab">
                What a split does to locked stock
              </Link>
            </p>
          ) : (
            <p className={s.devnetText}>
              This circle renders from a committed fixture, not from a live devnet account.
            </p>
          )}
        </div>

        <div className={s.banners}>
          {live?.error && (
            <Banner
              kind="refusal"
              mark="?"
              title="Live data unavailable"
              text={`The last read of devnet failed (${live.error}). Showing the read from ${formatDuration(now - live.readAt)} ago.`}
            />
          )}
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
              text={`The next payout needs ${formatUsdc(gateNeeded)} ${USDC_SUFFIX} of reserve and ${formatUsdc(d.remains)} remains. Top up ${formatUsdc(c.nextGateShortBy)} ${USDC_SUFFIX}, returned pro rata at the end, minus any default losses.`}
            />
          )}
          {isActive && !d.funded && !d.repricing && (
            <Banner
              kind="neutral"
              mark={String(d.missing)}
              title={`${d.missing} contributions still missing`}
              text={
                live
                  ? `Once everyone has paid, anyone can release the pot${d.recipient ? ` to ${d.recipient.name}` : ""}. Paying late still counts.`
                  : "Wait, or remind them."
              }
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

          {isActive && live && d.toDeadline <= 0 && (() => {
            // Live mode, deadline passed. Lateness alone is not a failure: contribute has no time
            // check, and only a seat that has already received its pot can be defaulted (SPEC §5,
            // KNOWN-LIMITS L3). Say which of those is true, instead of OVERDUE and ELAPSED.
            const defaultable = c.members.filter(
              (m) => !seatSet(c.paidBitmap, m.turn) && seatSet(c.receivedBitmap, m.turn) && !seatSet(c.defaultedBitmap, m.turn),
            );
            return (
              <div className={s.clock}>
                <span className={s.clockBox}>
                  <span className={s.clockLabel}>Paid this round</span>
                  <span className={`${s.display} ${s.clockValue}`}>
                    {c.n - d.missing} of {c.n}
                  </span>
                </span>
                {/* SPEC §5 / I7: declare_default needs now > deadline + grace, strictly. */}
                {defaultable.length > 0 && d.toGraceEnd < 0 ? (
                  <span className={`${s.clockBox} ${s.clockOver}`}>
                    <span className={s.clockLabel}>Can be declared in default</span>
                    <span className={`${s.display} ${s.clockValue}`}>{defaultable.map((m) => m.name).join(", ")}</span>
                  </span>
                ) : (
                  <span className={s.clockBox}>
                    <span className={s.clockLabel}>Deadline passed</span>
                    <span className={`${s.display} ${s.clockValue}`}>Late still counts</span>
                  </span>
                )}
                <span className={s.clockBox}>
                  <span className={s.clockLabel}>Pot this round</span>
                  <span className={`${s.display} ${s.clockValue}`}>{formatUsdc(c.contribution * c.n, 0)}</span>
                </span>
              </div>
            );
          })()}

          {isActive && !(live && d.toDeadline <= 0) && (
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

        {live?.action}

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
          <div className={`${s.card} ${s.cardReserve}`}>
            <span className={s.micro}>Shared reserve, free</span>
            <span className={`${s.display} ${s.cardBig}`}>
              {formatUsdc(d.free, 0)} {USDC_SUFFIX}
            </span>
            <div className={s.bar} aria-hidden>
              <span
                className={s.barFill}
                style={{
                  width: `${c.reserveTotal > 0 ? Math.round((d.free / c.reserveTotal) * 100) : 0}%`,
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
                <span className={s.rowLabel}>Allocated to cover</span>
                <span className={s.rowValue}>{formatUsdc(c.reserveAllocated)}</span>
              </span>
              <span className={s.row}>
                <span className={s.rowLabel}>Remains, the gate's figure</span>
                <span className={s.rowValue}>{formatUsdc(d.remains)}</span>
              </span>
              <span className={s.row}>
                <span className={s.rowLabel}>Next payout needs</span>
                <span className={s.rowValue}>{formatUsdc(gateNeeded)}</span>
              </span>
            </div>
          </div>

          <div className={`${s.card} ${s.cardCoverage}`}>
            <span className={s.micro}>Cover per member</span>
            <span className={`${s.display} ${s.cardBig}`}>
              {d.repricing
                ? "Not countable"
                : `${formatUsdc(c.members[0] ? stockCover(c.members[0], c) : 0, 0)} ${USDC_SUFFIX}`}
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
                  <th scope="col">Owed</th>
                  <th scope="col">Coverage</th>
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
                        {/* design/FLOWS.md §4: member row -> [Position]. The
                            Position place reads fixtures, so a live row links
                            to the member's account on the explorer instead. */}
                        <Link
                          href={
                            live
                              ? explorer("address", m.address)
                              : `/circle/${stateKey}/position/${m.turn + 1}`
                          }
                          target={live ? "_blank" : undefined}
                          className={s.seatCell}
                        >
                          <span className={`${s.seatDisc} ${isNow ? s.seatDiscNow : ""}`}>
                            {m.turn + 1}
                          </span>
                          <span className={s.seatName}>
                            <span>
                              {m.name}
                              {live?.yourTurn === m.turn && (
                                <span className={`${s.tag} ${s.tagYes} ${s.you}`}>You</span>
                              )}
                            </span>
                            <span className={s.seatAddr}>{shortAddress(m.address)}</span>
                          </span>
                        </Link>
                      </td>
                      <td>
                        {defaulted ? (
                          <span className={`${s.tag} ${s.tagGone}`}>Defaulted</span>
                        ) : !joined && live ? (
                          <span className={`${s.tag} ${s.tagNo}`}>Not joined</span>
                        ) : !joined ? (
                          <Link
                            href={`/circle/${stateKey}/join/${m.turn + 1}`}
                            className={`${s.tag} ${s.tagNo}`}
                          >
                            Not joined
                          </Link>
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
                        {!joined
                          ? "—"
                          : d.repricing
                            ? "Not countable"
                            : `${formatUsdc(stockCover(m, c))} ${USDC_SUFFIX}`}
                      </td>
                      <td className={s.num}>
                        {joined ? `${formatUsdc(obligations(c, m))} ${USDC_SUFFIX}` : "—"}
                      </td>
                      <td className={s.num}>
                        {!joined ? "—" : d.repricing ? "Not countable" : coverageLabel(c, m)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {live?.below}

        <div className={s.footer}>
          <p className={s.helper}>
            {/* last_coverage_at is 0 until the first recompute (update_coverage
                or release_pot); "prices from 20,000 days ago" would be a lie. */}
            {c.lastCoverageAt === 0
              ? "Coverage has not been computed yet: it is first computed when a pot is released or coverage is updated."
              : `Coverage uses prices from ${formatDuration(d.coverageAge)} ago.`}{" "}
            Counted at the lower of its market price and its share price, minus a{" "}
            {c.haircutBps / 100}% safety margin.
          </p>
          {live ? (
            <nav className={s.states} aria-label="Design states">
              <Link href="/circle/active" className={s.stateLink}>
                Every design state, from fixtures
              </Link>
            </nav>
          ) : (
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
          )}
        </div>
      </div>
    </ThemeRoot>
  );
}
