"use client";

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import {
  PALETTES,
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

  useEffect(() => {
    const saved = loadTheme();
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
  const vars = useMemo(() => themeVars(active, dark), [active, dark]) as CSSProperties;

  return (
    <div className={className} data-theme={mode} style={vars}>
      {children}
    </div>
  );
}
