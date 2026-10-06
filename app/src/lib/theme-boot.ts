/**
 * The first frame's colours. Each screen's root carries data-tk ("inner" for the shell's pages, "landing" for Landing)
 * and, until React has read the stored theme, takes its variables from the rules layout.tsx renders into <head>:
 * first each screen's own first-visit default, then (from the script below) the stored theme's resolved variables,
 * cached by lib/theme cacheThemeVars. Without this every page first drew the default palette, then switched to the
 * visitor's (Joshua 2026-10-06).
 */
import { PALETTES, VARS_KEY, innerVars, themeVars } from "./theme";

export const cssVars = (vars: Record<string, string>) => Object.entries(vars).map(([key, value]) => `${key}:${value}`).join(";");

/** Each screen's first-visit default: the shell Bubblegum dark (Shell.tsx useTheme), Landing Signal light. */
export const screenDefaults = `[data-tk=inner]{${cssVars(innerVars(PALETTES[1]!, true))}}[data-tk=landing]{${cssVars(themeVars(PALETTES[0]!, false))}}`;

/**
 * Runs before the body is parsed. Paints the cached variables onto :root and both kinds of screen root, the shell's
 * panel onto the body, and the mode onto <html> (the shell's light rules read it before hydration). Only
 * custom-property names and plain colour values pass; anything else in storage is ignored, as is a missing or broken
 * cache (the defaults above stand).
 */
export const paintStoredTheme = `(function(){try{var c=JSON.parse(localStorage.getItem(${JSON.stringify(VARS_KEY)})||"null");if(!c||!c.inner||!c.landing)return;
var ok=function(k,x){return /^--[A-Za-z]+$/.test(k)&&/^[#0-9A-Za-z(),. %-]+$/.test(x)};
var f=function(v){var o="";for(var k in v){var x=String(v[k]);if(ok(k,x))o+=k+":"+x+";"}return o};
var p=String(c.inner["--panel"]);
var s=document.createElement("style");s.id="othello-theme";
s.textContent=":root{"+f(c.landing)+"}[data-tk=landing]{"+f(c.landing)+"}[data-tk=inner]{"+f(c.inner)+"}"+(ok("--panel",p)?"body:has([data-tk=inner]){background:"+p+"}":"");
document.head.appendChild(s);var m=c.mode==="light"?"light":"dark";document.documentElement.dataset.mode=m;document.documentElement.style.colorScheme=m}catch(e){}})();`;
