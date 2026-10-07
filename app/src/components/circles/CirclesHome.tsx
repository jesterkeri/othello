"use client";

/**
 * The shared "Your circles" page body (Joshua 2026-10-06: one frontend for Robinhood and Solana, the same
 * capabilities on both). Each chain's page hands it a CirclesSource (useRobinhoodCircles in
 * components/robinhood/RobinhoodHome.tsx, useSolanaCircles in components/live/SolanaHome.tsx): the wallet, the circles
 * it found as ListCircle, and what is still loading or failed.
 * This file knows no chain: it builds each card (lib/core/circle-card.ts) and draws the board.
 */
import type { ReactNode } from "react";

import s from "@/components/robinhood/Robinhood.module.css";
import { circleCard } from "@/lib/core/circle-card";
import type { ChainSide } from "@/lib/chains";
import type { ListCircle } from "@/lib/core/circle-list";

import cc from "./CircleCard.module.css";
import CirclesBoard, { CirclesTitle } from "./CirclesBoard";

export type CirclesSource = {
  side: ChainSide;
  /** "Robinhood Chain" or "Solana devnet": where the page says it is reading. */
  chainName: string;
  wallet: {
    /** A wallet of this chain's kind is installed. */
    installed: boolean;
    address: string | null;
    connect: () => void;
    connectLabel: string;
    installHint: string;
  };
  /** A chain-specific notice that stops the list (e.g. Robinhood's factory not open yet). */
  blocked: ReactNode | null;
  /** Circles found for this wallet; null until the first answer. */
  found: number | null;
  /** Circles read in full. */
  circles: ListCircle[];
  /** Circles found but still being read. */
  reading: number;
  /** Circles found whose read failed: the card links to the page instead. */
  failed: { address: string; href: string }[];
  /** Reads those circles again (chains that read each circle in the browser). */
  retryFailed?: (() => void) | null;
  /** Finding the circles failed. */
  error: string | null;
  retry: (() => void) | null;
  /** Circles found but not read (a cap): the page says so instead of dropping them silently. */
  notShown?: number;
  /** Older circles exist (Robinhood lists a page at a time). */
  more: { loading: boolean; load: () => void } | null;
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function CirclesHome({ source }: { source: CirclesSource }) {
  const { wallet: w } = source;
  const me = w.address;
  const items = me ? source.circles.map((v) => ({ v, card: circleCard(v, me) })) : [];
  const showBoard = Boolean(me && source.found && source.found > 0 && !source.blocked);
  return (
    <main className={`${s.page} ${cc.wide}`}>
      {/* with circles to show, the board draws the title with its Needs-you pill; until then it stands alone */}
      {!showBoard && <CirclesTitle side={source.side} />}
      {source.blocked}
      <section className={s.section} aria-live="polite">
        {!w.installed && <p className={s.muted}>{w.installHint}</p>}
        {w.installed && !me && (
          <button type="button" className={s.btn} onClick={w.connect}>{w.connectLabel}</button>
        )}
        {me && !source.blocked && source.found === null && !source.error && <p className={s.muted}>Looking for your circles…</p>}
        {source.found === 0 && (
          <p className={s.muted}>This wallet hasn&apos;t started or joined a circle yet. Start one, or open the link someone sent you.</p>
        )}
        {showBoard && me && <CirclesBoard items={items} me={me} side={source.side} unread={source.reading + source.failed.length + (source.notShown ?? 0)} />}
        {source.reading > 0 && (
          <p className={s.muted}>Reading {source.reading === 1 ? "1 circle" : `${source.reading} circles`} on {source.chainName}…</p>
        )}
        {source.notShown ? (
          <p className={s.muted}>
            Showing {source.circles.length + source.failed.length} of {source.circles.length + source.failed.length + source.notShown} circles:
            the ones you have to act in first.
          </p>
        ) : null}
        {source.failed.map((c) => (
          <p key={c.address} className={s.muted}>
            Couldn&apos;t read circle {short(c.address)} just now. <a className={s.addr} href={c.href}>Open it</a>
          </p>
        ))}
        {source.failed.length > 0 && source.retryFailed && (
          <button type="button" className={s.btnQuiet} onClick={source.retryFailed}>Try again</button>
        )}
        {source.error && (
          <p className={s.error} role="alert">
            Couldn&apos;t read your circles: {source.error}{" "}
            {source.retry && <button type="button" className={s.btnQuiet} onClick={source.retry}>Try again</button>}
          </p>
        )}
        {source.more && !source.error && (
          <button type="button" className={s.btnQuiet} disabled={source.more.loading} onClick={source.more.load}>
            {source.more.loading ? "Loading…" : "Show more"}
          </button>
        )}
      </section>
    </main>
  );
}
