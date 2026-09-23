'use client';

// 404. Same shell as Create. Seat 4 of the ring is the empty one.
import Shell from './Shell';
import s from './NotFound.module.css';

const SLOTS = ['acid', 'sky', 'teal', 'clay', 'cobalt', 'acid', 'sky', 'teal'] as const;
const PHRASES = ['Page not found', 'Nothing is wrong with your wallet', 'Go home'];

export type NotFoundProps = { path?: string; walletAddress?: string | null; onConnectWallet?: () => void; onNavigate?: (label: string) => void; homeHref?: string; createHref?: string };

export default function NotFound({ path, walletAddress, onConnectWallet, onNavigate, homeHref = '/', createHref = '/circles/new' }: NotFoundProps) {
  const tape = Array.from({ length: 4 }).flatMap(() => PHRASES);
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
        <div className={`${s.tape} ${s.tapeA}`}><div className={s.track}>{[...tape, ...tape].map((t, i) => <span key={i} className={s[`c${i % 3}`]}>{t}<i>◆</i></span>)}</div></div>
        <div className={`${s.tape} ${s.tapeB}`}><div className={`${s.track} ${s.back}`}>{[...tape, ...tape].map((t, i) => <span key={i}>{t}<i>◆</i></span>)}</div></div>
      </div>
    </Shell>
  );
}
