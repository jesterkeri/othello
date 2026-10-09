/** The app's phone width: the 759px breakpoint its pages use. app/home.module.css hides the landing at the same width. */
export const PHONE = "(max-width: 759px)";

/** Where the home page sends a phone (Joshua, 2026-10-08: no landing on phones), or null to show the landing. */
export function phoneHome(isPhone: boolean): string | null {
  return isPhone ? "/circles" : null;
}
