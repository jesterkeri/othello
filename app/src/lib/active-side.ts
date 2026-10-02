'use client';

/**
 * The connected wallet decides what the site shows (Joshua, 2026-10-03): with no wallet the site is neutral and
 * anything that belongs to one chain asks for a wallet; an EVM wallet shows the Robinhood Chain side and nothing of
 * Solana; a Solana wallet shows the Solana side and nothing of Robinhood Chain. With both connected, the page's own
 * side (the route, lib/chains.ts) decides, and the chain switch is there to move between them.
 */
import { usePathname } from 'next/navigation';

import { sideOf, type ChainSide } from '@/lib/chains';
import { activeSide, type Connected } from '@/lib/side-rules';
import { useEvmWallet } from '@/lib/robinhood/wallet';
import { useWalletUi } from '@/lib/wallet';

export { activeSide, showsChainSwitch, type Connected } from '@/lib/side-rules';

export function useConnected(): Connected {
  const sol = useWalletUi();
  const evm = useEvmWallet();
  return { solana: !!sol.address, robinhood: !!evm.address };
}

export function useActiveSide(): { side: ChainSide | null; connected: Connected } {
  const connected = useConnected();
  const pathname = usePathname();
  return { side: activeSide(connected, sideOf(pathname)), connected };
}
