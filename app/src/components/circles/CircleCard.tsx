/**
 * A running circle on the shared "Your circles" board (Joshua, 2026-10-06, from the Nexus/Metly references). Each
 * tile has its own design and shows as much as its size allows: the hero (largest, across the top) has the circle
 * page's ring and every figure, and its notched corner holds the board's Needs-you pill; beneath it, one tile shows the pot as a big
 * number, the other the members as seat dots. Every tile says the stage, the next step (the headline), the action
 * when it waits on this wallet, and gives a way into the circle. The words come from lib/robinhood/circle-card.ts.
 */
import { useLayoutEffect, useRef, type ReactNode } from "react";

import type { ListCircle } from "@/lib/core/circle-list";
import { dueIn, type CircleCard as Card } from "@/lib/core/circle-card";
import { ringOf, sameAddress, seatFill, seatSize, type RingSeat, type RingWords } from "@/lib/core/ring";
import { fmtMoney } from "@/lib/core/money";

import c from "./CircleCard.module.css";
import CircleRing from "@/components/robinhood/CircleRing";

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** How this circle's amounts and collateral are named (USDG on Robinhood; USDC and the stock on Solana). */
export const wordsOf = (v: ListCircle): RingWords => ({ fmt: (x) => fmtMoney(v.money, x), collateral: v.collateral });
const same = sameAddress;

/** Two decimals: the server and the browser can print the same float differently (a hydration mismatch). */
const f2 = (n: number) => Number(n.toFixed(2));

/** An SVG arc on the ring (viewBox 0 0 100 100), clockwise from angle a to b in degrees. */
function arc(radius: number, a: number, b: number): string {
  const pt = (deg: number) => {
    const t = (deg * Math.PI) / 180;
    return `${(50 + radius * Math.sin(t)).toFixed(2)} ${(50 - radius * Math.cos(t)).toFixed(2)}`;
  };
  const r = f2(radius);
  return `M ${pt(a)} A ${r} ${r} 0 ${b - a > 180 ? 1 : 0} 1 ${pt(b)}`;
}

export function MiniRing({ v, me, className = "" }: { v: ListCircle; me: string; className?: string }) {
  const ring = ringOf(v, me, v.chainTime, wordsOf(v));
  const size = seatSize(v.n) * 1.05;
  const radius = 50 - size / 2 - 3;
  const step = 360 / v.n;
  const gap = (Math.asin(Math.min(1, (size / 2 + 4.5) / radius)) * 180) / Math.PI;
  const joined = v.seats.filter((s) => s.joined).length;
  const centre = v.status === "Active" ? `${v.round + 1}/${v.n}` : v.status === "Forming" ? `${joined}/${v.n}` : v.status === "Completed" ? "✓" : "×";
  return (
    <svg className={`${c.ring} ${className}`} viewBox="0 0 100 100" aria-hidden focusable="false">
      <g transform={`rotate(${ring.rotation} 50 50)`}>
        {ring.seats.map((s) => {
          const d = arc(radius, s.angle + gap, s.angle + step - gap);
          return (
            <g key={`a${s.turn}`}>
              <path d={d} fill="none" stroke="#0B0B0B" strokeWidth={5} strokeLinecap="round" />
              <path d={d} fill="none" style={{ stroke: seatFill(s.turn).fill }} strokeWidth={2.6} strokeLinecap="round" />
            </g>
          );
        })}
        {ring.seats.map((s) => {
          const t = (s.angle * Math.PI) / 180;
          const x = f2(50 + radius * Math.sin(t));
          const y = f2(50 - radius * Math.cos(t));
          const colour = seatFill(s.turn);
          return (
            <g key={s.turn} className={s.role === "open" ? c.open : ""}>
              {s.you && <circle cx={x} cy={y} r={f2(size / 2 + 4)} fill="none" stroke="#0B0B0B" strokeWidth={2.5} />}
              <circle cx={x} cy={y} r={f2(size / 2)} style={{ fill: s.role === "open" ? "#FBF9F2" : colour.fill }} stroke="#0B0B0B" strokeWidth={2.5} />
              <text x={x} y={y} transform={`rotate(${-ring.rotation} ${x} ${y})`} textAnchor="middle" dominantBaseline="central"
                className={c.seatNum} style={{ fill: s.role === "open" ? "#0B0B0B" : colour.ink }}>{s.turn + 1}</text>
            </g>
          );
        })}
      </g>
      <circle cx={50} cy={50} r={f2(radius - size / 2 - 5)} fill="#0B0B0B" />
      <text x={50} y={50} textAnchor="middle" dominantBaseline="central" className={c.centre}>{centre}</text>
    </svg>
  );
}

export const Arrow = () => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden focusable="false">
    <path d="M7 17 17 7M9 7h8v8" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** "Round 2 of 5" while running, "Forming · 2/4 joined" before it starts. */
export const stage = (v: ListCircle) =>
  v.status === "Forming" ? `Forming · ${v.seats.filter((s) => s.joined).length}/${v.n} joined` : `Round ${v.round + 1} of ${v.n}`;

/**
 * The pill joined to a round bubble (the "Get early access" button in Joshua's reference): the words in the pill, a
 * count or an arrow in the bubble. Drawn as one SVG so the neck between them keeps its shape; the caller wraps it in a
 * link or a button.
 */
export function PillShape({ text, bubble, hot }: { text: string; bubble: ReactNode; hot: boolean }) {
  return (
    <svg viewBox="-2 -2 256 64" className={`${c.pillSvg} ${hot ? c.pillHot : ""}`} aria-hidden focusable="false">
      <path className={c.pillBody}
        d="M30 0 L158 0 C171 0 176 13 185 13 C191 13 194 9.5 207 4 A30 30 0 1 1 207 56 C194 50.5 191 47 185 47 C176 47 171 60 158 60 L30 60 A30 30 0 0 1 30 0 Z" />
      <circle className={c.pillBubble} cx={222} cy={30} r={28.5} />
      <text x={92} y={31} textAnchor="middle" dominantBaseline="central" className={c.pillText}>{text}</text>
      {typeof bubble === "string" || typeof bubble === "number"
        ? <text x={222} y={32} textAnchor="middle" dominantBaseline="central" className={c.pillCount}>{bubble}</text>
        : <g transform="translate(209 17)" className={c.pillArrow}>{bubble}</g>}
    </svg>
  );
}

/** Each seat as a segment, filled in its ring colour once it has paid this round (joined, while forming). */
function SeatDots({ v, me }: { v: ListCircle; me: string }) {
  // six dots fit; past six, the wallet's own seat keeps its dot (adversary suspicion on dd59b76: seats 7 and 8 were
  // folded into "+N" and never marked as the wallet's)
  const mine = v.seats.find((s) => same(s.wallet, me));
  const shown = v.seats.length <= 6 || !mine || mine.turn < 5 ? v.seats.slice(0, 6) : [...v.seats.slice(0, 5), mine];
  return (
    <span className={c.dots} aria-hidden>
      {shown.map((s) => {
        const colour = seatFill(s.turn);
        return (
          <span key={s.turn} className={`${c.dot} ${same(s.wallet, me) ? c.dotYou : ""} ${s.joined ? "" : c.dotOpen}`}
            style={s.joined ? { background: colour.fill, color: colour.ink } : undefined}>{s.turn + 1}</span>
        );
      })}
      {v.n > shown.length && <span className={`${c.dot} ${c.dotMore}`}>+{v.n - shown.length}</span>}
    </span>
  );
}

const Clock = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden focusable="false">
    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth={2.4} />
    <path d="M12 7v5l3 2" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" />
  </svg>
);

/** The hero's pot as one huge number. */
function HeroPot({ v }: { v: ListCircle }) {
  return (
    <div className={c.potBlock}>
      <span className={c.potLabel}>{v.status === "Forming" ? "Pot each round" : "Pot this round"}</span>
      <span className={c.potHuge}>{fmtMoney(v.money, BigInt(v.n) * v.c)}</span>
    </div>
  );
}

/** The hero's other figures as tilted stickers (the landing page's pills). */
function HeroStickers({ v }: { v: ListCircle }) {
  const forming = v.status === "Forming";
  const joined = v.seats.filter((s) => s.joined).length;
  const paid = v.seats.filter((s) => s.paid).length;
  const due = dueIn(v);
  return (
    <div className={c.stickers}>
      <span className={`${c.stk} ${c.stkPaper}`}>{forming ? `${joined} of ${v.n} joined` : `✓ ${paid} of ${v.n} paid`}</span>
      <span className={`${c.stk} ${c.stkInk}`}><Clock /> {due ? (due === "Late" || due === "Grace period" ? due : `${due} left`) : "Starts when all join"}</span>
      <span className={`${c.stk} ${c.stkCobalt}`}>Reserve {fmtMoney(v.money, v.reserveTotal - v.reserveLosses)}</span>
    </div>
  );
}

/** "Seat 2 (you), Seat 7": the seats still to pay this round, in words. */
function owingWords(seats: RingSeat[]): string {
  const owe = seats.filter((x) => x.payment === "due" || x.payment === "late");
  return owe.map((x) => `Seat ${x.turn + 1}${x.you ? " (you)" : ""}`).join(", ");
}

/**
 * The hero's seats (Joshua 2026-10-06: tiles stopped holding together past four; of four designs he picked these
 * dots): every seat as an overlapping dot in its ring colour, ✓ once it has paid this round, the receiver enlarged
 * and outlined; then who receives and who still owes, in words. Holds 3 to 8 seats alike.
 */
function HeroSeats({ v, me }: { v: ListCircle; me: string }) {
  const seats = ringOf(v, me, v.chainTime, wordsOf(v)).seats;
  const active = v.status === "Active";
  const now = seats.find((x) => x.role === "receiving");
  // paid is the chain's paid bit, as the sticker, the pot bar and the phone card count it; a seat settled in default
  // is covered from the escrow only inside the release, so it is named apart (adversary on 67d3214)
  const paid = seats.filter((x) => x.payment === "paid").length;
  const settled = seats.filter((x) => x.payment === "covered" || x.payment === "short").length;
  const owe = owingWords(seats);
  return (
    <div className={c.dotsBig}>
      <ol className={c.dotsRow} aria-label="Seats">
        {seats.map((x) => {
          const colour = seatFill(x.turn);
          return (
            <li key={x.turn} className={`${c.bigDot} ${x.role === "receiving" ? c.bigDotNow : ""}`} style={{ background: colour.fill, color: colour.ink }}
              aria-label={`${x.label}${x.you ? " (you)" : ""}: ${x.status}`}>
              <span aria-hidden>{x.turn + 1}</span>
              {active && x.payment === "paid" && <span className={c.bigDotPaid} aria-hidden>✓</span>}
              {x.you && <span className={c.bigDotYou} aria-hidden>You</span>}
            </li>
          );
        })}
      </ol>
      {now && <p className={c.dotsNow}>Seat {now.turn + 1}{now.you ? " (you)" : ""} gets the pot this round.</p>}
      {active && (
        <p className={c.seatSummary}>
          <b>{paid} of {seats.length} paid this round{settled ? ` · ${settled} settled in default` : ""}</b>
          {owe && <span>Still to pay: {owe}</span>}
        </p>
      )}
    </div>
  );
}

/**
 * Lays its content out at a design size and scales it down as a whole to fit the tile (Joshua 2026-10-06: contents
 * shrink with their card and keep their proportions, instead of reflowing until they collide). The content is laid
 * out at least `designWidth` wide (so a narrower tile shows the same layout, smaller), and the scale then drops
 * further until it is no taller than the tile; never above 1, never below 0.4. The inner box carries --s, so a fixed
 * real-pixel gap (the notch) can be divided by it. `as="span"` for use inside a button.
 */
export function Fit({ children, className = "", designWidth = 0, as: Tag = "div" }: {
  children: ReactNode; className?: string; designWidth?: number; as?: "div" | "span";
}) {
  const outer = useRef<HTMLElement>(null);
  const inner = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const o = outer.current, i = inner.current;
    if (!o || !i) return;
    const fit = () => {
      const w = o.clientWidth, h = o.clientHeight;
      if (!w || !h) return;
      const most = designWidth ? Math.min(1, w / designWidth) : 1;
      let scale = most;
      for (let step = 0; step < 6; step++) {
        i.style.width = `${w / scale}px`;
        i.style.minHeight = `${h / scale}px`;
        i.style.setProperty("--s", String(scale));
        const next = Math.max(0.4, Math.min(most, h / i.offsetHeight));
        if (Math.abs(next - scale) < 0.004) { scale = next; break; }
        scale = next;
      }
      i.style.width = `${w / scale}px`;
      i.style.minHeight = `${h / scale}px`;
      i.style.setProperty("--s", String(scale));
      i.style.transform = scale < 1 ? `scale(${scale})` : "";
    };
    fit();
    const watch = new ResizeObserver(fit);
    watch.observe(o);
    return () => watch.disconnect();
  }, [designWidth]);
  return (
    <Tag ref={outer as React.RefObject<never>} className={c.fit}>
      <Tag ref={inner as React.RefObject<never>} className={`${c.fitInner} ${className}`}>{children}</Tag>
    </Tag>
  );
}

export type Design = "hero" | "pot" | "members";
const DESIGN_CLASS: Record<Design, string> = { hero: "dHero", pot: "dPot", members: "dMembers" };

/** Who has paid this round (joined, while forming), as a bar that grows in: the asset page's liquidity bar. */
function PaidBar({ v }: { v: ListCircle }) {
  const forming = v.status === "Forming";
  const done = v.seats.filter((s) => (forming ? s.joined : s.paid)).length;
  return (
    <div className={c.paidBar}>
      <span className={c.paidLine}><span>{forming ? "Joined" : "Paid this round"}</span><b>{done} of {v.n}</b></span>
      <span className={c.bar} aria-hidden><span style={{ width: `${Math.max(done === 0 ? 0 : 12, (done / v.n) * 100)}%` }} /></span>
    </div>
  );
}

/**
 * The asset page's card trim: a glint that sweeps across on hover, and a faint drawing in a corner, a different one on
 * each tile (Joshua 2026-10-06: not the same lines on every card): rings, a tilted pill and disc, a dot grid, stripes.
 */
export type Deco = "rings" | "pill" | "dots" | "stripes";
export const Trim = ({ deco }: { deco: Deco }) => (
  <>
    <span className={c.glint} aria-hidden />
    {deco === "rings" && <span className={c.decoRings} aria-hidden><span /></span>}
    {deco === "pill" && <><span className={c.decoPill} aria-hidden /><span className={c.decoDisc} aria-hidden /></>}
    {deco === "dots" && <span className={c.decoDots} aria-hidden />}
    {deco === "stripes" && <span className={c.decoStripes} aria-hidden />}
  </>
);
const DECO: Record<"hero" | "pot" | "members", Deco> = { hero: "rings", pot: "pill", members: "dots" };

export default function CircleCard({ v, me, card, design, area, tone, corner = null, index = 0 }: {
  v: ListCircle; me: string; card: Card; design: Design;
  /** The hero's notched corner holds the board's Needs-you pill (Joshua 2026-10-06), in place of the arrow. */
  corner?: ReactNode;
  /** Position on the board, for the staggered rise-in. */
  index?: number;
  /** The board's grid area for this tile ("a" to "c"). */
  area: string;
  /** The tile's colour class, chosen by the board. */
  tone: string;
}) {
  const href = v.href;
  const needs = card.group === "needs";
  const pot = fmtMoney(v.money, BigInt(v.n) * v.c);
  const hero = design === "hero";
  const actionLabel = card.action === "Pay" ? `Pay ${fmtMoney(v.money, v.c)}` : card.action === "Claim" ? `Claim ${pot}` : card.action;
  // the smaller tiles' address and action, at the bottom
  const foot = (
    <div className={c.foot}>
      <a className={c.addr} href={href}>Circle {short(v.address)}</a>
      {needs && (
        <a className={c.action} href={href} aria-label={`${card.action}: circle ${short(v.address)}`}>
          {card.action} <span aria-hidden>→</span>
        </a>
      )}
    </div>
  );
  return (
    <article className={`${c.tile} ${c[DESIGN_CLASS[design]]} ${hero ? c.notchedWide : c.plain} ${tone} ${needs ? c.needs : ""}`}
      style={{ gridArea: area, animationDelay: `${index * 0.07}s` }} aria-label={`Circle ${short(v.address)}`}>
      <div className={c.shape}>
        <div className={c.fill}>
          <Trim deco={DECO[design]} />
          <Fit className={hero ? c.heroArt : ""} designWidth={hero ? 1180 : 0}>
            <div className={c.cardTop}>
              <span className={c.stage}>{stage(v)}</span>
              {needs && <span className={c.sticker}>Your move</span>}
            </div>
            {hero && (
              // the words side as its own bento: the step, the pot and the figures on the left; the seats, the action and
              // the circle's link on the right (Joshua 2026-10-06: "the problem here is arrangement")
              <div className={`${c.cardBody} ${c.heroGrid}`}>
                <div className={c.hHead}>
                  <b className={c.headline}>{card.headline}</b>
                  <span className={c.detail}>{card.yourTurn}</span>
                </div>
                <div className={c.hPot}><HeroPot v={v} /></div>
                <div className={c.hStk}><HeroStickers v={v} /></div>
                <div className={c.hSeats}><HeroSeats v={v} me={me} /></div>
                <div className={c.hLink}><a className={c.addr} href={href}>Circle {short(v.address)}</a></div>
              </div>
            )}
            {design === "pot" && (
              <div className={c.cardBody}>
                <b className={c.headline}>{card.headline}</b>
                <span className={c.potLabel}>Pot · {v.n} members · {fmtMoney(v.money, v.c)} a round</span>
                <span className={c.potBig}>{pot}</span>
                <PaidBar v={v} />
              </div>
            )}
            {design === "members" && (
              <div className={c.cardBody}>
                <span className={c.membersHead}>
                  <span className={c.bigNum}>{v.n}</span>
                  <span className={c.potLabel}>members · {pot} pot</span>
                </span>
                <SeatDots v={v} me={me} />
                <b className={c.headline}>{card.headline}</b>
                <span className={c.detail}>{card.yourTurn}</span>
              </div>
            )}
            {!hero && foot}
            {/* the hero's action sits in its bottom-right corner, so the seats and figures keep their places (Joshua 2026-10-06) */}
            {hero && needs && (
              <a className={c.heroAction} href={href} aria-label={`${actionLabel}: circle ${short(v.address)}`}>
                {actionLabel} <span aria-hidden>→</span>
              </a>
            )}
            {hero && (
              <div className={c.ringHero}>
                <CircleRing ring={ringOf(v, me, v.chainTime, wordsOf(v))} pot={BigInt(v.n) * v.c} round={v.round} showList={false} fmt={wordsOf(v).fmt} />
              </div>
            )}
          </Fit>
        </div>
      </div>
      {/* only the hero is notched (it holds the Needs-you pill); the others are plain tiles (Joshua 2026-10-06:
          an arrow in a circle means nothing, so that corner is kept for the finished stack) */}
      {hero && <div className={c.notchPill}>{corner}</div>}
    </article>
  );
}
