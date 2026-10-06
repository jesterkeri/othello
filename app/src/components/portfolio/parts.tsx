/**
 * The pieces the Solana portfolio (Portfolio.tsx) and the Robinhood portfolio (robinhood/RobinhoodPortfolio.tsx) share,
 * so both pages draw the same header, tiles, circle card, asset rows, test-token strip and footer (Joshua, 2026-10-06:
 * the Robinhood page should look and behave like the Solana one). Presentational only: no hooks, no reads. Every
 * figure arrives already formatted by the page that read it.
 */
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import s from "./Portfolio.module.css";

export const Arrow = ({ d = "M7 17 17 7M9 7h8v8" }: { d?: string }) => (
  <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
export const ARROW_RIGHT = "M5 12h14M13 6l6 6-6 6";

/** Title, and once a wallet is connected, the live dot (clay when a read failed) and the read-only note. */
export function PortfolioHeader({ status }: { status: { failed: boolean; live: string } | null }) {
  return (
    <header className={s.head}>
      <h1 className={s.title}>Portfolio</h1>
      {status && (
        <span className={s.readLine}>
          <span className={s.read}><span style={{ background: status.failed ? "var(--clay)" : "var(--teal)" }} />{status.failed ? "A read failed" : status.live}</span>
          <span>Read only. Othello never holds your keys.</span>
        </span>
      )}
    </header>
  );
}

/** The big tile's decoration: a corner wedge and three dashes. */
export const TotalDecor = () => (
  <>
    <span aria-hidden className={s.corner} />
    <span aria-hidden className={s.dashes}><span /><span /><span /></span>
  </>
);

/** The circle card's decoration: two rings. */
export const RingsDecor = () => <span aria-hidden className={s.rings}><span /></span>;

export type Pip = { key: string; title: string; mine: boolean; got: boolean };
export type Fact = { label: string; value: string; title?: string };

/** The circle card's body: round N of M, the seat line, one bar per round, and the fact chips; the whole of it links. */
export function CircleSummary({ href, headline, sub, pips, facts }: { href: string; headline: string; sub: ReactNode; pips: Pip[]; facts: Fact[] }) {
  return (
    <Link href={href} className={s.circleLink}>
      <span className={s.circleTop}>
        <span>
          <b className={s.roundBig}>{headline}</b>
          <span className={s.circleSub}>{sub}</span>
        </span>
        <span className={s.tick}><Arrow /></span>
      </span>
      <span className={s.pips} aria-label="Rounds">
        {pips.map((p) => (
          <span key={p.key} title={p.title}
            style={{ background: p.mine ? "var(--acid)" : p.got ? "var(--teal)" : "transparent", borderStyle: p.got || p.mine ? "solid" : "dashed" }} />
        ))}
      </span>
      <span className={s.facts}>
        {facts.map((f) => (
          <span key={f.label} title={f.title}><span>{f.label}</span>{f.value}</span>
        ))}
      </span>
    </Link>
  );
}

/**
 * One asset row: a badge in the asset's palette slot, its name, the page's own cells, and the arrow. `--slot` colours
 * the hover shadow. `short` is for rows with only a value cell (no tokens-times-multiplier or price cells).
 */
export function AssetRow({ href, slot, symbol, name, short = false, children }: { href: string; slot: string; symbol: string; name: string; short?: boolean; children: ReactNode }) {
  return (
    <Link href={href} className={short ? `${s.row} ${s.rowShort}` : s.row} style={{ "--slot": `var(--${slot})` } as CSSProperties}>
      <span className={s.badge} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)` }} aria-hidden>{symbol.slice(0, 2)}</span>
      <span className={s.name}><b>{symbol}</b><span>{name}</span></span>
      {children}
      <span className={s.arrow}><Arrow /></span>
    </Link>
  );
}

/** The dashed strip for tokens with no real value. */
export function TestTokenStrip({ label, title, tag, children }: { label: string; title: string; tag: string; children: ReactNode }) {
  return (
    <section aria-label={label} className={s.demo}>
      <span className={s.demoHead}><b>{title}</b><span className={s.tagDashed}>{tag}</span></span>
      {children}
    </section>
  );
}

export function PortfolioFooter({ children, href, link }: { children: ReactNode; href: string; link: string }) {
  return (
    <footer className={s.foot}>
      <span>{children}</span>
      <Link href={href}>{link}</Link>
    </footer>
  );
}
