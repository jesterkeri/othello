"use client";

import NotFound from "@/components/othello/NotFound";
import { useActiveSide } from "@/lib/active-side";
import { useEvmWallet } from "@/lib/robinhood/wallet";
import { useWalletUi } from "@/lib/wallet";

/**
 * Next renders this for any unmatched route, and for every `notFound()` call,
 * which is how /circle/<unknown-state> and an out-of-range seat reach it.
 *
 * The wallet shown and "Create a circle" follow the side the connected wallet decides (lib/active-side.ts): a
 * MetaMask user is shown their Robinhood wallet and Robinhood's create page, never Solana's; with no wallet the
 * neutral circles entry asks for one.
 */
const CREATE = { robinhood: "/robinhood/new", solana: "/circle/new" } as const;

export default function NotFoundPage() {
  const wallet = useWalletUi();
  const evm = useEvmWallet();
  const { side } = useActiveSide();
  return (
    <NotFound
      createHref={side ? CREATE[side] : "/circles"}
      walletAddress={side === "robinhood" ? evm.address : wallet.address}
      onConnectWallet={wallet.openConnect}
    />
  );
}
