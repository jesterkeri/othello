"use client";

/**
 * Solana circles the connected wallet created or holds a seat in, on the shared circles page
 * (components/circles/CirclesHome.tsx; Joshua 2026-10-06, one frontend for both chains). The server finds and reads
 * them (/api/circles: a scan of the program's circle accounts on devnet); each is shown as a ListCircle (solToList).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";

import CirclesHome, { type CirclesSource } from "@/components/circles/CirclesHome";
import Shell from "@/components/othello/Shell";
import type { LiveCircle } from "@/lib/live";
import { solToList } from "@/lib/to-list-solana";
import { useWalletUi } from "@/lib/wallet";

export function useSolanaCircles(): CirclesSource {
  const wallet = useWallet();
  const connectUi = useWalletUi();
  const me = wallet.publicKey?.toBase58() ?? null;
  // the answer carries the wallet it is for: after a switch, a list read for the last wallet is never shown, not even
  // for the one render before the reset below runs (adversary on 3e5d468)
  const [answer, setAnswer] = useState<{ wallet: string; circles: LiveCircle[]; failed: string[]; total: number } | null>(null);
  const found = answer && answer.wallet === me ? answer : null;
  // like the answer, an error belongs to the wallet it was for
  const [failure, setFailure] = useState<{ wallet: string; message: string } | null>(null);
  const error = failure && failure.wallet === me ? failure.message : null;
  // each request carries the wallet it was for; a reply for an earlier wallet (or an unmounted page) is dropped
  const req = useRef(0);

  const load = useCallback((address: string) => {
    const id = ++req.current;
    setFailure(null);
    fetch(`/api/circles?wallet=${address}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<{ circles: LiveCircle[]; failed: string[]; total: number } | { error: string }>)
      .then((b) => {
        if (id !== req.current) return;
        if ("error" in b) throw new Error(b.error);
        setAnswer({ wallet: address, ...b });
      })
      .catch((e: unknown) => id === req.current && setFailure({ wallet: address, message: e instanceof Error ? e.message : String(e) }));
  }, []);

  useEffect(() => {
    req.current += 1;
    setAnswer(null);
    setFailure(null);
    if (me) load(me);
    return () => {
      req.current += 1;
    };
  }, [me, load]);

  return {
    side: "solana",
    chainName: "Solana devnet",
    wallet: {
      installed: wallet.wallets.some((x) => x.readyState === "Installed"),
      address: me,
      connect: connectUi.openConnect,
      connectLabel: "Connect a Solana wallet",
      installHint: "Install Phantom or another Solana wallet to see your circles.",
    },
    blocked: null,
    found: found ? found.total : null,
    circles: (found?.circles ?? []).map((c) => solToList(c, me)),
    notShown: found ? found.total - found.circles.length - found.failed.length : 0,
    reading: 0,
    failed: (found?.failed ?? []).map((address) => ({ address, href: `/circle/sol:${address}` })),
    error,
    retry: me ? () => load(me) : null,
    // a circle the server could not read is read again with the whole list (the server reads every circle)
    retryFailed: me ? () => load(me) : null,
    more: null,
  };
}

export default function SolanaHome() {
  const source = useSolanaCircles();
  return (
    <Shell active="Circles" side="solana">
      <CirclesHome source={source} />
    </Shell>
  );
}
