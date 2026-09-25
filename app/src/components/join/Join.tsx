"use client";

import Link from "next/link";

import { ThemeRoot } from "@/components/theme/ThemeRoot";
import shell from "@/components/circle/Circle.module.css";
import s from "@/components/ui/Screen.module.css";
import {
  derive,
  formatRaw,
  formatUsdc,
  memberBySeat,
  rawForCover,
  seatSet,
  shortAddress,
  type CircleView,
} from "@/lib/circle";
import type { CircleStateKey } from "@/fixtures/circles";

/**
 * The Join place.
 *
 * design/UX-REVIEW.md's only STOP was raised here: "Join takes a reserve
 * deposit it never mentions", and the reader's words were "it worries me that
 * I'm asked to fund it" and "I'd want to know how much stock gets locked before
 * I press it". So both amounts and the worst case are stated as three plain
 * blocks ABOVE the button, not as a helper line under it.
 *
 * Every string is design/FLOWS.md §8 verbatim: the heading, "Join and lock",
 * "View circle", and the helper sentence that names turn, contribution, both
 * amounts, that both come back, and the maximum loss with its condition.
 */


export default function Join({
  circle,
  seat,
  now,
  stateKey,
  usdcWord,
  suggestedLockRaw,
}: {
  circle: CircleView;
  seat: number;
  now: number;
  /** Where its links point: a fixture state, or "demo" for the live devnet circle (T18). */
  stateKey: CircleStateKey | "demo";
  /** The money word. The live demo's money is test USDC and must never read as real USDC. */
  usdcWord?: string;
  /** What this circle tells a joiner to lock. Above the minimum on purpose. */
  suggestedLockRaw: number;
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
              View circle
            </Link>
          </div>
        </div>
      </ThemeRoot>
    );
  }

  const alreadyJoined = seatSet(c.joinedBitmap, m.turn);
  const open = c.status === "Forming";

  // The chain stores no circle name, so this is derived from circle_id rather
  // than invented. FLOWS' "{circle}" is whatever the UI can honestly call it.
  const circleName = `Circle #${c.circleId}`;

  // The floor, and what the circle actually asks for. They are not the same:
  // locking exactly minRaw clears min_stock_cover with nothing to spare.
  const minRaw = rawForCover(c, c.minStockCover);
  const lockRaw = m.lockedRaw > 0 ? m.lockedRaw : suggestedLockRaw;

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
            <span className={`${shell.statusPill} ${shell.statusForming} ${shell.micro}`}>
              Turn {seat} of {c.n}
            </span>
            <span className={`${shell.stockPill} ${shell.micro}`}>{shortAddress(m.address)}</span>
          </div>

          <h1 className={`${shell.display} ${s.headline}`}>
            You&apos;re invited to {circleName}
          </h1>

          {!open ? (
            // Terminal, per FLOWS §8: a closed circle is a page-level refusal,
            // not an inline one, because nothing on this screen can now be done.
            <>
              <div className={s.refusal}>
                <span className={s.refusalTitle}>This circle already started</span>
                <p className={s.refusalText}>
                  Joining is only possible while a circle is Forming. Nothing was taken from
                  this wallet.
                </p>
              </div>
              <div className={s.actions}>
                <Link href={`/circle/${stateKey}`} className={s.secondary}>
                  View circle
                </Link>
              </div>
            </>
          ) : alreadyJoined ? (
            <>
              <div className={s.refusal}>
                <span className={s.refusalTitle}>
                  You&apos;re in. Your stock is locked until the circle ends.
                </span>
                <p className={s.refusalText}>
                  Seat {seat} has locked {formatRaw(m.lockedRaw)} {c.stockSymbol} and deposited{" "}
                  {formatUsdc(c.guaranteePerMember)} {USDC}. The circle starts when all {c.n}{" "}
                  seats have joined; {d.joined} of {c.n} have.
                </p>
              </div>
              <div className={s.actions}>
                <Link href={`/circle/${stateKey}/position/${seat}`} className={s.secondary}>
                  See the position
                </Link>
                <Link href={`/circle/${stateKey}`} className={s.secondary}>
                  View circle
                </Link>
              </div>
            </>
          ) : (
            <>
              <p className={s.lede}>
                Turn {seat} of {c.n}. {formatUsdc(c.contribution)} {USDC} per round.
              </p>

              {/* The STOP fix: both amounts and the worst case, before the button. */}
              <div className={s.terms}>
                <div className={`${s.term} ${s.termIn}`}>
                  <span className={s.amountLabel}>What you put in</span>
                  <span className={`${shell.display} ${s.termBig}`}>
                    {formatRaw(lockRaw)} {c.stockSymbol}
                  </span>
                  <span className={`${shell.display} ${s.termBig}`}>
                    {formatUsdc(c.guaranteePerMember)} {USDC}
                  </span>
                  <p className={s.termNote}>
                    You lock {formatRaw(lockRaw)} {c.stockSymbol} and put{" "}
                    {formatUsdc(c.guaranteePerMember)} {USDC} into the circle&apos;s shared
                    reserve.
                  </p>
                </div>

                <div className={`${s.term} ${s.termBack}`}>
                  <span className={s.amountLabel}>What comes back</span>
                  <span className={`${shell.display} ${s.termBig}`}>Both</span>
                  <p className={s.termNote}>
                    Both come back when the circle ends. Your stock is yours the whole time;
                    locking it is the promise, not a sale.
                  </p>
                </div>

                <div className={`${s.term} ${s.termRisk}`}>
                  <span className={s.amountLabel}>Most you could lose</span>
                  <span className={`${shell.display} ${s.termBig}`}>
                    {formatUsdc(c.guaranteePerMember)} {USDC}
                  </span>
                  <p className={s.termNote}>
                    Your reserve deposit, only if other members default and their stock
                    doesn&apos;t cover it.
                  </p>
                </div>
              </div>

              <div className={s.refusal}>
                <span className={s.refusalTitle}>
                  You need stock worth {formatUsdc(c.minStockCover)} {USDC} of cover to join
                </span>
                <p className={s.refusalText}>
                  At {formatUsdc(c.feed.wrapperPrice)} {USDC} a token and a{" "}
                  {c.haircutBps / 100}% safety margin, that is {formatRaw(minRaw)}{" "}
                  {c.stockSymbol}. Locking {formatRaw(lockRaw)} leaves room for the price to
                  move before anyone has to add more.
                </p>
              </div>

              <div className={s.actions}>
                <button className={s.primary} disabled>
                  Join and lock
                </button>
                <Link href={`/circle/${stateKey}`} className={s.secondary}>
                  View circle
                </Link>
                <p className={s.why}>
                  Joining moves two things in one transaction, so it needs a connected wallet.
                  This page is the viewer, which reads accounts and signs nothing.
                </p>
              </div>
            </>
          )}

          <nav className={s.seats} aria-label="Seats">
            {c.members.map((mm) => (
              <Link
                key={mm.address}
                href={`/circle/${stateKey}/join/${mm.turn + 1}`}
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
