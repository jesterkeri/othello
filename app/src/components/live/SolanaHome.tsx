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
  const [found, setFound] = useState<LiveCircle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // each request carries the wallet it was for; a reply for an earlier wallet (or an unmounted page) is dropped
  const req = useRef(0);

  const load = useCallback((address: string) => {
    const id = ++req.current;
    setError(null);
    fetch(`/api/circles?wallet=${address}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<{ circles: LiveCircle[] } | { error: string }>)
      .then((b) => {
        if (id !== req.current) return;
        if ("error" in b) throw new Error(b.error);
        setFound(b.circles);
      })
      .catch((e: unknown) => id === req.current && setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    req.current += 1;
    setFound(null);
    setError(null);
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
    found: found ? found.length : null,
    circles: (found ?? []).map((c) => solToList(c, me)),
    reading: 0,
    failed: [],
    error,
    retry: me ? () => load(me) : null,
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
