'use client';

/**
 * A page that belongs to one chain, behind the wallet that decides the side (lib/active-side.ts; Joshua 2026-10-03):
 * - no wallet connected: the page asks for one and shows nothing of either chain;
 * - only the other chain's wallet connected: the person is sent to that side's page of the same kind, so a judge with
 *   MetaMask never sees a Solana page, and the reverse;
 * - this chain's wallet connected (or both): the page itself.
 */
import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';

import Shell from '@/components/othello/Shell';
import s from '@/components/robinhood/Robinhood.module.css';
import { useActiveSide } from '@/lib/active-side';
import { sideOf, type ChainSide } from '@/lib/chains';
import { useWalletUi } from '@/lib/wallet';

import { gateDecision, labelOf, type GatedLabel } from '@/lib/side-rules';

export type { GatedLabel };

/** How long the connected wallets must hold still before a redirect to the other side. */
export const SETTLE_MS = 1200;

/** What the gate says it is waiting for, per menu label. */
const WHAT: Record<GatedLabel, string> = { Circles: 'your circles', Portfolio: 'your portfolio', Assets: 'the assets for your chain', Create: 'where to start a circle', 'Split lab': 'the split lab' };

/** The menu item a gated page sits under (starting a circle is under Circles). */
const NAV_OF = (l: GatedLabel) => (l === 'Create' ? 'Circles' : l === 'Split lab' ? 'How it works' : l);

/** What to connect, for a page of one chain or (null) for the neutral entry that serves both. */
const ASK: Record<ChainSide | 'any', string> = {
  robinhood: 'Connect an EVM wallet such as MetaMask: these pages are on Robinhood Chain testnet.',
  solana: 'Connect a Solana wallet: these pages are on Solana devnet.',
  any: 'An EVM wallet such as MetaMask opens Robinhood Chain testnet; a Solana wallet opens Solana devnet.',
};

export function ConnectGate({ label, side = null }: { label: GatedLabel; side?: ChainSide | null }) {
  const ui = useWalletUi();
  return (
    <Shell active={NAV_OF(label)} side={side ?? undefined}>
      <div className={s.page}>
        <header className={s.head}>
          <h1 className={s.title}>{label === 'Create' ? 'Start a circle' : label}</h1>
          <p className={s.sub}>
            Connect a wallet to see {WHAT[label]}. {ASK[side ?? 'any']} Connecting shares your address only; nothing is
            sent without your approval.
          </p>
          <div>
            <button type="button" className={s.btn} onClick={ui.openConnect}>Connect wallet</button>
          </div>
        </header>
      </div>
    </Shell>
  );
}

export default function SideGate({ side, label, children }: { side: ChainSide; label: GatedLabel; children: ReactNode }) {
  const { connected } = useActiveSide();
  const router = useRouter();
  const d = gateDecision(side, label, connected);
  const to = d.show === 'redirect' ? d.to : null;
  // Wallets restore on load at different moments (lib/wallet.tsx, lib/robinhood/evm-session.ts): wait until the
  // connected set has held still before sending anyone away, or a person with both wallets could be moved to the other
  // side only because that wallet restored first.
  useEffect(() => {
    if (!to) return;
    const t = setTimeout(() => router.replace(to), SETTLE_MS);
    return () => clearTimeout(t);
  }, [to, router]);
  if (d.show === 'page') return <>{children}</>;
  if (d.show === 'redirect') {
    return (
      <Shell active={NAV_OF(label)}>
        <div className={s.page}><p className={s.muted} role="status">Opening {WHAT[label]} on {side === 'solana' ? 'Robinhood Chain' : 'Solana'}…</p></div>
      </Shell>
    );
  }
  // neutral unless it is a Robinhood Chain page: the menu with no wallet leads to the Solana routes too, and the base
  // site shows neither chain there; /robinhood keeps speaking to the person who came for it (the Open House link)
  return <ConnectGate label={label} side={side === 'robinhood' ? 'robinhood' : null} />;
}

/** For a route group's layout: the chain and the label come from the URL, so every page under it is gated alike. */
export function RouteGate({ children }: { children: ReactNode }) {
  const pathname = usePathname() || '/';
  return <SideGate side={sideOf(pathname)} label={labelOf(pathname)}>{children}</SideGate>;
}
