"use client";

import NotFound from "@/components/othello/NotFound";
import { useWalletUi } from "@/lib/wallet";

/**
 * Next renders this for any unmatched route, and for every `notFound()` call,
 * which is how /circle/<unknown-state> and an out-of-range seat reach it.
 *
 * `createHref` is passed because the handoff defaults to /circles/new and this
 * app routes /circle/new. Passing it beats editing the component: the design
 * session owns that file and will hand it again.
 */
export default function NotFoundPage() {
  const wallet = useWalletUi();
  return (
    <NotFound
      createHref="/circle/new"
      walletAddress={wallet.address}
      onConnectWallet={wallet.openConnect}
    />
  );
}
