"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { WalletControl } from "@/components/othello/WalletConnect";
import Shell from "@/components/othello/Shell";
import {
  execValue,
  fundValue,
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

/** Each seat's colour, in turn order (Circle.dc.html handoff). */
const SEAT_SLOTS = ["teal", "acid", "sky", "clay", "cobalt"] as const;

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
  // What each member locked, in the words it must always carry: the demo's stock is a labelled mirror.
  // The live read names it "NFLXx mirror"; say which network it is a mirror on, once.
  const stockUnit = live ? `${c.stockSymbol.replace(/\s*mirror$/i, "")} devnet mirror` : c.stockSymbol;

  return (
    <Shell active="Circles">
      <div className={s.frame}>

        {/* The Shell's top bar carries the Devnet chip; this line says which circle and when. */}
        <div className={s.devnet}>
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
                  ? `Once everyone has paid${d.paused ? " and the reserve covers the next payout" : ""}${d.stale ? " and the price is fresh" : ""}, anyone can release the pot${d.recipient ? ` to ${d.recipient.name}` : ""}. Paying late still counts.`
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

        <section className={s.hero} aria-label="This round">
          <div className={s.heroMain}>
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
          </div>
          <div className={s.act}>
            {live ? (
              live.action
            ) : (
              <p className={s.actFixture}>
                A committed fixture, shown for its design state. Nothing here sends a transaction; the live
                circle is at /circle/demo.
              </p>
            )}
          </div>
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

        <div className={s.money}>
          <section className={s.reserve} aria-label="Shared reserve">
            <span className={s.kicker}>Shared reserve, free</span>
            <div className={s.reserveTop}>
              <b className={`${s.display} ${s.reserveBig}`}>
                {formatUsdc(d.free)}
                <small>{USDC_SUFFIX}</small>
              </b>
              <span
                className={s.coins}
                role="img"
                aria-label={`${d.joined} deposits of ${formatUsdc(c.guaranteePerMember)} ${USDC_SUFFIX}, one per joined seat`}
              >
                <span className={s.coinRow}>
                  {c.members
                    .filter((m) => seatSet(c.joinedBitmap, m.turn))
                    .map((m, i) => (
                      <span key={m.address} className={s.coin} style={{ transform: `rotate(${[-8, 4, -3, 7, -5, 3, -6, 5][i % 8]}deg)` }}>
                        {m.turn + 1}
                      </span>
                    ))}
                </span>
                <span className={s.coinNote}>
                  {d.joined} deposits of {formatUsdc(c.guaranteePerMember)}, one per seat
                </span>
              </span>
            </div>
            <dl className={s.ledger}>
              {(
                [
                  ["+", "Deposited", c.reserveTotal],
                  ["−", "Spent on defaults", c.reserveLosses],
                  ["−", "Allocated to cover", c.reserveAllocated],
                  ["=", "Remains, the gate's figure", d.remains],
                  ["→", "Next payout needs", gateNeeded],
                ] as const
              ).map(([sign, k, v]) => (
                <div key={k} className={`${s.ledgerRow} ${sign === "=" ? s.ledgerSum : ""}`}>
                  <span aria-hidden className={s.ledgerSign}>
                    {sign}
                  </span>
                  <dt>{k}</dt>
                  <dd>
                    {formatUsdc(v)} {USDC_SUFFIX}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section className={s.cover} aria-label="Cover per member">
            <span className={s.kicker}>Cover per member</span>
            {(() => {
              const m0 = c.members.find((m) => seatSet(c.joinedBitmap, m.turn));
              if (!m0) return <span className={s.coverIntro}>Nobody has locked stock yet.</span>;
              const steps: [string, string][] = [
                [formatRaw(m0.lockedRaw), `${stockUnit} locked`],
                [formatUsdc(Math.min(fundValue(m0, c), execValue(m0, c))), `${USDC_SUFFIX}, lower of market and share price`],
                [`−${c.haircutBps / 100}%`, "safety margin"],
                [d.repricing ? "Not countable" : formatUsdc(stockCover(m0, c), 0), d.repricing ? "price and split disagree" : `${USDC_SUFFIX} of cover`],
              ];
              return (
                <>
                  <span className={s.coverIntro}>
                    How {m0.name}&apos;s locked {stockUnit} becomes cover.
                  </span>
                  <ol className={s.steps}>
                    {steps.map(([v, k], i) => (
                      <li key={k} className={`${s.step} ${i === 3 ? s.stepLast : ""}`}>
                        <span className={s.stepN}>{i + 1}</span>
                        <b className={s.display}>{v}</b>
                        <span>{k}</span>
                      </li>
                    ))}
                  </ol>
                </>
              );
            })()}
            <span className={s.coverChips}>
              <span className={s.coverChip}>
                <span>Minimum to join</span>
                {formatUsdc(c.minStockCover)} {USDC_SUFFIX} of cover
              </span>
              <span className={s.coverChip}>
                <span>Coverage target</span>
                {c.coverageBps / 100}%
              </span>
              <span className={s.coverChip}>
                <span>Held this round</span>
                {formatUsdc(c.heldContributions)} {USDC_SUFFIX}
              </span>
            </span>
          </section>
        </div>

        <section className={s.section} aria-label="Members">
          <div className={s.sectionHead}>
            <span className={s.sectionLabel}>
              Members ({d.joined} of {c.n} joined)
            </span>
            <span className={s.sectionNote}>
              <b>Each stake is still its owner&apos;s.</b> Returned when the circle ends, unless they default after
              taking the pot.
            </span>
          </div>
          <div className={s.memberGrid}>
            {c.members.map((m) => {
              const joined = seatSet(c.joinedBitmap, m.turn);
              const paid = seatSet(c.paidBitmap, m.turn);
              const received = seatSet(c.receivedBitmap, m.turn);
              const defaulted = seatSet(c.defaultedBitmap, m.turn);
              const withdrawn = seatSet(c.withdrawnBitmap, m.turn);
              const isNow = isActive && m.turn === c.round;
              const you = live?.yourTurn === m.turn;
              const slot = SEAT_SLOTS[m.turn % SEAT_SLOTS.length]!;
              const [roundWord, roundTag] = defaulted
                ? ["Defaulted", s.tagClay]
                : !joined
                  ? ["Not joined", ""]
                  : !isActive
                    ? [withdrawn ? "Withdrawn" : "To withdraw", ""]
                    : paid
                      ? ["Paid", s.tagTeal]
                      : ["Due", s.tagAcid];
              const [potWord, potTag] = received ? ["Received", s.tagTeal] : isNow ? ["Receiving", s.tagCobalt] : ["Waiting", ""];
              return (
                /* design/FLOWS.md §4: member row -> [Position]; a seat not joined yet -> [Join].
                   The live circle's seat pages read the chain too (LiveSeat, T18c). */
                <Link
                  key={m.address}
                  href={`/circle/${stateKey}/${joined ? "position" : "join"}/${m.turn + 1}`}
                  className={s.member}
                  aria-label={`Seat ${m.turn + 1}, ${m.name}, ${shortAddress(m.address)}.${joined ? ` Locked ${formatRaw(m.lockedRaw)} ${stockUnit}.` : " Not joined."}`}
                >
                  <span className={s.stub} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)` }}>
                    <span className={s.micro}>Seat</span>
                    <b className={`${s.display} ${s.stubNum}`}>{m.turn + 1}</b>
                    <span className={s.stubWho}>
                      <b>{m.name}</b>
                      <span>{shortAddress(m.address)}</span>
                    </span>
                  </span>
                  <span className={s.memberBody}>
                    <span className={s.memberTop}>
                      <span className={s.kicker}>{you ? "Your stake" : `${m.name}'s stake`}</span>
                      {you && <span className={s.youTag}>You</span>}
                      <span className={s.arrow} aria-hidden>
                        <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
                          <path d="M7 17 17 7M9 7h8v8" />
                        </svg>
                      </span>
                    </span>
                    {joined ? (
                      <span className={s.stake}>
                        <span className={s.lockedLine}>
                          <span className={s.lockedLabel}>Locked:</span>
                          <b className={`${s.display} ${s.lockedAmt}`}>{formatRaw(m.lockedRaw)}</b>
                          <span className={s.lockedUnit}>{stockUnit}</span>
                        </span>
                        <span className={s.coverLine}>
                          {d.repricing ? (
                            "Cover not countable while price and split disagree"
                          ) : (
                            <>
                              Counts as{" "}
                              <b style={{ boxShadow: `inset 0 -6px 0 var(--${slot})` }}>
                                {formatUsdc(stockCover(m, c))} {USDC_SUFFIX}
                              </b>{" "}
                              of cover
                            </>
                          )}
                        </span>
                      </span>
                    ) : (
                      <span className={s.coverLine}>Not joined yet: nothing locked.</span>
                    )}
                    <span className={s.chips}>
                      <span className={`${s.chip} ${roundTag}`}>
                        <span>This round</span>
                        {roundWord}
                      </span>
                      <span className={`${s.chip} ${potTag}`}>
                        <span>Pot</span>
                        {potWord}
                      </span>
                      <span className={s.chip}>
                        <span>Owed</span>
                        {joined ? `${formatUsdc(obligations(c, m))} ${USDC_SUFFIX}` : "—"}
                      </span>
                      <span className={s.chip}>
                        <span>Coverage</span>
                        {!joined ? "—" : d.repricing ? "Not countable" : coverageLabel(c, m)}
                      </span>
                    </span>
                  </span>
                </Link>
              );
            })}
          </div>
        </section>

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
    </Shell>
  );
}
