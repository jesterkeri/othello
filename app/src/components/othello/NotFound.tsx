'use client';

// 404. Same shell as Create. Seat 4 of the ring is the empty one.
import { useEffect, useRef, useState } from 'react';

import Shell from './Shell';
import s from './NotFound.module.css';

const SLOTS = ['acid', 'sky', 'teal', 'clay', 'cobalt', 'acid', 'sky', 'teal'] as const;
const PHRASES = ['Page not found', 'Nothing is wrong with your wallet', 'Go home'];
/** Rounds of the phrases in one strip as prerendered: about 5,900px at 18px, enough for a window up to ~4,000px. */
const MIN_ROUNDS = 8;
/** The tape starts 45% of the window left of it, so a strip rolled to its end still reaches the right edge only if it
 *  is at least 1.45 windows long. */
const REACH = 1.45;

export type NotFoundProps = { path?: string; walletAddress?: string | null; onConnectWallet?: () => void; onNavigate?: (label: string) => void; homeHref?: string; createHref?: string };

export default function NotFound({ path, walletAddress, onConnectWallet, onNavigate, homeHref = '/', createHref = '/circles/new' }: NotFoundProps) {
  // A track is two strips rolled by one strip's length. A wider window (a large display, or zoomed out) needs a longer
  // strip, so the strip grows to at least REACH windows plus one spare round (the tapes are tilted 2 degrees, and a
  // strip of exactly REACH windows can leave a sliver); the roll time grows with it (--rounds in the CSS), so the text
  // moves at the same speed whatever the length. It is measured again whenever the window or the strip itself changes
  // size: the strip changes when Archivo swaps in for its wider fallback after the page has hydrated.
  //
  // One round's width is read across the first MIN_ROUNDS rounds, which exist at any count, never from the whole strip:
  // a measurement that depends on the count it sets feeds back, and any rounding in it (scrollWidth's whole pixels,
  // the 6 significant digits of a computed width past 100,000px) flipped the count between N and N+1 forever at some
  // widths (adversary on 6724b33 and 9f6b59c).
  const [rounds, setRounds] = useState(MIN_ROUNDS);
  const track = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const fit = () => {
      const first = el.children[0], after = el.children[MIN_ROUNDS * PHRASES.length];
      if (!(first instanceof HTMLElement) || !(after instanceof HTMLElement)) return;
      const perRound = (after.offsetLeft - first.offsetLeft) / MIN_ROUNDS;
      if (!(perRound > 0)) return; // not laid out (also NaN)
      setRounds(Math.max(MIN_ROUNDS, Math.ceil((REACH * window.innerWidth) / perRound) + 1));
    };
    fit();
    window.addEventListener('resize', fit);
    const sized = new ResizeObserver(fit);
    sized.observe(el);
    return () => { window.removeEventListener('resize', fit); sized.disconnect(); };
  }, []);
  const tape = Array.from({ length: rounds }).flatMap(() => PHRASES);
  return (
    <Shell active={null} walletAddress={walletAddress} onConnectWallet={onConnectWallet} onNavigate={onNavigate}>
      <div className={s.hero}>
        <div className={s.mark} aria-hidden>
          <span className={s.digit}>4</span>
          <span className={s.ring}>
            <span className={s.orbitLine} />
            <span className={s.orbit}>
              {SLOTS.map((slot, i) => {
                const a = ((-90 + i * 45) * Math.PI) / 180, missing = i === 3;
                return (
                  <span key={i} className={`${s.seat} ${missing ? s.seatEmpty : ''}`}
                    style={{ left: `${50 + 44 * Math.cos(a)}%`, top: `${50 + 44 * Math.sin(a)}%`, ...(missing ? {} : { background: `var(--${slot})`, color: `var(--${slot}Ink)` }) }}>
                    <span>{missing ? '' : i + 1}</span>
                  </span>
                );
              })}
            </span>
            <span className={s.core}>?</span>
          </span>
          <span className={s.digit}>4</span>
          <svg viewBox="0 0 80 40" className={s.squiggle} fill="none" stroke="var(--clay)" strokeWidth={5} strokeLinecap="round"><path d="M5 28c8-16 14 12 22-4s14 14 22-2 10 8 14 2" /></svg>
        </div>

        <div className={s.copy}>
          <span className={s.badge}><span />Error 404</span>
          <h1 className={s.title}>This seat isn&apos;t in the circle</h1>
          <p className={s.lede}>The link may be old or mistyped. Nothing is wrong with your wallet.</p>
          <div className={s.actions}>
            <a className={s.primary} href={homeHref}>Go home
              <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={3.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6.5 17.5 17.5 6.5M9 6.5h8.5V15" /></svg>
            </a>
            <a className={s.ghost} href={createHref}>Create a circle</a>
          </div>
          {path && <span className={s.path}>Looked for: {path}</span>}
        </div>
      </div>

      <div className={s.tapes} aria-hidden>
        <div className={`${s.tape} ${s.tapeA}`}><div ref={track} className={s.track} style={{ '--rounds': rounds } as React.CSSProperties}>{[...tape, ...tape].map((t, i) => <span key={i} className={s[`c${i % 3}`]}>{t}<i>◆</i></span>)}</div></div>
        <div className={`${s.tape} ${s.tapeB}`}><div className={`${s.track} ${s.back}`} style={{ '--rounds': rounds } as React.CSSProperties}>{[...tape, ...tape].map((t, i) => <span key={i}>{t}<i>◆</i></span>)}</div></div>
      </div>
    </Shell>
  );
}
