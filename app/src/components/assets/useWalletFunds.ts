"use client";

/** The connected wallet's mainnet USDC and SOL (/api/wallet), re-read on demand after a buy. */
import { useCallback, useEffect, useState } from "react";

import type { WalletFunds } from "@/app/api/wallet/route";

export function useWalletFunds(owner: string | null): { funds: WalletFunds | null; error: string | null; reload: () => void } {
  const [funds, setFunds] = useState<WalletFunds | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    setFunds(null);
    setError(null);
    if (!owner) return;
    let alive = true;
    fetch(`/api/wallet?owner=${encodeURIComponent(owner)}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<WalletFunds | { error: string }>)
      .then((b) => {
        if (!alive) return;
        if ("error" in b) throw new Error(b.error);
        setFunds(b);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [owner, n]);
  return { funds, error, reload };
}
