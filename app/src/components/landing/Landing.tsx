'use client';

import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import s from './Landing.module.css';
import { applyThemeToDocument } from '@/lib/applyTheme';
import { hrefFor } from '@/lib/nav';
import { WalletControl } from '@/components/othello/WalletConnect';
import {
  PALETTES, SLOT_LABELS, customToProfile, hsl, huesFor, huesFromBase, innerVars, loadTheme, preview, saveTheme, themeVars,
  type CustomProfile, type Profile, type ThemeMode,
} from '@/lib/theme';

// Every product string is design/FLOWS.md §8 (Landing) verbatim, or §1/§10. Do not rewrite copy here.

export type LandingState = 'ready' | 'loading' | 'resetting';

export type LandingProps = {
  state?: LandingState;
  walletConnected?: boolean;
  onOpenDemo?: () => void;
  onCreateCircle?: () => void;
  onConnectWallet?: () => void;
  onRetry?: () => void;
};

const NAV = ['Home', 'Circles', 'xStocks', 'Split lab', 'How it works'];
const TABS = ['Pay in', 'Get the pot', 'If someone stops'];
const PHRASES = ['Nobody has to trust anybody', 'You still own it', 'You get it back when the circle ends', 'Locked stock pays for anyone who stops'];
const TAPE_HUES = ['var(--clay)', 'var(--acid)', 'var(--teal)', 'var(--cream)'];
const SWATCH_HUES = [8, 26, 44, 66, 96, 140, 168, 192, 212, 236, 268, 302];

const STEPS = [
  { tag: 'Every round', text: 'Everyone pays in every round', slot: 'clay' },
  { tag: 'In turn', text: 'Each member receives the whole pot once, in turn', slot: 'acid' },
  { tag: 'The promise', text: 'Locked stock pays for anyone who stops', slot: 'sky' },
] as const;

function tiltMove(e: MouseEvent<HTMLElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width - 0.5;
  const py = (e.clientY - r.top) / r.height - 0.5;
  el.style.zIndex = '30';
  el.style.transform = `perspective(620px) rotateY(${(px * 20).toFixed(2)}deg) rotateX(${(-py * 20).toFixed(2)}deg) translate3d(${(px * -16).toFixed(1)}px,${(py * -16).toFixed(1)}px,0) scale(1.06)`;
}

function tiltLeave(e: MouseEvent<HTMLElement>) {
  const el = e.currentTarget;
  el.style.transition = 'transform .42s cubic-bezier(.2,1.5,.35,1), box-shadow .18s';
  el.style.transform = '';
  window.setTimeout(() => { el.style.transition = ''; el.style.zIndex = ''; }, 420);
}

const tilt = { onMouseMove: tiltMove, onMouseLeave: tiltLeave };

function Arrow({ size = 17 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={3.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6.5 17.5 17.5 6.5" /><path d="M9 6.5h8.5V15" />
    </svg>
  );
}

function StepIcon({ i }: { i: number }) {
  const common = { viewBox: '0 0 24 24', width: 27, height: 27, fill: 'none', stroke: 'var(--ink)', strokeWidth: 2.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (i === 0) return <svg {...common}><path d="M12 3v10.5" /><path d="M8 10l4 4 4-4" /><path d="M3.5 16.5v2A2.5 2.5 0 0 0 6 21h12a2.5 2.5 0 0 0 2.5-2.5v-2" /></svg>;
  if (i === 1) return <svg {...common}><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" /><path d="M20.5 3.5V9h-5.4" /><circle cx={12} cy={12} r={2.6} fill="var(--ink)" stroke="none" /></svg>;
  return <svg {...common}><path d="M4 13.1a2.6 2.6 0 0 1 2.6-2.6h10.8a2.6 2.6 0 0 1 2.6 2.6v5.3a2.6 2.6 0 0 1-2.6 2.6H6.6A2.6 2.6 0 0 1 4 18.4z" /><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" /><circle cx={12} cy={15.7} r={1.5} fill="var(--ink)" stroke="none" /></svg>;
}

function Motif({ i }: { i: number }) {
  if (i === 0) return <span className={s.motifQuarter} />;
  if (i === 1) return <span className={s.motifBars}>{[34, 52, 70].map((w) => <span key={w} style={{ width: w }} />)}</span>;
  return <span className={s.motifRings} />;
}

function Thumb({ p, dark }: { p: Profile; dark: boolean }) {
  const pv = preview(p, dark);
  return (
    <span className={s.thumb} style={{ background: pv.desk }}>
      <span className={s.thumbRow}>
        <span className={s.thumbTile} style={{ background: pv.tile }} />
        <span className={s.thumbTileAlt} style={{ background: pv.tileAlt }} />
      </span>
      <span className={s.thumbBtn} style={{ background: pv.btn }} />
    </span>
  );
}

export default function Landing({ state = 'ready', walletConnected = false, onOpenDemo, onCreateCircle, onConnectWallet, onRetry }: LandingProps) {
  const [mode, setMode] = useState<ThemeMode>('light');
  const [choice, setChoice] = useState('r0');
  const [custom, setCustom] = useState<CustomProfile[]>([]);
  const [hydrated, setHydrated] = useState(false);

  const [tab, setTab] = useState(0);
  const [panel, setPanel] = useState(false);
  const [builder, setBuilder] = useState(false);
  const [draft, setDraft] = useState<string[]>(() => huesFromBase(210));
  const [draftSlot, setDraftSlot] = useState(0);
  const [draftName, setDraftName] = useState('');
  const [renaming, setRenaming] = useState(-1);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    const saved = loadTheme();
    if (saved) {
      setChoice(saved.choice);
      setCustom(saved.custom);
      setMode(saved.theme ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) saveTheme({ choice, theme: mode, custom });
  }, [hydrated, choice, mode, custom]);

  const dark = mode === 'dark';
  const mine = useMemo(() => custom.map(customToProfile), [custom]);
  const active: Profile = choice.startsWith('c') ? mine[Number(choice.slice(1))] ?? PALETTES[0]! : PALETTES[Number(choice.slice(1))] ?? PALETTES[0]!;
  const vars = useMemo(() => themeVars(active, dark), [active, dark]);
  // The wallet pill and its menu are the inner pages' control, drawn with the
  // inner-page tokens, which Landing's own theme does not define.
  const walletVars = useMemo(() => ({ display: 'contents', ...innerVars(active, dark) }) as CSSProperties, [active, dark]);

  // body and the overscroll area are outside this component's root element, so
  // they need the same variables or dark mode leaves a light strip behind the
  // frame at both ends of the page.
  useEffect(() => {
    applyThemeToDocument(vars, mode);
  }, [vars, mode]);

  const draftHues = huesFor({ dark: draft }, dark);
  const draftDesk = preview({ brand: draft[2]!, dark: draft }, dark).desk;

  const ticker = useMemo(() => Array.from({ length: 4 }).flatMap(() => PHRASES), []);
  const tickerB = useMemo(() => Array.from({ length: 4 }).flatMap(() => [...PHRASES].reverse()), []);

  const loading = state === 'loading';
  const resetting = state === 'resetting';
  const primaryLabel = loading ? 'Opening demo circle' : 'Open demo circle';
  const secondaryNote = walletConnected
    ? 'Creating a circle: you name every member and the order they get paid. 3 to 8 members.'
    : 'Creating a circle needs a wallet. You name every member and the order they get paid. 3 to 8 members.';

  function pick(next: string) { setChoice(next); setPanel(false); }

  function saveProfile() {
    const name = draftName.trim() || `Profile ${custom.length + 1}`;
    const next = [...custom, { name, hues: draft }];
    setCustom(next);
    setChoice(`c${next.length - 1}`);
    setBuilder(false);
    setPanel(false);
    setDraftName('');
  }

  function removeProfile(i: number) {
    const next = custom.filter((_, k) => k !== i);
    setCustom(next);
    if (choice === `c${i}`) setChoice('r0');
    else if (choice.startsWith('c') && Number(choice.slice(1)) > i) setChoice(`c${Number(choice.slice(1)) - 1}`);
  }

  function commitRename() {
    if (renaming < 0) return;
    setCustom(custom.map((c, k) => (k === renaming ? { ...c, name: renameValue.trim() || c.name } : c)));
    setRenaming(-1);
    setRenameValue('');
  }

  return (
    <div className={s.root} data-theme={mode} style={vars as CSSProperties}>
      <div className={s.frame}>

        <header className={s.nav}>
          <span className={s.logo} aria-label="Othello">O</span>
          <nav className={s.pillGroup} aria-label="Main">
            {NAV.map((label, i) => (
              <a
                key={label}
                href={hrefFor(label)}
                className={`${s.navItem} ${i === 0 ? s.navItemActive : ''}`}
                aria-current={i === 0 ? 'page' : undefined}
              >
                {label}
              </a>
            ))}
          </nav>
          <div className={s.navActions}>
            <button className={s.iconBtn} onClick={() => setPanel(!panel)} aria-label="Colours and mode" aria-expanded={panel}>
              <svg viewBox="0 0 24 24" width={24} height={24} fill="none" aria-hidden>
                <path d="M12 3.4c-4.8 0-8.7 3.8-8.7 8.5s3.9 8.5 8.7 8.5c1.4 0 2.1-.8 2.1-1.8 0-1.6 1.1-2.4 2.5-2.4h1.3c2 0 3.5-1.6 3.5-3.6 0-5.2-4.1-9.2-9.4-9.2Z" stroke="var(--ink)" strokeWidth={2.1} strokeLinejoin="round" />
                <circle cx={8.3} cy={9.4} r={1.35} fill="var(--acid)" stroke="var(--ink)" strokeWidth={1.1} />
                <circle cx={12} cy={7.6} r={1.35} fill="var(--sky)" stroke="var(--ink)" strokeWidth={1.1} />
                <circle cx={15.6} cy={9.8} r={1.35} fill="var(--clay)" stroke="var(--ink)" strokeWidth={1.1} />
                <circle cx={7.9} cy={13.6} r={1.35} fill="var(--teal)" stroke="var(--ink)" strokeWidth={1.1} />
              </svg>
            </button>

            {panel && (
              <div className={s.panel} role="dialog" aria-label="Colours and mode">
                <span className={s.panelLabel}>Recommended</span>
                <div className={s.list}>
                  {PALETTES.map((p, i) => (
                    <button key={p.name} className={`${s.profileRow} ${choice === `r${i}` ? s.profileRowOn : ''}`} onClick={() => pick(`r${i}`)}>
                      <Thumb p={p} dark={dark} />
                      <span className={s.profileText}><span className={s.profileName}>{p.name}</span><span className={s.profileNote}>{p.note}</span></span>
                    </button>
                  ))}
                </div>

                {mine.length > 0 && (
                  <>
                    <span className={s.panelLabel}>Your profiles</span>
                    <div className={s.list}>
                      {mine.map((p, i) => (
                        <div key={i} role="button" tabIndex={0} className={`${s.profileRow} ${choice === `c${i}` ? s.profileRowOn : ''}`} onClick={() => pick(`c${i}`)} onKeyDown={(e) => e.key === 'Enter' && pick(`c${i}`)}>
                          <Thumb p={p} dark={dark} />
                          <span className={s.profileText}><span className={s.profileName}>{p.name}</span><span className={s.profileNote}>{p.note}</span></span>
                          <button className={s.miniBtn} title="Rename" aria-label={`Rename ${p.name}`} onClick={(e) => { e.stopPropagation(); setRenaming(i); setRenameValue(p.name); setBuilder(false); }}>
                            <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 20h4L20 8l-4-4L4 16z" /></svg>
                          </button>
                          <button className={`${s.miniBtn} ${s.miniBtnDanger}`} aria-label={`Delete ${p.name}`} onClick={(e) => { e.stopPropagation(); removeProfile(i); }}>&times;</button>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {renaming > -1 && (
                  <div className={s.box}>
                    <span className={s.panelLabel}>Rename profile</span>
                    <input className={s.input} value={renameValue} onChange={(e) => setRenameValue(e.target.value)} />
                    <div className={s.row}>
                      <button className={s.btnGhost} onClick={() => { setRenaming(-1); setRenameValue(''); }}>Cancel</button>
                      <button className={s.btnSolid} onClick={commitRename}>Save name</button>
                    </div>
                  </div>
                )}

                <button className={s.btnDashed} onClick={() => setBuilder(!builder)}>{builder ? 'Close' : '+ New profile'}</button>

                {builder && (
                  <div className={s.box}>
                    <span className={s.panelLabel}>Which colour</span>
                    <div className={s.slotTabs}>
                      {SLOT_LABELS.map((label, i) => (
                        <button key={label} className={`${s.slotTab} ${draftSlot === i ? s.slotTabOn : ''}`} onClick={() => setDraftSlot(i)}>
                          <span className={s.dot14} style={{ background: draftHues[i] }} />{label}
                        </button>
                      ))}
                    </div>
                    <span className={s.panelLabel}>{draftSlot === 2 ? 'Deep fill, carries light text' : 'Pick a colour for this role'}</span>
                    <div className={s.swatches}>
                      {SWATCH_HUES.map((h) => {
                        const deep = draftSlot === 2;
                        const c = hsl(h, deep ? 0.8 : 0.72, deep ? 0.34 : 0.55);
                        return (
                          <button key={h} aria-label={`Hue ${h}`} className={`${s.swatch} ${draft[draftSlot] === c ? s.swatchOn : ''}`} style={{ background: c }}
                            onClick={() => setDraft(draft.map((d, k) => (k === draftSlot ? c : d)))} />
                        );
                      })}
                    </div>
                    <span className={s.draftPreview} style={{ background: draftDesk }}>
                      <span className={s.draftRow}>
                        <span style={{ flex: '1 1 0', background: draftHues[0] }} />
                        <span style={{ flex: '0 0 32px', background: draftHues[1] }} />
                        <span style={{ flex: '0 0 22px', background: draftHues[2] }} />
                      </span>
                      <span className={s.thumbBtn} style={{ width: '62%', height: 13, background: draftHues[4] }} />
                    </span>
                    <input className={s.input} value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Name this profile" />
                    <div className={s.row}>
                      <button className={s.btnGhost} onClick={() => setDraft(huesFromBase(Math.round(Math.random() * 359)))}>Surprise me</button>
                      <button className={s.btnSolid} onClick={saveProfile}>Save profile</button>
                    </div>
                  </div>
                )}

                <span className={s.panelLabel}>Mode</span>
                <div className={s.modeGroup}>
                  {(['light', 'dark'] as const).map((m) => (
                    <button key={m} className={`${s.modeBtn} ${mode === m ? s.modeBtnOn : ''}`} onClick={() => { setMode(m); setPanel(false); }}>{m === 'light' ? 'Light' : 'Dark'}</button>
                  ))}
                </div>
              </div>
            )}

            {/* Connected: the shared address pill, whose menu is where you
                disconnect. A plain "Connected" label here left no way out. */}
            {walletConnected
              ? <span style={walletVars}><WalletControl /></span>
              : <button className={s.connect} onClick={onConnectWallet}>Connect wallet</button>}
          </div>
        </header>

        <div className={s.devnet}>
          <span className={s.devnetPill}>
            <span className={s.dotRun}>{Array.from({ length: 6 }).map((_, i) => <span key={i} />)}</span>
            <span className={s.micro}>Devnet demo</span>
          </span>
          <p className={s.devnetText}>The demo trades labelled mirrors of these shares, not the real xStocks.</p>
        </div>

        <section className={s.hero}>
          <span className={`${s.deco} ${s.decoDisc}`} />
          <span className={`${s.deco} ${s.decoPill}`} />
          <svg viewBox="0 0 80 40" className={`${s.deco} ${s.decoSquiggle}`} fill="none" stroke="var(--clay)" strokeWidth={5} strokeLinecap="round" aria-hidden>
            <path d="M5 28c8-16 14 12 22-4s14 14 22-2 10 8 14 2" />
          </svg>
          <svg viewBox="0 0 60 60" className={`${s.deco} ${s.decoSpiral}`} fill="none" stroke="var(--grey)" strokeWidth={5} strokeLinecap="round" aria-hidden>
            <path d="M30 8c12 0 22 10 22 22s-10 22-22 22S8 42 8 30c0-8 6-14 14-14s12 6 12 12-4 9-8 9" />
          </svg>

          <span className={s.eyebrowRow}>
            <span className={s.chips} aria-hidden>
              <span style={{ background: 'var(--clay)', transform: 'rotate(-12deg)' }} />
              <span style={{ background: 'var(--acid)', transform: 'rotate(8deg)' }} />
              <span style={{ background: 'var(--sky)', transform: 'rotate(-5deg)' }} />
            </span>
            <span className={s.eyebrow}>Tokenised stock as a promise</span>
          </span>

          <h1 className={s.h1}>Savings circles where nobody has to trust anybody</h1>
          <p className={s.lede}>Lock tokenized stock as a promise. You still own it. You get it back when the circle ends.</p>

          {resetting ? (
            <div className={s.reset} role="status">
              <span className={s.micro}>Demo is being reset</span>
              <p>The demo circle is not there right now. Nothing is wrong with your wallet.</p>
              <button className={s.retry} onClick={onRetry}>Try again</button>
            </div>
          ) : (
            <div className={s.actions}>
              <div className={s.actionRow}>
                <button className={s.primary} onClick={onOpenDemo} disabled={loading} aria-busy={loading}>
                  <span>{primaryLabel}</span><Arrow />
                </button>
                <button className={s.secondary} onClick={onCreateCircle}>Create a circle</button>
              </div>
              <span className={s.sticker}>One click, no wallet, nothing to sign</span>
              <p className={s.note}>{secondaryNote}</p>
            </div>
          )}
        </section>

        <div className={s.tabsWrap}>
          <div className={s.tabs} role="tablist">
            {TABS.map((label, i) => (
              <button key={label} role="tab" aria-selected={i === tab} className={`${s.tab} ${i === tab ? s.tabOn : ''}`} onClick={() => setTab(i)}>{label}</button>
            ))}
          </div>
        </div>

        <div className={s.stepsGrid}>
          {STEPS.map((st, i) => (
            <div key={st.tag} className={s.stepWrap} style={{ animationDelay: `${0.1 + i * 0.11}s` }}>
              <div {...tilt} className={`${s.step} ${s.tilt} ${s.sheen} ${s.sheenHover} ${i === tab ? s.stepOn : ''}`}
                style={{ backgroundColor: `var(--${st.slot})`, color: `var(--${st.slot}Ink)` }}>
                <Motif i={i} />
                <div className={s.stepHead}>
                  <span className={`${s.badge} ${i === tab ? s.badgeTick : ''}`}><StepIcon i={i} /></span>
                  <span className={s.tagRow}>
                    <span className={s.tag}>{st.tag}</span>
                    <span className={s.matrix} aria-hidden>
                      {Array.from({ length: 9 }).map((_, k) => <span key={k} style={{ background: k <= i ? 'currentColor' : 'transparent' }} />)}
                    </span>
                  </span>
                </div>
                <span className={`${s.display} ${s.stepTitle}`}>{st.text}</span>
              </div>
            </div>
          ))}
        </div>

        <div className={s.tapes} aria-hidden>
          <div className={`${s.tape} ${s.tapeA}`}>
            <div className={`${s.track} ${s.trackA}`}>
              {ticker.map((t, i) => (
                <span key={i} style={{ display: 'contents' }}>
                  <span className={`${s.display} ${s.tapeText}`} style={{ color: TAPE_HUES[i % 4] }}>{t}</span>
                  <span className={`${s.display} ${s.tapeText} ${s.sep}`}>{'\u25C6'}</span>
                </span>
              ))}
            </div>
          </div>
          <div className={`${s.tape} ${s.tapeB}`}>
            <div className={`${s.track} ${s.trackB}`}>
              {tickerB.map((t, i) => (
                <span key={i} style={{ display: 'contents' }}>
                  <span className={`${s.display} ${s.tapeText}`}>{t}</span>
                  <span className={`${s.display} ${s.tapeText}`}>{'\u25C6'}</span>
                </span>
              ))}
            </div>
          </div>
        </div>

        <section className={s.bento}>
          <div className={s.bentoRow}>
            <div {...tilt} className={`${s.card} ${s.tilt} ${s.problem}`}>
              <span className={s.problemRing} />
              <span className={s.problemMatrix} aria-hidden>
                {Array.from({ length: 9 }).map((_, k) => <span key={k} className={[0, 1, 3, 4].includes(k) ? s.lit : ''} />)}
              </span>
              <span className={s.outlineTag}>The problem</span>
              <p className={`${s.display} ${s.problemTitle}`}>Today the only protection is <em>reputation</em></p>
              <p className={s.problemBody}>Circles break when an early recipient takes the pot and stops paying. Othello makes the promise checkable instead.</p>
            </div>

            <div {...tilt} className={`${s.card} ${s.tilt} ${s.round}`}>
              <span className={s.plus} aria-hidden>
                <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth={3.4} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={3.6} strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
              </span>
              <div className={s.roundHead}>
                <span className={s.micro}>This round</span>
                <span className={s.rangePill}>
                  <span className={s.rangeDots} aria-hidden>{Array.from({ length: 8 }).map((_, k) => <span key={k} />)}</span>
                  3 to 8 seats
                </span>
              </div>
              <div className={s.seatLine}>
                <span className={`${s.display} ${s.seatBig}`}>3</span>
                <span className={s.seatText}>Seat 3 gets the whole pot</span>
              </div>
              <div className={s.seats}>
                {[1, 2, 3, 4, 5, 6].map((n) => <span key={n} className={`${s.seat} ${n === 3 ? s.seatOn : ''}`}>{n}</span>)}
              </div>
              <p className={s.roundNote}>Everyone else pays in. Each seat gets the pot once, then the order comes back around.</p>
            </div>
          </div>

          <div className={s.bentoRow}>
            <div {...tilt} className={`${s.card} ${s.tilt} ${s.sheen} ${s.sheenHover} ${s.ajo}`}>
              <span className={s.ajoSquare} />
              <p className={s.ajoText}>It&apos;s an ajo where everyone locks some stock as a promise, so if someone takes the pot and disappears, their stock pays for them.</p>
              {!resetting && (
                <button className={s.ajoBtn} onClick={onOpenDemo} disabled={loading}>
                  <span>{primaryLabel}</span><Arrow size={16} />
                </button>
              )}
            </div>

            <div {...tilt} className={`${s.card} ${s.tilt} ${s.sheen} ${s.sheenHover} ${s.check}`}>
              <span className={`${s.checkRing} ${s.checkRingA}`} />
              <span className={`${s.checkRing} ${s.checkRingB}`} />
              <span className={s.checkBadge}>
                <svg viewBox="0 0 24 24" width={25} height={25} fill="none" stroke="#0B0B0B" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 12.5l5 5L20 6.5" /></svg>
              </span>
              <p className={s.checkText}>Every member can check at any moment that each obligation is covered.</p>
            </div>
          </div>
        </section>

      </div>
    </div>
  );
}
