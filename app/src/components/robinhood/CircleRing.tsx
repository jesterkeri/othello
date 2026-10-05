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

export default function CircleRing({ ring, pot, round, showList = true }: { ring: Ring; pot: bigint; round: number; showList?: boolean }) {
  // On every load the ring turns one full lap and lands with this round's receiver at the top (Joshua, 2026-10-05:
  // "let it turn on page reload too"): first paint one lap back, then the entrance turn, then the round-change motion
  // (the pot flies to the receiver, then the ring turns) for real changes seen in later chain reads.
  const [stage, setStage] = useState<"start" | "entering" | "settled">("start");
  const [flight, setFlight] = useState(0);
  const lastRound = useRef(round);
  useEffect(() => {
    let id = requestAnimationFrame(() => { id = requestAnimationFrame(() => setStage("entering")); });
    const done = window.setTimeout(() => setStage("settled"), 1900);
    return () => { cancelAnimationFrame(id); window.clearTimeout(done); };
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
  return (
    <figure className={`${r.wrap} ${stage === "entering" ? r.entering : stage === "settled" ? r.ready : ""}`} aria-label={`The circle: ${ring.caption}`}>
      <div className={r.ring} style={{ "--rot": `${ring.rotation + (stage === "start" ? 360 : 0)}deg`, "--seat": `${size}%` } as React.CSSProperties}>
        {ring.receiving !== null && <span className={r.marker} aria-hidden>Receives</span>}
        <div className={r.spin} aria-hidden>
          <svg className={r.arcs} viewBox="0 0 100 100" aria-hidden focusable="false">
            {ring.seats.map((seat) => {
              const d = arc(radius, seat.angle + gapAt(seat.turn), seat.angle + step - gapAt((seat.turn + 1) % n));
              // a black edge under the colour, so an arc in the hero's own accent still reads (adversary on 10bead6)
              return (
                <g key={seat.turn}>
                  <path d={d} fill="none" stroke="#0B0B0B" strokeWidth={3.6} strokeLinecap="round" />
                  <path d={d} fill="none" stroke={seatFill(seat.turn).fill} strokeWidth={2} strokeLinecap="round" />
                </g>
              );
            })}
          </svg>
          {ring.seats.map((seat) => {
            const colour = seatFill(seat.turn);
            const rad = (seat.angle * Math.PI) / 180;
            return (
              <span
                key={seat.turn}
                className={`${r.seat} ${r[seat.role]} ${seat.payment ? r[seat.payment] : ""}`}
                style={{ left: `${50 + radius * Math.sin(rad)}%`, top: `${50 - radius * Math.cos(rad)}%`, background: colour.fill, color: colour.ink }}
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
          <b className={r.potAmt}>{fmtUsdg(pot)}</b>
        </span>
        {flight > 0 && <span key={flight} className={r.flying} aria-hidden>{fmtUsdg(pot)}</span>}
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
      {showList && <p className={r.legend} aria-hidden><span>✓ paid</span><span>◐ covered by locked USDG</span><span>! late or cover short</span><span>no mark: due</span></p>}
    </figure>
  );
}
