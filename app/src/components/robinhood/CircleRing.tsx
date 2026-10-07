"use client";

/**
 * The circle itself: every seat around the pot, the ring turned so this round's receiving seat sits at the top under
 * the "Receives" marker (Joshua, 2026-10-05). Drawn only from the live read (lib/robinhood/circle-view.ts ringOf).
 * When a read shows the round moved on, the pot travels up to the seat that received it and the ring then turns to
 * the next receiver; reduced motion skips both. Every seat's state is also text, in the seat list beside the ring.
 */
import { useEffect, useRef, useState } from "react";

import { seatFill, seatSize, type Ring } from "@/lib/robinhood/circle-view";
import { fmtUsdg } from "@/lib/robinhood/copy";

import r from "./CircleRing.module.css";


const BADGE = { paid: "✓", covered: "◐", short: "!", late: "!", due: "" } as const;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** An SVG arc on the ring's circle (viewBox 0 0 100 100, centre 50,50), clockwise from angle a to b in degrees. */
function arc(radius: number, a: number, b: number): string {
  const pt = (deg: number) => {
    const t = (deg * Math.PI) / 180;
    return `${(50 + radius * Math.sin(t)).toFixed(3)} ${(50 - radius * Math.cos(t)).toFixed(3)}`;
  };
  return `M ${pt(a)} A ${radius} ${radius} 0 ${b - a > 180 ? 1 : 0} 1 ${pt(b)}`;
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Stage = "logo" | "grow" | "unfold" | "draw" | "spin" | "settled";
const ORDER: Stage[] = ["logo", "grow", "unfold", "draw", "spin", "settled"];
const BEFORE_UNFOLD: Stage[] = ["logo", "grow"];
const BEFORE_DRAW: Stage[] = ["logo", "grow", "unfold"];
const BEFORE_SPIN: Stage[] = ["logo", "grow", "unfold", "draw"];

export default function CircleRing({ ring, pot, round, showList = true, entrance = true, fmt = fmtUsdg, collateral = "USDG" }: {
  ring: Ring; pot: bigint; round: number; showList?: boolean;
  /** What a seat locks, in the legend: USDG (default) on Robinhood, the circle's stock on Solana. */
  collateral?: string;
  /** How the pot is written: USDG (default) on Robinhood, USDC on Solana (the shared circles list). */
  fmt?: (base: bigint) => string;
  /** Play the logo-unfold entrance on mount (false: render the settled ring, e.g. for a static layout check). */
  entrance?: boolean;
}) {
  // On every load the Othello logo unfolds into this circle, then the ring turns one lap and lands with this round's
  // receiver at the top (Joshua, 2026-10-05: "more to the animation before the spin, like some sort of
  // transformation"; chosen: the logo unfolds). Stages: the small logo (three discs, lime centre) -> it grows -> the
  // discs slide out to the seats (seats 4 to 8 split off the logo's discs) -> the arcs draw, the centre becomes the
  // pot, the labels appear -> the spin. Then a real round change seen in a later chain read plays the pot flying to the
  // receiver and the ring turning. Reduced motion: straight to the final state.
  // Reduced motion starts settled on the first frame, not one frame later (adversary on dba0cb9). The ring mounts only
  // in the browser, after the first chain read, so reading the media query here cannot mismatch a server render.
  const [stage, setStageRaw] = useState<Stage>(() => (entrance && !prefersReducedMotion() ? "logo" : "settled"));
  // stages only move forward, whatever order late timers arrive in (adversary pass on 594acfe: a hidden tab's
  // held frame moved "settled" back to the entrance, so later round changes lost the pot-then-turn motion)
  const setStage = (next: Stage) => setStageRaw((now) => (ORDER.indexOf(next) > ORDER.indexOf(now) ? next : now));
  const [flight, setFlight] = useState(0);
  const lastRound = useRef(round);
  useEffect(() => {
    if (!entrance || prefersReducedMotion()) return;
    const at = (ms: number, st: Stage) => window.setTimeout(() => setStage(st), ms);
    // overlapping phases, one easing (Joshua, 2026-10-05: "the beginning is slow and isnt smooth for its phase changes")
    const timers = [at(40, "grow"), at(220, "unfold"), at(620, "draw"), at(820, "spin"), at(2450, "settled")];
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, []);
  useEffect(() => {
    if (round > lastRound.current) setFlight((f) => f + 1);
    lastRound.current = round;
  }, [round]);

  const n = ring.n;
  const size = seatSize(n);
  const radius = 50 - size / 2 - 4;
  // The logo's look (Joshua, 2026-10-05): coloured seats in a white ring with a black gap, joined by arcs in each
  // seat's colour that stop short of the next seat. Thinner lines than the logo's.
  // where an arc stops short of a seat: past its disc, its due ring or the receiving seat's 1.15x disc and halo, plus
  // the arc's own round cap (half its 3.6-unit edge) and a clear gap (adversary pass on 6c5b505: 1px touches at 360px)
  const gapAt = (turn: number) => {
    const half = turn === ring.receiving ? (size * 1.15) / 2 + 3 + 2.6 : size / 2 + 2.2 + 2.6;
    return (Math.asin(Math.min(1, half / radius)) * 180) / Math.PI;
  };
  const step = 360 / n;
  const folded = BEFORE_UNFOLD.includes(stage);
  const stageClass = { logo: r.stLogo, grow: r.stGrow, unfold: r.stUnfold, draw: r.stDraw, spin: r.stSpin, settled: r.ready }[stage];
  return (
    <figure className={`${r.wrap} ${stageClass} ${BEFORE_DRAW.includes(stage) ? r.preDraw : ""}`} aria-label={`The circle: ${ring.caption}`}>
      <div className={r.ring} style={{ "--rot": `${ring.rotation + (BEFORE_SPIN.includes(stage) ? 360 : 0)}deg`, "--seat": `${size}%` } as React.CSSProperties}>
        {ring.receiving !== null && <span className={r.marker} aria-hidden>Receives</span>}
        <div className={r.spin} aria-hidden>
          <svg className={r.arcs} viewBox="0 0 100 100" aria-hidden focusable="false">
            {ring.seats.map((seat) => {
              const d = arc(radius, seat.angle + gapAt(seat.turn), seat.angle + step - gapAt((seat.turn + 1) % n));
              // a black edge under the colour, so an arc in the hero's own accent still reads (adversary on 10bead6)
              return (
                <g key={seat.turn}>
                  <path className={r.drawPath} pathLength={1} d={d} fill="none" stroke="#0B0B0B" strokeWidth={3.6} strokeLinecap="round" />
                  <path className={r.drawPath} pathLength={1} d={d} fill="none" stroke={seatFill(seat.turn).fill} strokeWidth={2} strokeLinecap="round" />
                </g>
              );
            })}
          </svg>
          {ring.seats.map((seat) => {
            const colour = seatFill(seat.turn);
            // folded: on one of the logo's three discs (120 degrees apart, closer in); unfolded: its seat on the ring
            const rad = ((folded ? (seat.turn % 3) * 120 : seat.angle) * Math.PI) / 180;
            const at = folded ? radius * 0.5 : radius;
            return (
              <span
                key={seat.turn}
                className={`${r.seat} ${r[seat.role]} ${seat.payment ? r[seat.payment] : ""} ${folded && seat.turn >= 3 ? r.ghost : ""}`}
                style={{ left: `${50 + at * Math.sin(rad)}%`, top: `${50 - at * Math.cos(rad)}%`, background: colour.fill, color: colour.ink, "--i": seat.turn } as React.CSSProperties}
              >
                <span className={r.upright}>
                  <span className={r.seatWord}>Seat</span>
                  <b className={r.seatNum}>{seat.turn + 1}</b>
                  {seat.you && <span className={r.you}>You</span>}
                </span>
                {seat.payment && seat.payment !== "due" && <span className={r.badge}><span className={r.upright}>{BADGE[seat.payment]}</span></span>}
              </span>
            );
          })}
        </div>
        <span className={r.pot}>
          <span className={r.potLabel}>{ring.receiving !== null ? "Pot this round" : "Pot each round"}</span>
          <b className={r.potAmt}>{fmt(pot)}</b>
        </span>
        {flight > 0 && <span key={flight} className={r.flying} aria-hidden>{fmt(pot)}</span>}
      </div>
      <figcaption className={r.caption}>{ring.caption}</figcaption>
      {showList && (
        <ol className={r.list} aria-label="Seats">
          {ring.seats.map((seat) => (
            <li key={seat.turn} className={`${r.item} ${seat.role === "receiving" ? r.itemNow : ""} ${seat.payment === "paid" || seat.role === "received" ? r.itemDone : ""}`}>
              <span className={r.itemDot} aria-hidden>{seat.payment === "paid" || seat.role === "received" ? "✓" : seat.payment === "late" || seat.payment === "short" ? "!" : ""}</span>
              <span className={r.itemText}>
                <b>{seat.label}{seat.you ? " (you)" : ""} · {short(seat.wallet)}</b>
                <span>{seat.status.charAt(0).toUpperCase() + seat.status.slice(1)}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {showList && <p className={r.legend} aria-hidden><span>✓ paid</span><span>◐ covered by locked {collateral}</span><span>! late or cover short</span><span>no mark: due</span></p>}
    </figure>
  );
}
