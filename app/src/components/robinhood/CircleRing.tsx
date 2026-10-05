"use client";

/**
 * The circle itself: every seat around the pot, the ring turned so this round's receiving seat sits at the top under
 * the "Receives" marker (Joshua, 2026-10-05). Drawn only from the live read (lib/robinhood/circle-view.ts ringOf).
 * When a read shows the round moved on, the pot travels up to the seat that received it and the ring then turns to
 * the next receiver; reduced motion skips both. Every seat's state is also text, in the seat list beside the ring.
 */
import { useEffect, useRef, useState } from "react";

import type { Ring } from "@/lib/robinhood/circle-view";
import { fmtUsdg } from "@/lib/robinhood/copy";

import r from "./CircleRing.module.css";

const SLOTS = ["teal", "acid", "cobalt", "clay", "sky"] as const;
const BADGE = { paid: "✓", covered: "◐", late: "!", due: "" } as const;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function CircleRing({ ring, pot, round }: { ring: Ring; pot: bigint; round: number }) {
  // Animate only a real change seen in a chain read, never on first paint.
  const [ready, setReady] = useState(false);
  const [flight, setFlight] = useState(0);
  const lastRound = useRef(round);
  useEffect(() => { const id = requestAnimationFrame(() => setReady(true)); return () => cancelAnimationFrame(id); }, []);
  useEffect(() => {
    if (round > lastRound.current) setFlight((f) => f + 1);
    lastRound.current = round;
  }, [round]);

  const n = ring.n;
  const size = n <= 4 ? 27 : n <= 6 ? 23 : 19;
  const radius = 50 - size / 2 - 3;
  return (
    <figure className={`${r.wrap} ${ready ? r.ready : ""}`} aria-label={`The circle: ${ring.caption}`}>
      <div className={r.ring} style={{ "--rot": `${ring.rotation}deg`, "--seat": `${size}%` } as React.CSSProperties}>
        <span className={r.track} aria-hidden />
        {ring.receiving !== null && <span className={r.marker} aria-hidden>Receives</span>}
        <div className={r.spin} aria-hidden>
          {ring.seats.map((seat) => {
            const slot = SLOTS[seat.turn % SLOTS.length];
            const rad = (seat.angle * Math.PI) / 180;
            return (
              <span
                key={seat.turn}
                className={`${r.seat} ${r[seat.role]} ${seat.payment ? r[seat.payment] : ""}`}
                style={{ left: `${50 + radius * Math.sin(rad)}%`, top: `${50 - radius * Math.cos(rad)}%`, background: `var(--${slot})`, color: `var(--${slot}Ink)` }}
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
      <ol className={r.list} aria-label="Seats">
        {ring.seats.map((seat) => (
          <li key={seat.turn} className={`${r.item} ${seat.role === "receiving" ? r.itemNow : ""}`}>
            <b>{seat.label}{seat.you ? " (you)" : ""}</b>
            <span className={r.itemWho}>{short(seat.wallet)}</span>
            <span className={r.itemStatus}>{seat.status.charAt(0).toUpperCase() + seat.status.slice(1)}</span>
          </li>
        ))}
      </ol>
      <p className={r.legend} aria-hidden><span>✓ paid</span><span>◐ covered by locked USDG</span><span>! late</span><span>no mark: due</span></p>
    </figure>
  );
}
