"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { ConnectGate, SETTLE_MS } from "@/components/othello/SideGate";
import { useActiveSide } from "@/lib/active-side";
import { hrefFor } from "@/lib/nav";

/** The neutral way into circles: with a wallet, that chain's circles; with none, a request to connect one. */
export default function CirclesPage() {
  const { side } = useActiveSide();
  const router = useRouter();
  useEffect(() => {
    if (!side) return;
    const t = setTimeout(() => router.replace(hrefFor("Circles", side)), SETTLE_MS);
    return () => clearTimeout(t);
  }, [side, router]);
  return <ConnectGate label="Circles" />;
}
