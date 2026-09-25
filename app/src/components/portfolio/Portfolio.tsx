'use client';

/**
 * Portfolio (Joshua, 2026-09-25: "isn't that a core feature?"; FRAME §4 had cut "portfolio
 * dashboard" before the buy flow existed). For the connected wallet: its seat in the demo circle
 * (devnet, live), the xStocks it holds (mainnet, live, valued at Jupiter's price), and the demo's
 * tokens (devnet). Read-only; every figure is from the chain or Jupiter, or the section says it
 * could not be read.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';

import s from '@/components/howitworks/HowItWorks.module.css';
import Shell from '@/components/othello/Shell';
import type { Holdings } from '@/app/api/holdings/route';
import { formatRaw, formatUsdc, obligations, seatSet, stockCover } from '@/lib/circle';
import type { LiveCircle } from '@/lib/live';
import { useWalletUi } from '@/lib/wallet';

const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const shownAmount = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 6 });

export default function Portfolio() {
  const w = useWalletUi();
  const [circle, setCircle] = useState<LiveCircle | null>(null);
  const [circleErr, setCircleErr] = useState<string | null>(null);
  const [hold, setHold] = useState<Holdings | null>(null);
  const [holdErr, setHoldErr] = useState<string | null>(null);

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
  const total = hold?.xstocks.reduce((t, h) => t + (h.usdValue ?? 0), 0) ?? 0;

  return (
    <Shell active="Portfolio" surface="gutter">
      <div className={s.grid}>
        <section className={`${s.card} ${s.hero}`}>
          <h1>Portfolio</h1>
          <p>What this wallet owns, what it has locked as a promise, and where it stands in its circle.</p>
          {!w.address && (
            <p className={s.note}>Connect a wallet (top right) to see its holdings. Othello only reads them; it never holds your keys.</p>
          )}
        </section>

        {w.address && (
          <>
            <section className={`${s.card} ${s.wide} ${s.s2}`}>
              <h2 className={s.title}>Your circle</h2>
              {circleErr ? (
                <p className={s.body}>Live data unavailable: {circleErr}</p>
              ) : !c ? (
                <p className={s.body}>Reading the demo circle…</p>
              ) : me ? (
                <>
                  <p className={s.body}>
                    You are {me.name}, seat {me.turn + 1} of {c.n}, in the demo circle on devnet. You locked{' '}
                    {formatRaw(me.lockedRaw, 2)} NFLXx (mirror), counted at {formatUsdc(stockCover(me, c), 0)} test USDC.
                  </p>
                  <div className={s.live}>
                    <span className={s.chip}>
                      Round {c.round + 1}: {seatSet(c.paidBitmap, me.turn) ? 'paid' : 'due'}
                    </span>
                    <span className={s.chip}>
                      Pot: {seatSet(c.receivedBitmap, me.turn) ? 'received' : `yours in round ${me.turn + 1}`}
                    </span>
                    <span className={s.chip}>Owed: {formatUsdc(obligations(c, me), 0)} test USDC</span>
                    <span className={s.chip}>Guarantee: {formatUsdc(c.guaranteePerMember, 0)} test USDC</span>
                  </div>
                  <Link className={s.cta} href={`/circle/demo/position/${me.turn + 1}`}>Your seat</Link>
                </>
              ) : (
                <>
                  <p className={s.body}>
                    This wallet is not in a circle yet. The demo circle&apos;s five seats are taken; you can watch it run.
                  </p>
                  <Link className={s.cta} href="/circle/demo">Open the demo circle</Link>
                </>
              )}
            </section>

            <section className={`${s.card} ${s.wide} ${s.s1}`}>
              <h2 className={s.title}>Your xStocks{hold && hold.xstocks.length ? `: ${usd(total)}` : ''}</h2>
              {holdErr ? (
                <p className={s.body}>Live data unavailable: {holdErr}</p>
              ) : !hold ? (
                <p className={s.body}>Reading this wallet on Solana mainnet…</p>
              ) : hold.xstocks.length === 0 ? (
                <>
                  <p className={s.body}>No xStocks in this wallet on mainnet yet.</p>
                  <Link className={s.cta} href="/assets">Browse xStocks</Link>
                </>
              ) : (
                <>
                  <div className={s.live}>
                    {hold.xstocks.map((h) => (
                      <Link key={h.address} href={`/assets/${h.symbol}`} className={s.chip}>
                        {h.symbol} {shownAmount(h.shown)}{h.usdValue !== null ? ` · ${usd(h.usdValue)}` : ''}
                      </Link>
                    ))}
                  </div>
                  <p className={s.note}>Amounts as your wallet shows them (raw times each stock&apos;s multiplier); values at Jupiter&apos;s price. Mainnet.</p>
                </>
              )}
            </section>

            <section className={`${s.card} ${s.hero} ${s.s6}`}>
              <h2 className={s.title}>Demo tokens (devnet)</h2>
              {holdErr ? (
                <p className={s.body}>Live data unavailable: {holdErr}</p>
              ) : !hold ? (
                <p className={s.body}>Reading devnet…</p>
              ) : (
                <p className={s.body}>
                  {formatRaw(Number(hold.devnet.mirrorRaw), 2)} NFLXx devnet mirror (not the real NFLXx) and{' '}
                  {formatUsdc(Number(hold.devnet.testUsdc))} Othello test USDC (devnet only, not real USDC) outside any circle.
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </Shell>
  );
}
