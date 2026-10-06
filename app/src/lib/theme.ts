// Othello colour engine. Colours are solved at runtime from one profile, never listed as light/dark pairs.
// See OTHELLO-STYLE.md. Rule: any element filled with an accent uses that accent's own --<slot>Ink var.

export type Hex = `#${string}`;
export type Profile = { name: string; note: string; brand: string; dark: string[] };
export type CustomProfile = { name: string; hues: string[] };
export type ThemeMode = 'light' | 'dark';
export type StoredTheme = { choice: string; theme: ThemeMode | null; custom: CustomProfile[] };

export const SLOTS = ['acid', 'sky', 'cobalt', 'teal', 'clay'] as const;
export const SLOT_LABELS = ['Primary', 'Secondary', 'Deep', 'Support', 'Accent'] as const;
export const STORAGE_KEY = 'othello.theme';
/** The resolved variables of the stored theme, read by layout.tsx's head script before the page paints. */
export const VARS_KEY = 'othello.theme.vars';

export const PALETTES: Profile[] = [
  { name: 'Signal', note: 'Lime and cobalt', brand: '#2B4BFF', dark: ['#D6F24A', '#7FC4EE', '#2B3BEF', '#12A594', '#E2552B'] },
  { name: 'Bubblegum', note: 'Pink and violet', brand: '#E0489B', dark: ['#F2559B', '#E8B62C', '#6B2AE8', '#3FBF7A', '#F04F2C'] },
  { name: 'Harbour', note: 'Sand and navy', brand: '#1B3A8F', dark: ['#E0A93C', '#3E9FC4', '#1B3A8F', '#128C7E', '#C2401C'] },
  { name: 'Newsprint', note: 'Stone and rust', brand: '#8A8578', dark: ['#CFCABA', '#A8A394', '#26241D', '#8C8779', '#E2552B'] },
];

function hex2rgb(h: string): [number, number, number] {
  const v = h.replace('#', '');
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

export function mix(a: string, b: string, t: number): string {
  const x = hex2rgb(a), y = hex2rgb(b);
  return '#' + x.map((n, i) => Math.round(n + (y[i]! - n) * t).toString(16).padStart(2, '0')).join('');
}

export function lum(h: string): number {
  const c = hex2rgb(h).map((n) => {
    const v = n / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

/** Text colour that clears contrast on its own fill. */
export function inkFor(h: string): string {
  return lum(h) > 0.32 ? '#0B0B0B' : '#FBF9F2';
}

/** Dark uses accents as declared; light mixes 20% toward white, the deep slot (index 2) only 4%. */
export function huesFor(set: { dark: string[] }, dark: boolean): string[] {
  if (dark) return set.dark;
  return set.dark.map((h, i) => (i === 2 ? mix(h, '#FFFFFF', 0.04) : mix(h, '#FFFFFF', 0.2)));
}

/** Pull a hue to a target relative luminance without draining it. */
export function atLum(hex: string, target: number): string {
  const toward = lum(hex) > target ? '#000000' : '#FFFFFF';
  let lo = 0, hi = 1, out = hex;
  for (let i = 0; i < 18; i++) {
    const t = (lo + hi) / 2;
    out = mix(hex, toward, t);
    const above = lum(out) > target;
    if (toward === '#000000') { if (above) lo = t; else hi = t; }
    else { if (above) hi = t; else lo = t; }
  }
  return out;
}

export function grounds(brand: string, dark: boolean) {
  if (dark) {
    return {
      desk: atLum(brand, 0.075), paper: atLum(brand, 0.042), deep: atLum(brand, 0.86),
      deepInk: '#0B0B0B', grey: atLum(brand, 0.2), greyFill: atLum(brand, 0.09),
    };
  }
  return {
    desk: atLum(brand, 0.82), paper: atLum(brand, 0.95), deep: atLum(brand, 0.035),
    deepInk: '#FBF9F2', grey: atLum(brand, 0.58), greyFill: atLum(brand, 0.9),
  };
}

export function hsl(deg: number, sat: number, light: number): string {
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => {
    const k = (((n + deg / 30) % 12) + 12) % 12;
    const v = light - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * v).toString(16).padStart(2, '0');
  };
  return '#' + f(0) + f(8) + f(4);
}

/** A full five-slot set from one base hue ("Surprise me"). */
export function huesFromBase(h: number): string[] {
  return [hsl(h + 32, 0.78, 0.55), hsl(h - 28, 0.62, 0.52), hsl(h, 0.82, 0.36), hsl(h + 158, 0.55, 0.42), hsl(h + 18, 0.78, 0.48)];
}

export function customToProfile(c: CustomProfile, i: number): Profile {
  return { name: c.name || `Profile ${i + 1}`, note: 'Yours', brand: c.hues[2]!, dark: c.hues };
}

/** Every CSS custom property the UI reads. Spread onto the root element's style. */
export function themeVars(set: { brand: string; dark: string[] }, dark: boolean): Record<string, string> {
  const hues = huesFor(set, dark);
  const vars: Record<string, string> = {
    '--ink': dark ? '#FBF9F2' : '#0B0B0B',
    '--muted': dark ? '#ADA899' : '#5C594F',
    '--cream': '#FBF9F2',
    '--chrome': atLum(set.brand, dark ? 0.03 : 0.035),
  };
  SLOTS.forEach((slot, i) => {
    vars[`--${slot}`] = hues[i]!;
    vars[`--${slot}Ink`] = inkFor(hues[i]!);
  });
  const g = grounds(set.brand, dark);
  (Object.keys(g) as (keyof typeof g)[]).forEach((k) => { vars[`--${k}`] = g[k]; });
  return vars;
}

export function preview(set: { brand: string; dark: string[] }, dark: boolean) {
  const hues = huesFor(set, dark);
  return { desk: grounds(set.brand, dark).desk, tile: hues[0], tileAlt: hues[1], deep: hues[2], btn: hues[4] };
}

/** A hue the picker can produce: six-digit hex. Anything else in storage is dropped (it reaches CSS). */
const HUE = /^#[0-9A-Fa-f]{6}$/;

export function loadTheme(): StoredTheme | null {
  if (!('window' in globalThis)) return null; // server render; same check as typeof window, without DOM types (root tsc)
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!s) return null;
    const custom: CustomProfile[] = Array.isArray(s.custom)
      ? s.custom.filter((c: CustomProfile) => Array.isArray(c?.hues) && c.hues.length === 5 && c.hues.every((h) => typeof h === 'string' && HUE.test(h)))
        .map((c: CustomProfile) => ({ name: typeof c.name === 'string' ? c.name : '', hues: c.hues }))
      : [];
    // a choice that names no palette is the first built-in, on every screen, so they all resolve (and cache) the same one
    const choice = typeof s.choice === 'string' && (/^r[0-3]$/.test(s.choice) || (/^c\d+$/.test(s.choice) && Number(s.choice.slice(1)) < custom.length))
      ? s.choice : 'r0';
    return { choice, theme: s.theme === 'light' || s.theme === 'dark' ? s.theme : null, custom };
  } catch { return null; }
}

export function saveTheme(t: StoredTheme) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(t)); } catch { /* storage unavailable */ }
}

/**
 * Inner pages (Create, 404). Accents stay at full strength in both modes.
 * Desk carries the profile hue; the frame is always dark; cards are neutral.
 */
export function innerVars(set: { brand: string; dark: string[] }, dark: boolean): Record<string, string> {
  const b = set.brand, a = set.dark[0]!;
  const v: Record<string, string> = {
    '--line': '#0B0B0B',
    '--frame': '#0B0B0B',
    '--card': '#0B0B0B',
    '--onCard': '#FBF9F2',
    '--cardMuted': '#A9A596',
    '--cardLine': 'rgba(255,255,255,.18)',
    '--chip': '#FFFFFF',
    '--sheet': '#FFFFFF',
    '--sheetMuted': '#5C594F',
    '--railMuted': mix(atLum(b, 0.45), '#ADA899', 0.5),
    '--railHover': '#1C1C1B',
    // Wallet Screen: the "keys" note in the connect modal is always ink on cream.
    '--deepBg': '#0B0B0B',
    '--deepFg': '#FBF9F2',
  };
  set.dark.forEach((h, i) => { v[`--${SLOTS[i]!}`] = h; v[`--${SLOTS[i]!}Ink`] = inkFor(h); });
  v['--title'] = dark || lum(a) < 0.3 ? a : atLum(a, 0.1);
  if (dark) Object.assign(v, {
    '--desk': atLum(b, 0.075), '--panel': mix(atLum(b, 0.012), '#141414', 0.55), '--onPanel': '#FBF9F2',
    '--panelMuted': mix(atLum(b, 0.45), '#ADA899', 0.5), '--raised': '#1C1C1B', '--chipHover': atLum(b, 0.8),
  });
  else Object.assign(v, {
    // Frameless handoff: light mode is a tint of the palette's brand colour, not near-white.
    '--desk': atLum(b, 0.82), '--panel': mix(atLum(b, 0.72), '#F4F2EC', 0.2), '--onPanel': '#0B0B0B',
    '--panelMuted': mix(atLum(b, 0.1), '#5C594F', 0.5), '--raised': mix(atLum(b, 0.6), '#E6E2D9', 0.2), '--chipHover': atLum(b, 0.9),
  });
  // Circle, seat and stock pages moved into the Shell (2026-09-25): their own names for the same roles.
  v['--paper'] = v['--raised']!;
  v['--ink'] = v['--onPanel']!;
  v['--muted'] = v['--panelMuted']!;
  v['--greyFill'] = dark ? mix(atLum(b, 0.02), '#262624', 0.5) : mix(atLum(b, 0.5), '#D8D2C4', 0.35);
  // Card-stack pages (Split lab): --gutter shows between cards, --tile is the neutral card. Accent cards use their slot + ink.
  v['--gutter'] = dark ? '#0B0B0B' : mix(atLum(b, 0.62), '#CFC9BC', 0.5);
  v['--gutterMuted'] = dark ? v['--panelMuted']! : '#2E2C27';
  v['--tile'] = dark ? mix(atLum(b, 0.03), '#1C1C1B', 0.6) : v['--panel']!;
  return v;
}

/**
 * What may go into a head rule: a custom-property name, and a hex or rgb()/rgba() colour, the only values the theme
 * produces. Anything else, from a tampered store, is left out (adversary on f51734a: a stored hue closed its block).
 * lib/theme-boot.ts's head script applies the same two patterns.
 */
export const VAR_NAME = /^--[A-Za-z]+$/;
export const VAR_VALUE = /^(#[0-9A-Fa-f]{3,8}|rgba?\([0-9., ]+\))$/;
export const safeVar = (name: string, value: string) => VAR_NAME.test(name) && VAR_VALUE.test(value);

/** The head rules for a resolved theme: :root and Landing's root, the shell's root and Landing's wallet control, and the
 * shell's panel behind the page. lib/theme-boot.ts's head script writes the same rules. */
export function themeRules(inner: Record<string, string>, landing: Record<string, string>): string {
  const css = (v: Record<string, string>) => Object.entries(v).filter(([k, x]) => safeVar(k, x)).map(([k, x]) => `${k}:${x};`).join('');
  return `:root{${css(landing)}}[data-tk=landing]{${css(landing)}}[data-tk=inner]{${css(inner)}}[data-tk=wallet]{${css(inner)}}`
    + (safeVar('--panel', inner['--panel'] ?? '') ? `body:has([data-tk=inner]){background:${inner['--panel']}}` : '');
}

/** The id of the head stylesheet that holds the stored theme's rules. */
export const THEME_STYLE_ID = 'othello-theme';

/**
 * Caches the stored theme's resolved variables for both kinds of screen (inner pages, Landing), keyed to the stored
 * theme they came from, so layout.tsx's head script can paint them before React runs: without it every page first drew
 * the default palette, then switched (Joshua 2026-10-06). Also rewrites the head stylesheet, so a screen that mounts
 * after a client-side navigation takes the theme just picked, and marks the document's mode, which the shell's light
 * rules read before hydration. Call it after saveTheme.
 */
export function cacheThemeVars(profile: { brand: string; dark: string[] }, mode: ThemeMode) {
  const dark = mode === 'dark';
  const inner = innerVars(profile, dark), landing = themeVars(profile, dark);
  try {
    localStorage.setItem(VARS_KEY, JSON.stringify({ key: localStorage.getItem(STORAGE_KEY), mode, inner, landing }));
  } catch { /* storage unavailable */ }
  // the root tsc has no DOM types (see loadTheme), so the document is typed by the few members used here
  const doc = (globalThis as { document?: ThemeDocument }).document;
  if (!doc) return;
  let el = doc.getElementById?.(THEME_STYLE_ID);
  if (!el) { el = doc.createElement('style'); el.id = THEME_STYLE_ID; doc.head.appendChild(el); }
  el.textContent = themeRules(inner, landing);
  doc.documentElement.dataset['mode'] = mode;
}

type ThemeStyle = { id: string; textContent: string | null };
type ThemeDocument = {
  getElementById?(id: string): ThemeStyle | null;
  createElement(tag: 'style'): ThemeStyle;
  head: { appendChild(node: ThemeStyle): unknown };
  documentElement: { dataset: Record<string, string | undefined> };
};
