'use client';

/**
 * How it works, without a chain's specifics (Joshua, 2026-10-03: the base site is neutral; the connected wallet adds
 * its chain). Shown with no wallet, and with an EVM wallet (then with Robinhood Chain testnet's facts and nothing of
 * Solana). With a Solana wallet the page is the live Solana demo walkthrough (HowItWorks.tsx).
 *
 * Every rule here holds on both chains: 3 to 8 members; collateral plus a guarantee into a shared reserve; a default
 * only for a member who has received the pot, after the grace period (OthelloCircle.sol PrePayoutDefaultUnsupported,
 * GraceNotElapsed); the next payout pauses when the reserve cannot cover it, until a member tops up.
 */
import Shell from '@/components/othello/Shell';
import type { ChainSide } from '@/lib/chains';

import s from './HowItWorks.module.css';

export default function HowItWorksNeutral({ side }: { side: Extract<ChainSide, 'robinhood'> | null }) {
  const asset = side === 'robinhood' ? 'test USDG' : 'an asset';
  return (
    <Shell active="How it works" surface="gutter" side={side ?? undefined}>
      <div className={s.grid}>
        <section className={`${s.card} ${s.hero}`}>
          <h1>How Othello works</h1>
          <p>
            A savings circle (ajo, esusu, tontine) with a promise behind it. Members pay in every round and take the whole pot
            in turn. The usual risk is the member who has already taken the pot and stops paying: here, that member has
            locked {asset} on-chain that covers what they still owe. If it falls short, the shared reserve makes up the
            difference, and if even that is not enough, the next payout pauses until someone tops up.
          </p>
          <p className={s.note}>
            What it does not remove: a member who stops paying before their turn can stall the circle, because in this version
            it waits for them; the locked asset&apos;s issuer can freeze, pause or move its tokens; and every step (paying out a
            pot, declaring a default, topping up) happens when someone sends the transaction. Nothing runs by itself.
          </p>
          {side === 'robinhood' ? (
            <p className={s.note}>On Robinhood Chain testnet, members pay and lock test USDG (Paxos&apos;s Global Dollar). Test USDG only; it has no value. No fee on testnet.</p>
          ) : (
            <p className={s.note}>Connect a wallet to try it: an EVM wallet such as MetaMask opens Robinhood Chain testnet; a Solana wallet opens Solana devnet.</p>
          )}
        </section>

        <section className={`${s.card} ${s.step} ${s.s1}`}>
          <span className={s.num}>1</span>
          <h2 className={s.title}>Three to eight members, one pot</h2>
          <p className={s.body}>
            The person who starts a circle names every member and the order they receive the pot. Each round, everyone pays the
            same amount and one member takes the whole pot.
          </p>
        </section>

        <section className={`${s.card} ${s.step} ${s.s2}`}>
          <span className={s.num}>2</span>
          <h2 className={s.title}>Each locks a promise</h2>
          <p className={s.body}>
            To join, each member locks {asset} as collateral and adds a small guarantee to a shared reserve. The collateral is
            still theirs: it comes back when the circle ends, unless they take the pot and stop paying.
          </p>
        </section>

        <section className={`${s.card} ${s.step} ${s.s3}`}>
          <span className={s.num}>3</span>
          <h2 className={s.title}>Pay in, take turns</h2>
          <p className={s.body}>
            Every round, everyone pays in and the pot goes to that round&apos;s member. Any member can send the transaction that
            releases it; nothing runs by itself.
          </p>
        </section>

        <section className={`${s.card} ${s.wide} ${s.s4}`}>
          <span className={s.num}>4</span>
          <h2 className={s.title}>If someone stops paying</h2>
          <p className={s.body}>
            The risk is a member who has already taken the pot and stops paying. Once the round&apos;s grace period runs out,
            anyone can declare the default: their locked collateral covers the payments they still owe, and the shared reserve
            makes up any shortfall. If even the reserve falls short, the next payout pauses until someone tops up. Someone who
            stops before their turn has taken nothing; in this version the circle waits for them, and they can still pay late.
          </p>
        </section>

        {/* moved here from the Robinhood circles page (Joshua 2026-10-06: it is the mainnet plan, not about your circles) */}
        <section className={`${s.card} ${s.wide}`} aria-labelledby="mainnet-plan">
          <h2 id="mainnet-plan" className={s.title}>Planned for mainnet: interest on idle USDG</h2>
          <p className={s.body}>
            On Robinhood Chain mainnet, USDG in your wallet could earn interest from borrowers through a USDG lending
            vault on Morpho, already live there. The rate moves with demand and nothing is promised. Lending carries
            risk: money can be lost, and a withdrawal can wait while the vault&apos;s USDG is lent out. Circle money
            stays out of it. Not built yet: nothing on this testnet earns.
          </p>
        </section>
      </div>
    </Shell>
  );
}
