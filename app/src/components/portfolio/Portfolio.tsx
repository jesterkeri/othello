'use client';

/**
 * Portfolio (Joshua, 2026-09-25: "isn't that a core feature?"; FRAME §4 had cut "portfolio
 * dashboard" before the buy flow existed). Portfolio.dc.html (Claude Design): a total card for the
 * wallet's xStocks (mainnet, real) beside a card for its circle (devnet, test USDC), then one row per
 * holding: raw x multiplier = what the wallet shows, Jupiter's price and 24h move, value and share.
 * Read-only; every figure is from the chain or Jupiter, or the section says it could not be read.
 * Mainnet and devnet are never mixed in one card or one total.
 */
import Link from 'next/link';
import { useEffect, useState, type CSSProperties } from 'react';

import Shell from '@/components/othello/Shell';
import { useLiveXStocks } from '@/components/assets/useLiveXStocks';
import type { Holdings } from '@/app/api/holdings/route';
import { RAW_DECIMALS, USDC_DECIMALS, formatRaw, formatUsdc, obligations, seatSet, stockCover } from '@/lib/circle';
import { exactTokens, shownTokens } from '@/lib/format';
import type { LiveCircle } from '@/lib/live';
import { useWalletUi } from '@/lib/wallet';

import s from './Portfolio.module.css';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const SLOTS = ['clay', 'cobalt', 'sky', 'teal', 'acid'] as const;

const Arrow = ({ d = 'M7 17 17 7M9 7h8v8' }: { d?: string }) => (
  <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);

export default function Portfolio() {
  const w = useWalletUi();
  const [circle, setCircle] = useState<LiveCircle | null>(null);
  const [circleErr, setCircleErr] = useState<string | null>(null);
  const [hold, setHold] = useState<Holdings | null>(null);
  const [holdErr, setHoldErr] = useState<string | null>(null);
  const [how, setHow] = useState(false);
  // Jupiter's 24h move per mint, from the same read the Stocks page uses. Missing means not shown.
  const { data: market } = useLiveXStocks();

  useEffect(() => {
    if (!w.address) return;
    let alive = true;
    setHold(null); setHoldErr(null); setCircle(null); setCircleErr(null);
    fetch('/api/circle', { cache: 'no-store' })
      .then((r) => r.json() as Promise<LiveCircle | { error: string }>)
      .then((b) => { if (!alive) return; if ('error' in b) throw new Error(b.error); setCircle(b); })
      .catch((e: unknown) => alive && setCircleErr(e instanceof Error ? e.message : String(e)));
    fetch(`/api/holdings?owner=${encodeURIComponent(w.address)}`, { cache: 'no-store' })
      .then((r) => r.json() as Promise<Holdings | { error: string }>)
      .then((b) => { if (!alive) return; if ('error' in b) throw new Error(b.error); setHold(b); })
      .catch((e: unknown) => alive && setHoldErr(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, [w.address]);

  const c = circle?.view;
  const me = c && w.address ? c.members.find((m) => m.address === w.address) : undefined;
  // A total only when every holding is priced: a failed price read must never show as $0 (adversary).
  const unpriced = hold?.xstocks.filter((h) => h.usdValue === null) ?? [];
  const total = hold && unpriced.length === 0 ? hold.xstocks.reduce((t, h) => t + h.usdValue!, 0) : null;
  const change = (address: string) => market?.mints.find((m) => m.address === address)?.market?.change24h ?? null;
  // The 24h move in dollars, from each holding's value now and Jupiter's 24h percentage.
  const moves = hold?.xstocks.map((h) => (h.usdValue !== null && change(h.address) !== null ? (h.usdValue * change(h.address)!) / (100 + change(h.address)!) : null)) ?? [];
  const dayMove = total !== null && moves.length > 0 && moves.every((m) => m !== null) ? moves.reduce((a, b) => a + b!, 0) : null;
  const rows = (hold?.xstocks ?? []).map((h, i) => ({ ...h, slot: SLOTS[i % SLOTS.length]!, share: total ? (h.usdValue ?? 0) / total : null, chg: change(h.address) }));
  const anyDown = !!(circleErr || holdErr);

  return (
    <Shell active="Portfolio">
      <header className={s.head}>
        <h1 className={s.title}>Portfolio</h1>
        {w.address && (
          <span className={s.readLine}>
            <span className={s.read}><span style={{ background: anyDown ? 'var(--clay)' : 'var(--teal)' }} />{anyDown ? 'A read failed' : 'Live · devnet and mainnet'}</span>
            <span>Read only. Othello never holds your keys.</span>
          </span>
        )}
      </header>

      {!w.address ? (
        <section className={s.connect}>
          <span className={s.tagLine}>Read only</span>
          <h2>Connect a wallet to see what you own and what you have promised.</h2>
          <p>Othello reads your circle seat, your xStocks and your demo tokens. It never holds your keys and cannot move anything. You approve every transaction in your own wallet.</p>
          <button type="button" className={s.btnInk} onClick={w.openConnect}>Connect wallet<Arrow d="M5 12h14M13 6l6 6-6 6" /></button>
        </section>
      ) : (
        <>
          <div className={s.top}>
            <section aria-label="Your xStocks" className={s.total}>
              <span aria-hidden className={s.corner} />
              <span aria-hidden className={s.dashes}><span /><span /><span /></span>
              <div className={s.pills}>
                <span className={s.pillLine}>Your xStocks · mainnet</span>
                {dayMove !== null && (
                  <span className={s.pillDay} style={{ background: dayMove >= 0 ? 'var(--teal)' : 'var(--clay)', color: dayMove >= 0 ? 'var(--tealInk)' : 'var(--clayInk)' }}>
                    {dayMove >= 0 ? '+' : '−'}{usd(Math.abs(dayMove))} · 24h
                  </span>
                )}
              </div>
              {holdErr ? (
                <div className={s.down}><b>Live data unavailable</b><span>We could not read this wallet on mainnet ({holdErr}), so no amounts or values are shown.</span></div>
              ) : !hold ? (
                <div className={s.skel} />
              ) : hold.xstocks.length === 0 ? (
                <div className={s.down}>
                  <b className={s.bigMuted}>$0.00</b>
                  <b>No xStocks yet</b>
                  <span>Anything you buy shows up here.</span>
                  <Link href="/assets" className={s.btnInk}>Browse assets<Arrow d="M5 12h14M13 6l6 6-6 6" /></Link>
                </div>
              ) : (
                <>
                  {total !== null ? (
                    <b className={s.big}>{usd(total)}</b>
                  ) : (
                    <b className={s.bigMuted}>Value unavailable</b>
                  )}
                  <span className={s.holdLabel}>
                    {hold.xstocks.length === 1 ? '1 holding' : `${hold.xstocks.length} holdings`}
                    {unpriced.length > 0 ? `. Jupiter has no price right now for ${unpriced.map((h) => h.symbol).join(', ')}, so no total is shown.` : ''}
                  </span>
                  {total !== null && (
                    <>
                      <div className={s.bar}>
                        {rows.map((h, i) => (
                          <span key={h.address} title={`${h.symbol} ${((h.share ?? 0) * 100).toFixed(1)}%`} style={{ flex: `${h.share ?? 0} 1 0`, background: `var(--${h.slot})`, animationDelay: `${0.25 + i * 0.08}s` }} />
                        ))}
                      </div>
                      <div className={s.legend}>
                        {rows.map((h) => (
                          <span key={h.address}><span style={{ background: `var(--${h.slot})` }} />{h.symbol} {((h.share ?? 0) * 100).toFixed(1)}%</span>
                        ))}
                      </div>
                    </>
                  )}
                </>
              )}
            </section>

            <section aria-label="Your circle" className={s.circle}>
              <span aria-hidden className={s.rings}><span /></span>
              <div className={s.pillsSpread}>
                <span className={s.pillLine}>Your circle</span>
                <span className={s.pillCream}>Devnet · test USDC</span>
              </div>
              {circleErr ? (
                <div className={s.down}><b>Live data unavailable</b><span>We could not read the circle on devnet ({circleErr}), so no numbers are shown.</span></div>
              ) : !c ? (
                <div className={s.skel} />
              ) : me ? (
                <Link href={`/circle/demo/position/${me.turn + 1}`} className={s.circleLink}>
                  <span className={s.circleTop}>
                    <span>
                      <b className={s.roundBig}>{c.status === 'Active' ? `Round ${c.round + 1} of ${c.n}` : c.status}</b>
                      <span className={s.circleSub}>
                        {me.name}, seat {me.turn + 1} ·{' '}
                        {seatSet(c.receivedBitmap, me.turn) ? 'you have received your pot' : c.round === me.turn ? 'your pot is this round' : `your pot is round ${me.turn + 1}`}
                      </span>
                    </span>
                    <span className={s.tick}><Arrow /></span>
                  </span>
                  <span className={s.pips} aria-label="Rounds">
                    {c.members.map((m) => {
                      const got = seatSet(c.receivedBitmap, m.turn);
                      const mine = m.turn === me.turn;
                      return (
                        <span key={m.address} title={`Round ${m.turn + 1}: ${m.name}${got ? ', paid out' : ''}`}
                          style={{ background: mine ? 'var(--acid)' : got ? 'var(--teal)' : 'transparent', borderStyle: got || mine ? 'solid' : 'dashed' }} />
                      );
                    })}
                  </span>
                  <span className={s.facts}>
                    <span><span>Locked</span>{formatRaw(me.lockedRaw, 2)} NFLXx devnet mirror</span>
                    <span><span>Counts as</span>{formatUsdc(stockCover(me, c), 0)} test USDC</span>
                    <span><span>Round {c.round + 1}</span>{seatSet(c.paidBitmap, me.turn) ? 'paid' : 'due'}</span>
                    <span><span>Guarantee</span>{formatUsdc(c.guaranteePerMember, 0)} test USDC</span>
                    <span><span>You owe</span>{formatUsdc(obligations(c, me), 0)} test USDC</span>
                  </span>
                </Link>
              ) : (
                <div className={s.down}>
                  <b>Not in a circle yet</b>
                  <span>
                    The demo circle&apos;s five seats are taken. Watch it run: once every seat has paid and the program&apos;s
                    checks pass, anyone can release the pot, and the circle page shows what is possible right now.
                  </span>
                  <Link href="/circle/demo" className={s.btnCream}>Open the demo circle<Arrow d="M5 12h14M13 6l6 6-6 6" /></Link>
                </div>
              )}
              <Link href="/circle/demo" className={s.allLink}>The demo circle<Arrow d="M5 12h14M13 6l6 6-6 6" /></Link>
            </section>
          </div>

          {hold && hold.xstocks.length > 0 && (
            <section aria-label="Holdings" className={s.holdings}>
              <div className={s.holdHead}>
                <span className={s.holdTitle}>
                  <span>Holdings</span>
                  <button type="button" className={s.info} aria-expanded={how} aria-label="How Othello counts your holdings" onClick={() => setHow(!how)}>i</button>
                  {how && (
                    <span role="dialog" aria-label="How Othello counts" className={s.how}>
                      <b>Before × multiplier = what you hold.</b>
                      <span>Issuers change a token&apos;s multiplier for a split or a dividend. Othello reads it from the mint, so a split never looks like a loss.</span>
                    </span>
                  )}
                </span>
                <Link href="/assets" className={s.allStocks}>All assets<Arrow d="M5 12h14M13 6l6 6-6 6" /></Link>
              </div>
              {rows.map((h) => (
                <Link key={h.address} href={`/assets/${h.symbol}`} className={s.row} style={{ '--slot': `var(--${h.slot})` } as CSSProperties}>
                  <span className={s.badge} style={{ background: `var(--${h.slot})`, color: `var(--${h.slot}Ink)` }} aria-hidden>{h.symbol.slice(0, 2)}</span>
                  <span className={s.name}><b>{h.symbol}</b><span>{h.name}</span></span>
                  {/* Exact: the on-chain u64 as a decimal string, never through a JS number (Codex T18d r2). */}
                  <span className={s.math} title="Tokens before the multiplier, times the multiplier, is what your wallet shows">
                    <span>{exactTokens(h.raw, h.decimals)} before ×</span>
                    <span>× {Number(h.multiplier.toFixed(4))}</span>
                    <span className={s.mathEq}>= {shownTokens(h.raw, h.decimals, h.multiplier)}</span>
                  </span>
                  <span className={s.price}>
                    <span>{h.usdValue !== null && h.shown > 0 ? usd(h.usdValue / h.shown) : 'No price'}</span>
                    {h.chg !== null && (
                      <span className={s.chg} style={{ background: h.chg >= 0 ? 'var(--teal)' : 'var(--clay)', color: h.chg >= 0 ? 'var(--tealInk)' : 'var(--clayInk)' }}>
                        {h.chg >= 0 ? '+' : '−'}{Math.abs(h.chg).toFixed(2)}%
                      </span>
                    )}
                  </span>
                  <span className={s.value}>
                    <b>{h.usdValue !== null ? usd(h.usdValue) : 'Unavailable'}</b>
                    <span>{h.share !== null ? `${(h.share * 100).toFixed(1)}% of total` : 'not valued'}</span>
                  </span>
                  <span className={s.arrow}><Arrow /></span>
                </Link>
              ))}
            </section>
          )}

          <section aria-label="Demo tokens" className={s.demo}>
            <span className={s.demoHead}><b>Demo tokens</b><span className={s.tagDashed}>Devnet · no real value</span></span>
            {holdErr ? (
              <span>Live data unavailable</span>
            ) : !hold ? (
              <span>Reading devnet…</span>
            ) : (
              <span className={s.demoPills}>
                <span><b>{exactTokens(hold.devnet.mirrorRaw, RAW_DECIMALS)}</b> NFLXx devnet mirror (not the real NFLXx)</span>
                <span><b>{exactTokens(hold.devnet.testUsdc, USDC_DECIMALS)}</b> Othello test USDC (not real USDC)</span>
              </span>
            )}
          </section>
        </>
      )}

      <footer className={s.foot}>
        <span>Your xStocks are real, on Solana mainnet; prices from Jupiter. Circle money is test USDC on devnet.</span>
        <Link href="/how-it-works">How it works</Link>
      </footer>
    </Shell>
  );
}
