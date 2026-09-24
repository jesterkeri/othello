"use client";

import { useRouter } from "next/navigation";

import Landing from "@/components/landing/Landing";
import { useWalletUi } from "@/lib/wallet";

export default function Page() {
  const router = useRouter();
  const wallet = useWalletUi();

  return (
    <Landing
      onOpenDemo={() => router.push("/circle/demo")}
      onCreateCircle={() => router.push("/circle/new")}
      walletConnected={!!wallet.address}
      onConnectWallet={wallet.openConnect}
    />
  );
}
