'use client';

// Frame, icon rail, devnet strip and colours menu shared by Create and 404.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import s from './Shell.module.css';
import { PALETTES, customToProfile, innerVars, loadTheme, saveTheme, type CustomProfile, type Profile, type ThemeMode } from '@/lib/theme';

const NAV = [
  { label: 'Home', d: 'M4 11 12 4l8 7M6 9.5V20h12V9.5M10 20v-5h4v5' },
  { label: 'Circles', d: 'M12 2.8a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0-4.4M18.5 9.8a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0-4.4M12 16.8a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0-4.4M5.5 9.8a2.2 2.2 0 1 1 0 4.4a2.2 2.2 0 1 1 0-4.4M14 6.4l3 3.4M17 14.2l-3 3.4M10 17.6l-3-3.4M7 9.8l3-3.4' },
  { label: 'Split lab', d: 'M9.5 3.5h5M10.5 3.5v5.2L5 18.3A1.5 1.5 0 0 0 6.3 20.5h11.4a1.5 1.5 0 0 0 1.3-2.2L13.5 8.7V3.5M7.6 14h8.8' },
  { label: 'How it works', d: 'M12 3.5a8.5 8.5 0 1 1 0 17a8.5 8.5 0 1 1 0-17M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5v.4M12 16.6v.6' },
] as const;

export type ShellProps = {
  active?: (typeof NAV)[number]['label'] | null;
  walletAddress?: string | null;
  onConnectWallet?: () => void;
  onNavigate?: (label: string) => void;
  children: ReactNode;
};

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>('dark');
  const [choice, setChoice] = useState('r1');
  const [custom, setCustom] = useState<CustomProfile[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = loadTheme();
    if (t) { setChoice(t.choice || 'r1'); setMode(t.theme ?? 'dark'); setCustom(t.custom || []); }
    setReady(true);
  }, []);
  useEffect(() => { if (ready) saveTheme({ choice, theme: mode, custom }); }, [ready, choice, mode, custom]);
  const mine = useMemo(() => custom.map(customToProfile), [custom]);
  const profile: Profile = choice.startsWith('c') ? (mine[Number(choice.slice(1))] ?? PALETTES[1]!) : (PALETTES[Number(choice.slice(1))] ?? PALETTES[1]!);
  const vars = useMemo(() => innerVars(profile, mode === 'dark'), [profile, mode]) as CSSProperties;
  return { mode, setMode, choice, setChoice, mine, vars };
}

export default function Shell({ active = 'Circles', walletAddress, onConnectWallet, onNavigate, children }: ShellProps) {
  const t = useTheme();
  const [menu, setMenu] = useState(false);
  useEffect(() => { document.body.style.background = String((t.vars as Record<string, string>)['--desk']); }, [t.vars]);

  return (
    <div className={s.root} style={t.vars}>
      <div className={s.frame}>
        <aside className={s.rail}>
          <span className={s.logo} aria-label="Othello">O</span>
          <nav className={s.railNav} aria-label="Main">
            {NAV.map((n) => (
              <button key={n.label} type="button" aria-label={n.label} title={n.label} aria-current={n.label === active ? 'page' : undefined}
                className={`${s.railBtn} ${n.label === active ? s.railOn : ''}`} onClick={() => onNavigate?.(n.label)}>
                <svg viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor" strokeWidth={2.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={n.d} /></svg>
              </button>
            ))}
          </nav>
        </aside>

        <main className={s.panel}>
          <div className={s.topbar}>
            <span className={s.devnet}><span className={s.dots} aria-hidden>{Array.from({ length: 6 }).map((_, i) => <span key={i} />)}</span>Devnet demo</span>
            <p className={s.devnetText}>The demo trades labelled mirrors of these shares, not the real xStocks.</p>
            <span className={s.actions}>
              <button type="button" className={s.palette} aria-label="Colours and mode" aria-expanded={menu} onClick={() => setMenu(!menu)}>
                <svg viewBox="0 0 24 24" width={22} height={22} fill="none" aria-hidden><path d="M12 3.4c-4.8 0-8.7 3.8-8.7 8.5s3.9 8.5 8.7 8.5c1.4 0 2.1-.8 2.1-1.8 0-1.6 1.1-2.4 2.5-2.4h1.3c2 0 3.5-1.6 3.5-3.6 0-5.2-4.1-9.2-9.4-9.2Z" stroke="currentColor" strokeWidth={2.1} strokeLinejoin="round" /><circle cx={8.3} cy={9.4} r={1.35} fill="var(--acid)" /><circle cx={12} cy={7.6} r={1.35} fill="var(--sky)" /><circle cx={15.6} cy={9.8} r={1.35} fill="var(--clay)" /><circle cx={7.9} cy={13.6} r={1.35} fill="var(--teal)" /></svg>
              </button>
              {menu && (
                <div className={s.menu} role="dialog" aria-label="Colours and mode">
                  <span className={s.menuLabel}>Recommended</span>
                  {[...PALETTES.map((p, i) => ({ p, key: `r${i}` })), ...t.mine.map((p, i) => ({ p, key: `c${i}` }))].map(({ p, key }) => (
                    <button key={key} type="button" className={`${s.profile} ${t.choice === key ? s.profileOn : ''}`} aria-pressed={t.choice === key} onClick={() => { t.setChoice(key); setMenu(false); }}>
                      <span className={s.thumb} style={{ background: String(innerVars(p, t.mode === 'dark')['--desk']) }}>
                        <span className={s.thumbRow}><span style={{ background: p.dark[0] }} /><span style={{ background: p.dark[1] }} /></span>
                        <span className={s.thumbBtn} style={{ background: p.dark[4] }} />
                      </span>
                      <span className={s.profileText}><b>{p.name}</b><small>{p.note}</small></span>
                    </button>
                  ))}
                  <span className={s.menuLabel}>Mode</span>
                  <div className={s.modes}>
                    {(['light', 'dark'] as const).map((m) => (
                      <button key={m} type="button" aria-pressed={t.mode === m} className={t.mode === m ? s.modeOn : ''} onClick={() => { t.setMode(m); setMenu(false); }}>{m === 'light' ? 'Light' : 'Dark'}</button>
                    ))}
                  </div>
                </div>
              )}
              {walletAddress
                ? <span className={s.connected} title={walletAddress}>Connected</span>
                : <button type="button" className={s.connect} onClick={onConnectWallet}>Connect wallet</button>}
            </span>
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
