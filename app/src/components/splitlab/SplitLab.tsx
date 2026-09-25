'use client';

// Split lab. Colour cards on the Shell's gutter surface; one grid that stacks on phone.
// Colour roles are fixed to slots so every palette keeps its meaning:
//   time = sky, the display vault = --tile then clay (warning), Othello = teal (support), verdict = cobalt (deep), neutral = --tile.
// Motion: framer-motion. MotionConfig reducedMotion="user" turns transforms off for reduced-motion users.
//
// From the design session's handoff-split-lab/SplitLab.tsx (board: Split Lab Board.dc.html). Changes
// to fit the site, and nothing else: the app's Shell (real nav links, the wallet control), the live
// circle at /circle/demo, and the source line links to the real NFLXx mint's page.
import Link from 'next/link';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { AnimatePresence, MotionConfig, animate, motion, useAnimationControls, useMotionValue, useSpring, useTransform, type AnimationPlaybackControls } from 'framer-motion';

import Shell from '@/components/othello/Shell';

import s from './SplitLab.module.css';

export type Phase = 'before' | 'scheduled' | 'split' | 'after';

export type SplitData = {
  symbol: string; tokens: string; multBefore: string; multAfter: string; priceBefore: string; priceAfter: string;
  valueTrue: string; valueNaiveAfter: string; haircut: string;
  splitAtUnix: number; source: 'recorded' | 'live';
};

/**
 * The real NFLXx 10-for-1 (tests/fixtures/NFLXx.json, fetched from mainnet at slot 449,145,146:
 * multiplier 1, new multiplier 10 at 1763337300). Prices and the 1.10 tokens are SPEC.md:137's demo
 * figures, the same the devnet demo circle is seeded with, so H = 132 here and there.
 */
export const NFLX_RECORDED: SplitData = {
  symbol: 'NFLXx', tokens: '1.10', multBefore: '1', multAfter: '10', priceBefore: '150.00', priceAfter: '15.00',
  valueTrue: '165.00', valueNaiveAfter: '16.50', haircut: '132.00', splitAtUnix: 1763337300, source: 'recorded',
};

const SOURCE = {
  recorded: 'Real NFLXx mint data, recorded from Solana mainnet (slot 449,145,146). Prices are illustrative.',
  live: 'Reading Solana devnet.',
};

const WINDOW = 600;
const pad = (n: number) => String(n).padStart(2, '0');
const phaseOf = (p: number): Phase => (p <= 0.03 ? 'before' : p < 0.97 ? 'scheduled' : p <= 1.03 ? 'split' : 'after');
const snap = (p: number) => (p <= 0.05 ? 0 : Math.abs(p - 1) < 0.06 ? 1 : p > 1 ? 2 : p);
const START: Record<Phase, number> = { before: 0, scheduled: 0.55, split: 1, after: 2 };
const SPRING = { type: 'spring', stiffness: 420, damping: 26 } as const;
const POP = { type: 'spring', stiffness: 520, damping: 18 } as const;
const rise = { hidden: { opacity: 0, y: 18 }, show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 260, damping: 24 } } } as const;

/** Pointer tilt from OTHELLO-STYLE motion: follows in 100ms, springs back in 420ms. Mouse only. */
const tilt = {
  onPointerMove: (e: PointerEvent<HTMLElement>) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.currentTarget, r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    el.style.transition = 'transform .1s ease-out';
    el.style.transform = `perspective(900px) rotateX(${-y * 7}deg) rotateY(${x * 9}deg) translateY(-3px) scale(1.012)`;
    el.style.zIndex = '4';
  },
  onPointerLeave: (e: PointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    el.style.transition = 'transform .42s cubic-bezier(.2,1.5,.35,1)';
    el.style.transform = ''; el.style.zIndex = '';
  },
};

function Count({ value }: { value: number }) {
  const mv = useMotionValue(value);
  const spring = useSpring(mv, { stiffness: 90, damping: 18 });
  const text = useTransform(spring, (v) => v.toFixed(2));
  useEffect(() => { mv.set(value); }, [mv, value]);
  return <motion.span className={s.big}>{text}</motion.span>;
}

function Flip({ children }: { children: string }) {
  return (
    <span className={s.flip}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.b key={children} initial={{ y: -18, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 18, opacity: 0 }} transition={POP}>{children}</motion.b>
      </AnimatePresence>
    </span>
  );
}

/** One token block cuts into 11 tenth-shares at the split. The display vault keeps 1.10; the rest go to dashed ghosts. */
function Shares({ post, naive, tokenInk }: { post: boolean; naive: boolean; tokenInk: string }) {
  return (
    <div className={s.sharesTrack}>
      <motion.div className={s.cells} animate={{ gap: post ? 5 : 0 }} transition={SPRING}>
        {Array.from({ length: 11 }, (_, i) => {
          const ghost = naive && post && i > 1;
          return (
            <motion.span key={i} className={`${s.cell} ${ghost ? s.cellGhost : ''}`} initial={false}
              animate={post ? { opacity: ghost ? 0.55 : 1, y: 0, scale: ghost ? 0.88 : 1 } : { opacity: 0, y: -10, scale: 0.6 }}
              transition={{ type: 'spring', stiffness: 500, damping: 14, delay: post ? i * 0.045 : 0 }}>
              <motion.span className={s.cellFill} animate={{ width: ghost ? '0%' : naive && post && i === 1 ? '10%' : '100%' }} transition={{ duration: 0.4, delay: post ? i * 0.045 : 0 }} />
            </motion.span>
          );
        })}
      </motion.div>
      <motion.div className={s.token} animate={{ opacity: post ? 0 : 1, scale: post ? 1.06 : 1 }} transition={SPRING} aria-hidden>
        <span><i style={{ color: tokenInk }}>1 token</i></span><span />
      </motion.div>
    </div>
  );
}

export type SplitLabProps = {
  /** null renders the empty state (live devnet, nothing scheduled). */
  data?: SplitData | null;
  /** Plays before, countdown, split second, after once on load. */
  autoplay?: boolean;
  initialPhase?: Phase;
  onBack?: () => void;
  liveCircleHref?: string;
};

export default function SplitLab({ data = NFLX_RECORDED, autoplay = true, initialPhase = 'after', onBack, liveCircleHref = '/circle/demo' }: SplitLabProps) {
  const [p, setP] = useState(autoplay ? 0 : START[initialPhase]);
  const [drag, setDrag] = useState(false);
  const [playing, setPlaying] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  const run = useRef<AnimationPlaybackControls | null>(null);
  const timers = useRef<number[]>([]);
  const shake = useAnimationControls();
  const back = onBack ?? (() => history.back());

  function stop() { run.current?.stop(); timers.current.forEach(clearTimeout); timers.current = []; setPlaying(false); }
  function play() {
    stop(); setPlaying(true); setP(0);
    const later = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));
    later(500, () => { run.current = animate(0, 1, { duration: 4.2, ease: 'linear', onUpdate: setP }); });
    later(5600, () => { run.current = animate(1, 2, { duration: 0.5, ease: [0.2, 0.9, 0.2, 1], onUpdate: setP, onComplete: () => setPlaying(false) }); });
  }
  useEffect(() => {
    const id = autoplay && data ? window.setTimeout(play, 1100) : 0;
    return () => { clearTimeout(id); stop(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const at = (e: PointerEvent) => { const r = track.current!.getBoundingClientRect(); return Math.max(0, Math.min(2, ((e.clientX - r.left) / r.width) * 2)); };
  const onKey = (e: KeyboardEvent) => {
    const k = e.key; stop();
    if (k === 'ArrowRight' || k === 'ArrowUp') { e.preventDefault(); setP(p < 1 ? Math.min(1, +(p + 0.1).toFixed(2)) : 2); }
    else if (k === 'ArrowLeft' || k === 'ArrowDown') { e.preventDefault(); setP(p > 1 ? 1 : Math.max(0, +(p - 0.1).toFixed(2))); }
    else if (k === 'Home') setP(0); else if (k === 'End') setP(2);
  };

  const ph = phaseOf(p), post = ph === 'split' || ph === 'after', flash = ph === 'split';
  const remain = Math.round((1 - Math.min(p, 1)) * WINDOW);

  const wasPost = useRef(post);
  useEffect(() => {
    if (post && !wasPost.current) void shake.start({ x: [0, -9, 8, -6, 4, 0], rotate: [0, -1.2, 1, -0.6, 0], transition: { duration: 0.5 } });
    wasPost.current = post;
  }, [post, shake]);

  const d = data ?? NFLX_RECORDED;
  const t = new Date((d.splitAtUnix - remain) * 1000);
  const hms = `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`;
  const bigClock = { before: 'Before', scheduled: hms, split: '23:55:00', after: 'After' }[ph];
  const subClock = { before: 'the split, 16 Nov 2025, 23:55 UTC', scheduled: 'UTC, 16 Nov 2025', split: 'UTC, 16 Nov 2025. The split second', after: 'the split, 16 Nov 2025, 23:55 UTC' }[ph];
  const chip = ({ before: [`Multiplier ${d.multBefore}`, s.chipBefore], scheduled: [`Split in ${pad(Math.floor(remain / 60))}:${pad(remain % 60)}`, s.chipScheduled], split: ['Split now', s.chipSplit], after: [`Multiplier ${d.multAfter}`, s.chipAfter] } as Record<Phase, [string, string]>)[ph];
  const mult = post ? d.multAfter : d.multBefore, price = post ? d.priceAfter : d.priceBefore;
  const naive = Number(post ? d.valueNaiveAfter : d.valueTrue), full = Number(d.valueTrue);
  const pct = `${(p / 2) * 100}%`;
  const steps = [{ label: 'Before', v: 0, on: ph === 'before' || ph === 'scheduled' }, { label: 'Split second', v: 1, on: ph === 'split' }, { label: 'After', v: 2, on: ph === 'after' }];

  const Rows = ({ ignoresMultiplier }: { ignoresMultiplier: boolean }) => (
    <dl className={s.rows}>
      <div><dt>Tokens locked</dt><dd><b>{d.tokens}</b><small>{d.symbol}</small></dd></div>
      <div><dt>Multiplier</dt><dd><span className={flash ? s.hl : ''}><Flip>{mult}</Flip></span></dd>{ignoresMultiplier && <span className={s.notRead}>Not read</span>}</div>
      <div><dt>Share price</dt><dd><span className={flash ? s.hl : ''}><Flip>{price}</Flip></span><small>USDC</small></dd></div>
    </dl>
  );

  return (
    <Shell active="Split lab" surface="gutter">
      <MotionConfig reducedMotion="user">
        <motion.div className={`${s.grid} ${data ? '' : s.gridEmpty}`} initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.06 } } }}>

          <motion.section variants={rise} className={`${s.card} ${s.title}`} {...tilt}>
            <div className={s.titleTop}><span className={s.pill}>the handkerchief test</span><h1>Split lab</h1></div>
            <div className={s.titleText}><p>What a stock split does to your locked stock</p></div>
          </motion.section>

          {!data && (
            <motion.section variants={rise} className={`${s.card} ${s.empty}`}>
              <motion.span className={s.emptyIcon} aria-hidden animate={{ rotate: [-6, 6, -6] }} transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}>
                <svg viewBox="0 0 24 24" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 3.5h5M10.5 3.5v5.2L5 18.3A1.5 1.5 0 0 0 6.3 20.5h11.4a1.5 1.5 0 0 0 1.3-2.2L13.5 8.7V3.5M7.6 14h8.8" /></svg>
              </motion.span>
              <p>No split yet. The demo admin can schedule one.</p>
            </motion.section>
          )}

          {data && (<>
            <motion.section variants={rise} className={`${s.card} ${s.clockTile}`} {...tilt}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span key={chip[1]} className={`${s.chip} ${chip[1]}`} initial={{ scale: 0.8, rotate: -6, opacity: 0 }} animate={{ scale: 1, rotate: flash ? -4 : 0, opacity: 1 }} exit={{ scale: 0.8, opacity: 0 }} transition={POP}><span />{chip[0]}</motion.span>
              </AnimatePresence>
              <div className={s.clock}><b>{bigClock}</b><span>{subClock}</span></div>
            </motion.section>

            <motion.button variants={rise} type="button" className={s.playTile} onClick={playing ? stop : play} aria-pressed={playing} {...tilt}>
              <motion.span className={s.playIcon} animate={{ scale: playing ? 1.12 : 1 }} transition={POP}>
                {playing
                  ? <svg viewBox="0 0 24 24" width={20} height={20} aria-hidden><rect x={6} y={5} width={4} height={14} rx={1} fill="currentColor" /><rect x={14} y={5} width={4} height={14} rx={1} fill="currentColor" /></svg>
                  : <svg viewBox="0 0 24 24" width={20} height={20} aria-hidden><path d="M8 4.5v15l12-7.5L8 4.5Z" fill="currentColor" /></svg>}
              </motion.span>
              <span className={s.playText}>{playing ? 'Stop' : 'Play the split'}</span>
            </motion.button>

            <motion.section variants={rise} className={`${s.card} ${s.scrubTile}`} {...tilt}>
              <div ref={track} className={s.track} role="slider" tabIndex={0} aria-label="Time" aria-valuemin={0} aria-valuemax={2} aria-valuenow={+p.toFixed(2)} aria-valuetext={chip[0]}
                onPointerDown={(e) => { stop(); e.currentTarget.setPointerCapture(e.pointerId); setDrag(true); setP(at(e)); }}
                onPointerMove={(e) => { if (drag) setP(at(e)); }}
                onPointerUp={(e) => { if (drag) { setDrag(false); setP(snap(at(e))); } }}
                onKeyDown={onKey}>
                <span className={s.rail}><motion.span className={s.fill} animate={{ width: pct }} transition={drag || playing ? { duration: 0 } : SPRING} /></span>
                {Array.from({ length: 9 }, (_, i) => <span key={i} className={`${s.tick} ${(i + 1) * 5 <= p * 50 ? s.tickOn : ''}`} style={{ left: `${(i + 1) * 5}%` }} />)}
                <motion.span className={s.splitMark} animate={flash ? { scaleY: [1, 1.35, 1] } : { scaleY: 1 }} transition={{ duration: 0.4 }} />
                <motion.span className={s.thumb} animate={{ left: pct, scale: drag ? 1.12 : 1 }} transition={drag || playing ? { left: { duration: 0 }, scale: SPRING } : SPRING}><span /></motion.span>
              </div>
              <div className={s.steps}>
                {steps.map((st) => (
                  <motion.button key={st.v} type="button" aria-pressed={st.on} className={s.step} onClick={() => { stop(); setP(st.v); }} whileTap={{ scale: 0.95 }}>
                    {st.on && <motion.span layoutId="stepPill" className={s.stepPill} transition={SPRING} />}
                    <span className={`${s.stepText} ${st.on ? s.stepTextOn : ''}`}>{st.label}</span>
                  </motion.button>
                ))}
              </div>
            </motion.section>

            <motion.section variants={rise} className={s.naiveWrap}>
              <motion.div animate={shake} className={`${s.card} ${s.naive} ${post ? s.naiveWarn : ''}`} aria-label="A vault that reads the display" {...tilt}>
                <div className={s.head}>
                  <span className={s.pill}>A vault that reads the display</span>
                  <span className={s.iconBtn} aria-hidden>
                    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d={post ? 'M12 4 2.8 19.5h18.4L12 4ZM12 10v4.2M12 17v.3' : 'M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6ZM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z'} /></svg>
                  </span>
                </div>
                <div className={s.valueRow}><Count value={naive} /><small>USDC</small></div>
                <div className={s.line}><span className={s.lineBase} /><motion.span className={s.lineFill} animate={{ width: `${(naive / full) * 100}%` }} transition={{ type: 'spring', stiffness: 90, damping: 18 }} /><motion.span className={s.lineDot} animate={{ left: `${(naive / full) * 100}%` }} transition={{ type: 'spring', stiffness: 90, damping: 18 }} /></div>
                <div className={s.slot}>
                  <AnimatePresence mode="wait" initial={false}>
                    {post ? (
                      <motion.div key="warn" role="alert" className={s.warn} initial={{ opacity: 0, y: -14, rotate: -3, scale: 0.94 }} animate={{ opacity: 1, y: 0, rotate: 0, scale: 1 }} exit={{ opacity: 0, y: 10 }} transition={POP}>
                        <span className={s.liquidate}><svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 4 2.8 19.5h18.4L12 4ZM12 10v4.2M12 17v.3" /></svg>Would liquidate you</span>
                        <b>False 90% loss</b>
                        <p>Nothing was lost. This vault misreads the split.</p>
                      </motion.div>
                    ) : (
                      <motion.div key="calm" className={s.calm} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }}>
                        <span className={s.micro}>How it reads</span>
                        <p>Share price times tokens. The multiplier is skipped.</p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
                <div className={s.sees}>
                  <span className={s.micro}>What it sees</span>
                  <Shares post={post} naive tokenInk={post ? 'var(--clay)' : 'var(--tile)'} />
                  <span className={s.seesText}>{post ? `${d.tokens} shares at ${d.priceAfter}. It misses the other 9.90.` : `${d.tokens} shares at ${d.priceBefore}`}</span>
                </div>
                <Rows ignoresMultiplier />
              </motion.div>
            </motion.section>

            <motion.section variants={rise} className={`${s.card} ${s.othello}`} {...tilt} aria-label="Othello">
              <div className={s.head}>
                <span className={s.pills}>
                  <span className={s.pill}>Othello</span>
                  <AnimatePresence>{post && <motion.span className={s.unchanged} initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }} transition={POP}>Unchanged</motion.span>}</AnimatePresence>
                </span>
                <span className={s.iconBtn} aria-hidden><svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5 10 17.5 19 7" /></svg></span>
              </div>
              <div className={s.valueRow}><Count value={full} /><small>USDC</small></div>
              <div className={s.line}><span className={s.lineFull} /><span className={s.lineEnd} /></div>
              <div className={s.slot}>
                <div className={s.calm}>
                  <span className={s.micro}>Counts after its safety haircut</span>
                  <span className={s.haircut}><b>{d.haircut}</b><small>USDC</small></span>
                  <p>The same on both sides of the split.</p>
                </div>
              </div>
              <div className={s.sees}>
                <span className={s.micro}>What it sees</span>
                <Shares post={post} naive={false} tokenInk="var(--teal)" />
                <span className={s.seesText}>{post ? `11 shares at ${d.priceAfter}` : `${d.tokens} shares at ${d.priceBefore}`}</span>
              </div>
              <Rows ignoresMultiplier={false} />
            </motion.section>

            <motion.section variants={rise} className={`${s.card} ${s.verdict}`} {...tilt}>
              <motion.p className={s.headline} initial={false} animate={post ? 'land' : 'dim'} variants={{ dim: {}, land: { transition: { staggerChildren: 0.06, delayChildren: 0.5 } } }}>
                <motion.span variants={{ dim: { opacity: 0.45 }, land: { opacity: 1 } }}>Same stock, same value.</motion.span>{' '}
                {'One vault believes the display.'.split(' ').map((w, i) => (
                  <motion.span key={i} className={s.word} variants={{ dim: { opacity: 0.45, y: 0 }, land: { opacity: 1, y: [14, 0], transition: POP } }}>{w}{' '}</motion.span>
                ))}
              </motion.p>
              <p className={s.explain}>Raw 1.10. Multiplier 10. Share price 15 USDC. Othello values it at 165 USDC, unchanged. A vault that ignores the multiplier thinks it&apos;s worth 16.50 USDC and would liquidate you.</p>
            </motion.section>
          </>)}

          <motion.section variants={rise} className={`${s.card} ${s.foot}`} {...tilt}>
            <div className={s.source}>
              <span className={s.srcTag}><span />{data?.source === 'recorded' ? 'Recorded' : 'Live'}</span>
              <p>
                {data?.source === 'recorded' ? SOURCE.recorded : SOURCE.live}{' '}
                {data?.source === 'recorded' && <Link className={s.srcLink} href="/assets/NFLXx">See the real NFLXx mint, live</Link>}
              </p>
            </div>
            <div className={s.actions}>
              <motion.button type="button" className={s.ghost} onClick={back} whileTap={{ scale: 0.94 }}>Back</motion.button>
              <motion.a className={s.primary} href={liveCircleHref} whileHover={{ rotate: -1.5 }} whileTap={{ scale: 0.95 }} transition={POP}>See a live circle
                <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={3.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6.5 17.5 17.5 6.5M9 6.5h8.5V15" /></svg>
              </motion.a>
            </div>
          </motion.section>
        </motion.div>
      </MotionConfig>
    </Shell>
  );
}
