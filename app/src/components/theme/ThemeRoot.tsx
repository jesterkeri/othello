"use client";

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { applyThemeToDocument } from "@/lib/applyTheme";
import {
  PALETTES,
  cacheThemeVars,
  customToProfile,
  loadTheme,
  themeVars,
  type Profile,
  type ThemeMode,
} from "@/lib/theme";

/**
 * Applies the stored profile to a screen's root element.
 *
 * Landing carries its own copy of this because it also owns the picker that
 * writes the profile. Both read the same `othello.theme` key through
 * lib/theme, so a palette chosen on Landing is the palette every other screen
 * opens with. Folding Landing's copy into this component is a refactor for the
 * frontend's R pass, not something to do inside a faithful port.
 */
export function ThemeRoot({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<ThemeMode>("light");
  const [choice, setChoice] = useState("r0");
  const [custom, setCustom] = useState<{ name: string; hues: string[] }[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const saved = loadTheme();
    setReady(true);
    if (!saved) return;
    setChoice(saved.choice);
    setCustom(saved.custom);
    setMode(
      saved.theme ??
        (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"),
    );
  }, []);

  const dark = mode === "dark";
  const mine = useMemo(() => custom.map(customToProfile), [custom]);
  const active: Profile = choice.startsWith("c")
    ? (mine[Number(choice.slice(1))] ?? PALETTES[0]!)
    : (PALETTES[Number(choice.slice(1))] ?? PALETTES[0]!);
  const vars = useMemo(() => themeVars(active, dark), [active, dark]);

  // body and the overscroll area sit outside this element, so they need the
  // same variables or dark mode shows a light strip behind the frame.
  useEffect(() => {
    if (!ready) return;
    applyThemeToDocument(vars, mode);
    cacheThemeVars(active, mode);
  }, [ready, vars, mode, active]);

  return (
    <div className={className} data-tk="landing" data-theme={mode} style={ready ? (vars as CSSProperties) : undefined}>
      {children}
    </div>
  );
}
