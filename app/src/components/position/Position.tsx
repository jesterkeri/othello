"use client";

import Link from "next/link";

import { ThemeRoot } from "@/components/theme/ThemeRoot";
import shell from "@/components/circle/Circle.module.css";
import {
  coverageLabel,
  derive,
  formatDuration,
  formatRaw,
  formatUsdc,
  memberBySeat,
  obligations,
  scaledRaw,
  seatSet,
  shortAddress,
  stockCover,
  execValue,
  fundValue,
  type CircleView,
} from "@/lib/circle";
import type { CircleStateKey } from "@/fixtures/circles";

import s from "@/components/ui/Screen.module.css";

// Product strings are design/FLOWS.md §8 verbatim. Position's row gives the
// heading "{name}'s position", primary "Lock more stock", secondary "Back",
// helper "Counted at the lower of its market price and its share price, minus a
// {haircut}% safety margin", and empty "Not joined yet".


export default function Position({
  circle,
  seat,
  now,
  stateKey,
  usdcWord,
}: {
  circle: CircleView;
  seat: number;
  now: number;
  /** Where its links point: a fixture state, or "demo" for the live devnet circle (T18). */
  stateKey: CircleStateKey | "demo";
  /** The money word. The live demo's money is test USDC and must never read as real USDC. */
  usdcWord?: string;
}) {
  const c = circle;
  const USDC = usdcWord ?? "USDC";
  const m = memberBySeat(c, seat);
  const d = derive(c, now);

  if (!m) {
    return (
      <ThemeRoot className={shell.root}>
        <div className={shell.frame}>
          <div className={s.wrap}>
            <h1 className={`${shell.display} ${s.headline}`}>No such seat</h1>
            <Link href={`/circle/${stateKey}`} className={s.secondary}>
              Back
            </Link>
          </div>
        </div>
      </ThemeRoot>
    );
  }

  const joined = seatSet(c.joinedBitmap, m.turn);
  const withdrawn = seatSet(c.withdrawnBitmap, m.turn);
  const defaulted = seatSet(c.defaultedBitmap, m.turn);

  // D5: during Repricing the program refuses to compute fundamental value, so
  // the screen must not print one either.
  const countable = !d.repricing;
  const cover = countable ? stockCover(m, c) : 0;
  const owed = obligations(c, m);

  const figures: { label: string; value: string; note?: string; wide?: boolean }[] = [
    {
      label: `Locked ${c.stockSymbol}`,
      value: `${formatRaw(m.lockedRaw)} ${c.stockSymbol}`,
      note: "What you handed over. It is still yours.",
    },
    {
      label: "Shown by your wallet",
      value: `${formatRaw(scaledRaw(m, c))} ${c.stockSymbol}`,
      note: "Raw balance times the multiplier.",
    },
    {
      label: "Multiplier",
      value: (c.effectiveMultiplier / 1_000_000_000).toFixed(9),
      note: c.feed.pricedForMultiplier === c.effectiveMultiplier
        ? "Prices are stamped for this multiplier."
        : "Prices are stamped for a different multiplier.",
    },
    {
      label: "Market price",
      value: `${formatUsdc(c.feed.wrapperPrice)} ${USDC}`,
      note: "Per whole token, as traded.",
    },
    {
      label: "Share price",
      value: `${formatUsdc(c.feed.sharePrice)} ${USDC}`,
      note: "Per underlying share.",
    },
    { label: "Safety margin", value: `${c.haircutBps / 100}%` },
    {
      label: "Stock cover",
      value: countable ? `${formatUsdc(cover)} ${USDC}` : "Not countable",
      note: countable
        ? `Lower of ${formatUsdc(fundValue(m, c))} and ${formatUsdc(execValue(m, c))}, less the margin.`
        : "Price and split disagree.",
    },
    {
      label: "Reserve cover",
      value: `${formatUsdc(m.allocated)} ${USDC}`,
      note: "Your share of the circle's reserve, allocated to you.",
    },
    {
      label: "Owed",
      value: `${formatUsdc(owed)} ${USDC}`,
      note: owed === 0 ? "Nothing is owed until you have received your pot." : undefined,
    },
    {
      label: "Coverage",
      value: countable ? coverageLabel(c, m) : "Not countable",
    },
    {
      label: "Most you could lose",
      value: `${formatUsdc(c.guaranteePerMember)} ${USDC}`,
      note: "Your reserve deposit, only if other members default and their stock doesn't cover it.",
    },
    {
      label: "Last checked",
      value: `${formatDuration(d.coverageAge)} ago`,
      note: "Coverage is only as fresh as the last update.",
    },
  ];

  return (
    <ThemeRoot className={shell.root}>
      <div className={shell.frame}>
        <header className={shell.nav}>
          <span className={shell.logo} aria-label="Othello">
            O
          </span>
          <Link href={`/circle/${stateKey}`} className={shell.back}>
            <span aria-hidden>{"←"}</span> Back
          </Link>
          <span className={shell.navSpacer} />
          <span className={`${shell.viewerPill} ${shell.micro}`}>Viewing, no wallet</span>
        </header>

        <div className={s.wrap}>
          <div className={shell.headTop}>
            <span className={`${shell.statusPill} ${shell.statusActive} ${shell.micro}`}>
              Seat {seat} of {c.n}
            </span>
            <span className={`${shell.stockPill} ${shell.micro}`}>{shortAddress(m.address)}</span>
            {defaulted && (
              <span className={`${shell.statusPill} ${shell.statusRepricing} ${shell.micro}`}>
                Defaulted
              </span>
            )}
          </div>

          <h1 className={`${shell.display} ${s.headline}`}>{m.name}&apos;s position</h1>

          {!joined ? (
            <>
              <p className={s.lede}>Not joined yet</p>
              <div className={s.refusal}>
                <span className={s.refusalTitle}>
                  You need stock worth {formatUsdc(c.minStockCover)} {USDC} of cover to join
                </span>
                <p className={s.refusalText}>
                  Nothing is locked for this seat and nothing is at risk. The invite is still
                  open while the circle is Forming.
                </p>
              </div>
              <div className={s.actions}>
                <Link href={`/circle/${stateKey}/join/${seat}`} className={s.secondary}>
                  View the invite
                </Link>
              </div>
            </>
          ) : (
            <>
              <p className={s.lede}>
                Counted at the lower of its market price and its share price, minus a{" "}
                {c.haircutBps / 100}% safety margin.
              </p>

              {withdrawn && (
                <div className={s.refusal}>
                  <span className={s.refusalTitle}>You&apos;ve already withdrawn from this circle</span>
                  <p className={s.refusalText}>
                    The stock went back to this wallet, with the unused guarantee and top-ups.
                  </p>
                </div>
              )}

              <div className={s.figures}>
                <div className={s.figGroup}>
                  {figures.map((f) => (
                    <div key={f.label} className={`${s.fig} ${f.wide ? s.figWide : ""}`}>
                      <span className={s.figLabel}>{f.label}</span>
                      <span className={s.figValue}>{f.value}</span>
                      {f.note && <span className={s.figNote}>{f.note}</span>}
                    </div>
                  ))}
                </div>
              </div>

              <div className={s.actions}>
                <button className={s.primary} disabled>
                  Lock more stock
                </button>
                <Link href={`/circle/${stateKey}`} className={s.secondary}>
                  Back
                </Link>
                <p className={s.why}>
                  Locking more stock is a transaction, so it needs a connected wallet. This
                  page is the viewer, which reads accounts and signs nothing.
                </p>
              </div>
            </>
          )}

          <nav className={s.seats} aria-label="Seats">
            {c.members.map((mm) => (
              <Link
                key={mm.address}
                href={`/circle/${stateKey}/position/${mm.turn + 1}`}
                className={`${s.seatLink} ${mm.turn + 1 === seat ? s.seatOn : ""}`}
              >
                {mm.name}
              </Link>
            ))}
          </nav>
        </div>
      </div>
    </ThemeRoot>
  );
}
