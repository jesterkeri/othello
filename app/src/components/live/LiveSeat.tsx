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
import { DEMO_CIRCLE, liveCircleUrl, liveKeyOf } from "@/lib/devnet";
import type { LiveCircle } from "@/lib/live";

/** `address`: any Othello circle (default the demo; Joshua 2026-10-06, circles opened from the shared list). */
export default function LiveSeat({ kind, seat, address = DEMO_CIRCLE }: { kind: "position" | "join"; seat: number; address?: string }) {
  const [live, setLive] = useState<LiveCircle | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(liveCircleUrl(address), { cache: "no-store" })
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
  }, [address]);

  if (!live) {
    return (
      <Shell active="Circles">
        <div className={s.frame}>
          <div className={s.banners} style={{ padding: 24 }}>
            <p className={s.panelNote}>{error ? `Live data unavailable: ${error}` : `Reading the ${address === DEMO_CIRCLE ? "demo " : ""}circle from devnet…`}</p>
          </div>
        </div>
      </Shell>
    );
  }

  const c = live.view;
  if (seat > c.n) {
    return (
      <Shell active="Circles">
        <div className={s.frame}>
          <div className={s.banners} style={{ padding: 24 }}>
            <p className={s.panelNote}>This circle has {c.n} seats; there is no seat {seat}.</p>
          </div>
        </div>
      </Shell>
    );
  }
  const lock = c.members[seat - 1]?.lockedRaw || c.members.find((m) => m.lockedRaw > 0)?.lockedRaw || 0;
  return kind === "position" ? (
    <Position circle={c} seat={seat} now={live.readAt} stateKey={liveKeyOf(address)} usdcWord="test USDC" />
  ) : (
    <Join circle={c} seat={seat} now={live.readAt} stateKey={liveKeyOf(address)} usdcWord="test USDC" suggestedLockRaw={lock} />
  );
}
