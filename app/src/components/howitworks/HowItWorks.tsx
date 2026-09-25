'use client';

/**
 * How it works: the judge's path through Othello, in six steps, each with LIVE numbers from the
 * demo circle on devnet (/api/circle) and a link into the real screen. Replaces the nav's 404.
 * Every figure comes from the chain or SPEC.md:137's demo parameters the chain was seeded with;
 * while the read is pending or failed, the steps say so instead of showing a number.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';

import Shell from '@/components/othello/Shell';
import { countSeats, formatUsdc, formatRaw, recipient, stockCover } from '@/lib/circle';
import type { LiveCircle } from '@/lib/live';

import s from './HowItWorks.module.css';

export default function HowItWorks() {
  const [live, setLive] = useState<LiveCircle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/circle', { cache: 'no-store' })
      .then((r) => r.json() as Promise<LiveCircle | { error: string }>)
      .then((b) => {
        if (!alive) return;
        if ('error' in b) throw new Error(b.error);
        setLive(b);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, []);

  const c = live?.view;
  const m0 = c?.members[0];
  const cover = c && m0 ? formatUsdc(stockCover(m0, c), 0) : null;
  const who = c ? recipient(c) : undefined;
  const pending = error ? 'live figures unavailable' : 'reading the live circle…';
  const money = 'test USDC';

  return (
    <Shell active="How it works" surface="gutter">
      <div className={s.grid}>
        <section className={`${s.card} ${s.hero}`}>
          <h1>How Othello works</h1>
          <p>
            A savings circle (ajo, esusu, tontine) where nobody has to trust anybody. Friends pay in every round and take the
            whole pot in turn. What stops the ones already paid from walking away is tokenized stock they lock as a promise.
          </p>
          <p className={s.note}>
            Everything below is the live demo circle on Solana devnet: its money is test USDC and its stock a labelled mirror of
            Netflix&apos;s xStock. The real xStocks pages read Solana mainnet.
          </p>
        </section>

        <section className={`${s.card} ${s.step} ${s.s1}`}>
          <span className={s.num}>1</span>
          <h2 className={s.title}>Five friends, one pot</h2>
          <p className={s.body}>
            {c ? `${c.n} members each pay ${formatUsdc(c.contribution, 0)} ${money} a round. Each round one of them takes the whole pot, ${formatUsdc(c.contribution * c.n, 0)}.` : pending}
          </p>
          {c && <div className={s.live}>{c.members.map((m) => <span key={m.address} className={s.chip}>{m.turn + 1}. {m.name}</span>)}</div>}
          <Link className={s.cta} href="/circle/demo">Meet the circle</Link>
        </section>

        <section className={`${s.card} ${s.step} ${s.s2}`}>
          <span className={s.num}>2</span>
          <h2 className={s.title}>Each locks a promise</h2>
          <p className={s.body}>
            {c && m0
              ? `Each locked ${formatRaw(m0.lockedRaw, 2)} NFLXx (mirror), counted at ${cover} ${money} after a 20% safety margin, and put ${formatUsdc(c.guaranteePerMember, 0)} into a shared reserve (${formatUsdc(c.reserveTotal, 0)} in all). They still own it and get it back at the end.`
              : pending}
          </p>
          <Link className={s.cta} href="/circle/demo/position/2">See Tunde&apos;s seat</Link>
        </section>

        <section className={`${s.card} ${s.step} ${s.s3}`}>
          <span className={s.num}>3</span>
          <h2 className={s.title}>Pay in, take turns</h2>
          <p className={s.body}>
            {c
              ? c.status === 'Active'
                ? `Round ${c.round + 1} of ${c.n}: ${countSeats(c.paidBitmap, c.n)} of ${c.n} have paid. When all have, the pot goes to ${who?.name ?? 'this round’s seat'}. Paying late still counts.`
                : `The circle is ${c.status}.`
              : pending}
          </p>
          <Link className={s.cta} href="/circle/demo">Watch the round</Link>
        </section>

        <section className={`${s.card} ${s.wide} ${s.s4}`}>
          <span className={s.num}>4</span>
          <h2 className={s.title}>If someone stops paying</h2>
          <p className={s.body}>
            The risk is a member who has already taken the pot and stops paying. Once the round&apos;s grace runs out, anyone
            can declare the default: their locked stock is sold to a liquidation pool at a discount to cover every payment they
            still owe, so the rest of the circle keeps getting paid, and what isn&apos;t needed goes back to them at the end.
            Someone who stops before their turn has taken nothing; in this version the circle waits for them, and they can
            still pay late.
          </p>
        </section>

        <section className={`${s.card} ${s.wide} ${s.s5}`}>
          <span className={s.num}>5</span>
          <h2 className={s.title}>A stock split can&apos;t fool it</h2>
          <p className={s.body}>
            When Netflix split 10-for-1, every NFLXx holder&apos;s wallet showed ten times the tokens at a tenth of the price. A
            vault that reads the display would see a 90% loss and liquidate. Othello reads the multiplier: the cover stays
            {cover ? ` ${cover} ${money}` : ' the same'}, before and after.
          </p>
          <Link className={s.cta} href="/split-lab">Play the split</Link>
        </section>

        <section className={`${s.card} ${s.hero} ${s.s6}`}>
          <span className={s.num}>6</span>
          <h2 className={s.title}>Real stocks behind it</h2>
          <p className={s.body}>
            xStocks are real shares tokenized on Solana. You can buy them today, and four of them (S&amp;P 500, NVIDIA, Apple,
            Netflix) are the cover a circle accepts.
          </p>
          <Link className={s.cta} href="/assets">Browse xStocks</Link>
        </section>
      </div>
    </Shell>
  );
}
