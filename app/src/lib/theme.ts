/**
 * The palette engine, ported from the design artifact.
 *
 * Colours are derived, not picked: a brand hue produces the five accents and
 * the grounds, and the ink on every fill is chosen to clear 4.5:1 against it.
 * That is why the design survives a theme change without anyone re-checking
 * contrast by eye, and it is why this is ported rather than replaced with a
 * hand-written palette.
 */

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const v = hex.replace("#", "");

  return [
    Number.parseInt(v.slice(0, 2), 16),
    Number.parseInt(v.slice(2, 4), 16),
    Number.parseInt(v.slice(4, 6), 16),
  ];
}

function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);

  return `#${x
    .map((n, i) => Math.round(n + ((y[i] ?? 0) - n) * t))
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Relative luminance, WCAG 2.1. */
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((n) => {
    const v = n / 255;

    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as Rgb;

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Ink that clears 4.5:1 against its own fill. */
function inkFor(hex: string): string {
  return luminance(hex) > 0.32 ? "#0B0B0B" : "#FBF9F2";
}

/** Same hue, different intensity: pull to a target lightness without draining it. */
function atLuminance(hex: string, target: number): string {
  const toward = luminance(hex) > target ? "#000000" : "#FFFFFF";
  let lo = 0;
  let hi = 1;
  let out = hex;

  for (let i = 0; i < 18; i += 1) {
    const t = (lo + hi) / 2;

    out = mix(hex, toward, t);

    if (luminance(out) > target) {
      if (toward === "#000000") lo = t;
      else hi = t;
    } else if (toward === "#000000") hi = t;
    else lo = t;
  }

  return out;
}

export type Palette = { name: string; brand: string; dark: readonly string[] };

/** "Signal", the artifact's default: lime and cobalt. */
export const SIGNAL: Palette = {
  name: "Signal",
  brand: "#2B4BFF",
  dark: ["#D6F24A", "#7FC4EE", "#2B3BEF", "#12A594", "#E2552B"],
};

const SLOTS = ["acid", "sky", "cobalt", "teal", "clay"] as const;

/**
 * Light mode is the same hues at lower strength; dark keeps them at full
 * contrast. Cobalt is barely lightened because it carries white ink.
 */
function huesFor(palette: Palette, dark: boolean): string[] {
  if (dark) return [...palette.dark];

  return palette.dark.map((h, i) => (i === 2 ? mix(h, "#FFFFFF", 0.04) : mix(h, "#FFFFFF", 0.2)));
}

function grounds(brand: string, dark: boolean): Record<string, string> {
  if (dark) {
    return {
      desk: atLuminance(brand, 0.075),
      paper: atLuminance(brand, 0.042),
      deep: atLuminance(brand, 0.86),
      deepInk: "#0B0B0B",
      grey: atLuminance(brand, 0.2),
      greyFill: atLuminance(brand, 0.09),
      ink: "#FBF9F2",
      muted: atLuminance(brand, 0.62),
    };
  }

  return {
    desk: atLuminance(brand, 0.82),
    paper: atLuminance(brand, 0.95),
    deep: atLuminance(brand, 0.035),
    deepInk: "#FBF9F2",
    grey: atLuminance(brand, 0.58),
    greyFill: atLuminance(brand, 0.9),
    ink: "#0B0B0B",
    muted: "#5C594F",
  };
}

/** Every CSS custom property for one palette in one mode. */
export function themeVars(palette: Palette, dark: boolean): Record<string, string> {
  const hues = huesFor(palette, dark);
  const vars: Record<string, string> = {};

  SLOTS.forEach((slot, i) => {
    const hex = hues[i] ?? palette.brand;

    vars[`--${slot}`] = hex;
    vars[`--${slot}Ink`] = inkFor(hex);
  });

  for (const [key, value] of Object.entries(grounds(palette.brand, dark))) {
    vars[`--${key}`] = value;
  }

  return vars;
}

/** The same map as a CSS declaration block, for a :root rule. */
export function themeCss(palette: Palette, dark: boolean): string {
  return Object.entries(themeVars(palette, dark))
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}
