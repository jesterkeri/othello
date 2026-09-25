"use client";

import { useRouter } from "next/navigation";

import Create, { type CreateError } from "@/components/othello/Create";
import { useWalletUi } from "@/lib/wallet";

/**
 * The Create place, at the route Landing's "Create a circle" already pointed
 * at. That link was a real 404 until this landed.
 *
 * With no wallet the screen shows "Connect wallet" and opens the connect modal.
 *
 * With a wallet, the form can be submitted, and `onCreate` refuses with the TRUE reason. It must
 * be passed: Create treats a missing `onCreate` as success and would show "created" for a circle
 * that does not exist. The program is on devnet (T23), but a circle made here could never start:
 * each member must lock the NFLXx devnet mirror and pay test USDC, and this demo cannot hand
 * those out yet (Joshua, 2026-09-25: the judge path uses the live demo circle instead).
 */
const notYet: CreateError = {
  kind: "program",
  reason:
    "Not in this demo yet. Every member of a new circle must lock the NFLXx devnet mirror and pay test USDC, and this demo can't hand those out, so a circle made here would wait forever. The live demo circle (Circles, in the menu) shows a complete one. Nothing was sent.",
};
export default function CreateCirclePage() {
  const router = useRouter();
  const wallet = useWalletUi();

  return (
    <Create
      onCancel={() => router.back()}
      walletAddress={wallet.address}
      onConnectWallet={wallet.openConnect}
      onCreate={async () => { throw notYet; }}
    />
  );
}
