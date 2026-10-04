"use client";

import Landing from "@/components/landing/Landing";
import { useActiveSide } from "@/lib/active-side";
import { useWalletUi } from "@/lib/wallet";

/** The home page: neutral with no wallet; with one, it leads to that wallet's chain (lib/active-side.ts). */
export default function Page() {
  const wallet = useWalletUi();
  const { side } = useActiveSide();
  return <Landing side={side} onConnectWallet={wallet.openConnect} />;
}
