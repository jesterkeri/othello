/**
 * The first frame's colours. Each screen's root carries data-tk ("inner" for the shell's pages, "landing" for Landing,
 * "wallet" for Landing's wallet control) and, until React has read the stored theme, takes its variables from the
 * rules layout.tsx renders into <head>: first each screen's own first-visit default, then (from the script below) the
 * visitor's stored theme. Without this every page first drew the default palette, then switched to the visitor's
 * (Joshua 2026-10-06).
 */
import { PALETTES, STORAGE_KEY, THEME_STYLE_ID, VARS_KEY, VAR_NAME, VAR_VALUE, innerVars, themeVars } from "./theme";

export const cssVars = (vars: Record<string, string>) => Object.entries(vars).map(([key, value]) => `${key}:${value}`).join(";");

/** Each screen's first-visit default: the shell Bubblegum dark (Shell.tsx useTheme), Landing Signal light. */
const innerDefault = cssVars(innerVars(PALETTES[1]!, true));
export const screenDefaults = `[data-tk=inner]{${innerDefault}}[data-tk=wallet]{${innerDefault}}[data-tk=landing]{${cssVars(themeVars(PALETTES[0]!, false))}}`;

/** The built-in palettes' resolved variables, by choice ("r0".."r3") and mode, for a stored theme with no cache yet. */
const BUILT_IN = Object.fromEntries(PALETTES.map((p, i) => [`r${i}`, {
  light: { inner: innerVars(p, false), landing: themeVars(p, false) },
  dark: { inner: innerVars(p, true), landing: themeVars(p, true) },
}]));

/**
 * Runs before the body is parsed. Takes the cached variables when they were cached from the theme stored now (the
 * cache carries the stored theme it came from); otherwise resolves a built-in palette from the stored theme itself, so
 * a visitor whose theme was stored before the cache existed also opens in it (adversary on 8f0db93). A custom palette
 * with no cache yet keeps the defaults until its first visit caches it. Paints the variables onto :root and every
 * screen root, the shell's panel onto the body, and the mode onto <html> (the shell's light rules read it before
 * hydration). Only custom-property names and hex or rgb() colours pass (lib/theme safeVar); anything else in storage is ignored.
 * The mode follows each screen's own fallback for a stored theme without one: the shell dark, Landing the system's.
 */
export const paintStoredTheme = `(function(){try{
var raw=localStorage.getItem(${JSON.stringify(STORAGE_KEY)});if(!raw)return;
var t=JSON.parse(raw);if(!t||typeof t!=="object")return;
var c=null;try{c=JSON.parse(localStorage.getItem(${JSON.stringify(VARS_KEY)})||"null")}catch(e){}
var inner,landing,im,lm;
if(c&&c.key===raw&&c.inner&&c.landing){inner=c.inner;landing=c.landing;im=lm=c.mode==="light"?"light":"dark"}
else{var B=${JSON.stringify(BUILT_IN)};var p=Object.prototype.hasOwnProperty.call(B,t.choice)?B[t.choice]:B.r0;
im=t.theme==="light"?"light":"dark";lm=t.theme==="light"||t.theme==="dark"?t.theme:(window.matchMedia&&matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");
inner=p[im].inner;landing=p[lm].landing}
var ok=function(k,x){return ${VAR_NAME}.test(k)&&${VAR_VALUE}.test(x)};
var f=function(v){var o="";for(var k in v){var x=String(v[k]);if(ok(k,x))o+=k+":"+x+";"}return o};
var pn=String(inner["--panel"]);
var s=document.createElement("style");s.id=${JSON.stringify(THEME_STYLE_ID)};
s.textContent=":root{"+f(landing)+"}[data-tk=landing]{"+f(landing)+"}[data-tk=inner]{"+f(inner)+"}[data-tk=wallet]{"+f(inner)+"}"+(ok("--panel",pn)?"body:has([data-tk=inner]){background:"+pn+"}":"");
document.head.appendChild(s);document.documentElement.dataset.mode=im;document.documentElement.style.colorScheme=im}catch(e){}})();`;
