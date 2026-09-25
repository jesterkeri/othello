"use client";

/**
 * T18: the Position and Join screens for the LIVE demo circle (/circle/demo/position/N and
 * /circle/demo/join/N). Same components the fixtures use, fed the chain's circle from
 * /api/circle, with test USDC wording. Before, these URLs showed a fixture circle with other
 * members, which contradicted the live one a judge had just clicked through from.
 */
import { useEffect, useState } from "react";

import s from "@/components/circle/Circle.module.css";
import Join from "@/components/join/Join";
import Position from "@/components/position/Position";
import Shell from "@/components/othello/Shell";
import type { LiveCircle } from "@/lib/live";

export default function LiveSeat({ kind, seat }: { kind: "position" | "join"; seat: number }) {
  const [live, setLive] = useState<LiveCircle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/circle", { cache: "no-store" })
      .then((r) => r.json() as Promise<LiveCircle | { error: string }>)
      .then((b) => {
        if (!alive) return;
        if ("error" in b) throw new Error(b.error);
        setLive(b);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  if (!live) {
    return (
      <Shell active="Circles">
        <div className={s.frame}>
          <div className={s.banners} style={{ padding: 24 }}>
            <p className={s.panelNote}>{error ? `Live data unavailable: ${error}` : "Reading the demo circle from devnet…"}</p>
          </div>
        </div>
      </Shell>
    );
  }

  const c = live.view;
  const lock = c.members[seat - 1]?.lockedRaw || c.members.find((m) => m.lockedRaw > 0)?.lockedRaw || 0;
  return kind === "position" ? (
    <Position circle={c} seat={seat} now={live.readAt} stateKey="demo" usdcWord="test USDC" />
  ) : (
    <Join circle={c} seat={seat} now={live.readAt} stateKey="demo" usdcWord="test USDC" suggestedLockRaw={lock} />
  );
}
