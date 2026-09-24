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
 * With a wallet, the form can be submitted, and `onCreate` refuses with a plain
 * reason. It must be passed: Create treats a missing `onCreate` as success and
 * would show "created" for a circle that does not exist. The create_circle
 * transaction lands when the program is on devnet (T23), and replaces this.
 */
const notYet: CreateError = {
  kind: "program",
  reason: "Creating a circle needs the Othello program on devnet, and it is not deployed yet. Nothing was sent.",
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
