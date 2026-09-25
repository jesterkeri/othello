'use client';

// Top-bar "Search stocks" (handoff-portfolio/StockSearch.tsx, Claude Design). Matches symbol or company
// name ("tesla" finds TSLAx) across the listed xStocks (lib/xstocks.ts). Desktop/tablet: an always-visible
// field. Phone (<760px): an icon that expands to a full-width row. Enter opens the highlighted result,
// arrows move, Esc closes, "/" focuses. A result opens /assets/<symbol> in place, the way the Shell's
// own nav does (window.location), so server-render tests of any page need no Next router.
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { slotFor } from '@/components/assets/slots';
import { REAL_XSTOCKS } from '@/lib/devnet';
import { TRADABLE_XSTOCKS } from '@/lib/xstocks';

import s from './StockSearch.module.css';

type Entry = { symbol: string; name: string; slot: string; cover: boolean };

const COVER = new Set<string>(REAL_XSTOCKS.map((x) => x.symbol));
const INDEX: Entry[] = TRADABLE_XSTOCKS.map((x) => ({ symbol: x.symbol, name: x.name, slot: slotFor(x.symbol), cover: COVER.has(x.symbol) }));

export function matchStocks(list: Entry[], q: string, limit = 6): Entry[] {
  const t = q.trim().toLowerCase();
  if (!t) return [];
  const starts = (e: Entry) => e.symbol.toLowerCase().startsWith(t) || e.name.toLowerCase().startsWith(t);
  return list
    .filter((e) => e.symbol.toLowerCase().includes(t) || e.name.toLowerCase().includes(t))
    .sort((a, b) => Number(starts(b)) - Number(starts(a)))
    .slice(0, limit);
}

const Arrow = () => <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
const Glass = () => <svg viewBox="0 0 24 24" width={19} height={19} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" aria-hidden><path d="M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13M15.4 15.4 20 20" /></svg>;

export default function StockSearch() {
  const [q, setQ] = useState('');
  const [focus, setFocus] = useState(false);
  const [expanded, setExpanded] = useState(false); // phone only
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const results = useMemo(() => matchStocks(INDEX, q), [q]);
  const open = focus && q.trim().length > 0;
  const idx = Math.min(active, Math.max(0, results.length - 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
      if (e.key === '/' && !typing) { e.preventDefault(); setExpanded(true); requestAnimationFrame(() => input.current?.focus()); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (sym: string) => { setQ(''); setFocus(false); setExpanded(false); input.current?.blur(); window.location.assign(`/assets/${sym}`); };
  const close = () => { setQ(''); setFocus(false); setExpanded(false); input.current?.blur(); };

  return (
    <>
      <button type="button" className={s.icon} aria-label="Search stocks" hidden={expanded} onClick={() => { setExpanded(true); requestAnimationFrame(() => input.current?.focus()); }}><Glass /></button>
      <div className={`${s.wrap} ${expanded ? s.expanded : ''}`}>
        <label className={s.field}>
          <Glass />
          <input ref={input} type="search" role="combobox" aria-expanded={open} aria-controls={id} aria-activedescendant={open && results[idx] ? `${id}-${idx}` : undefined}
            aria-label="Search stocks" placeholder="Search stocks, like Tesla or NVDAx" value={q}
            onChange={(e) => { setQ(e.target.value); setActive(0); }} onFocus={() => setFocus(true)} onBlur={() => setTimeout(() => setFocus(false), 120)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(idx + 1, results.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(idx - 1, 0)); }
              else if (e.key === 'Enter' && results[idx]) pick(results[idx].symbol);
              else if (e.key === 'Escape') close();
            }} />
          <span className={s.slash} aria-hidden>/</span>
          {q && <button type="button" className={s.clear} aria-label="Clear search" onMouseDown={(e) => { e.preventDefault(); setQ(''); }}><svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg></button>}
          <button type="button" className={s.cancel} onMouseDown={(e) => { e.preventDefault(); close(); }}>Cancel</button>
        </label>
        {open && (
          <div id={id} role="listbox" aria-label="Stocks" className={s.drop}>
            {results.length > 0 ? (
              <>
                <span className={s.label}>{results.length === 1 ? '1 stock' : `${results.length} stocks`}</span>
                {results.map((r, i) => (
                  <a key={r.symbol} id={`${id}-${i}`} role="option" aria-selected={i === idx} href={`/assets/${r.symbol}`}
                    className={`${s.row} ${i === idx ? s.rowOn : ''}`} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(r.symbol); }}>
                    <span className={s.chip} style={{ background: `var(--${r.slot})`, color: `var(--${r.slot}Ink)` }}>{r.symbol}</span>
                    <span className={s.name}>{r.name}</span>
                    {r.cover && <span className={s.cover}>Circle cover</span>}
                    <Arrow />
                  </a>
                ))}
              </>
            ) : (
              <div className={s.none}><b>No match for &ldquo;{q.trim()}&rdquo;</b><span>Try a symbol like TSLAx or a company name like Tesla.</span></div>
            )}
            <a href="/assets" className={s.browse} onMouseDown={(e) => { e.preventDefault(); close(); window.location.assign('/assets'); }}>Browse all assets<Arrow /></a>
          </div>
        )}
      </div>
    </>
  );
}
