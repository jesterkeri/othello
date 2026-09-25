/**
 * Where each nav label goes.
 *
 * Landing and Shell carry the same four labels, and until now clicking any of
 * them did nothing at all: Landing's were buttons with no handler and Shell's
 * called an `onNavigate` nobody passed. A control that looks live and does
 * nothing is worse than one that is plainly absent, because the person clicking
 * it concludes the app is broken rather than unfinished.
 *
 * So every label routes, and the two places that do not exist yet route to
 * paths that do not exist either, which Next renders with the designed 404.
 * That page says what is going on and offers somewhere to go.
 *
 * When Split lab (S1) and How it works are built, they take these paths and
 * nothing else changes.
 */
export const NAV_HREF: Record<string, string> = {
  Home: "/",
  Circles: "/circle/demo",
  xStocks: "/assets",
  Portfolio: "/portfolio",
  "Split lab": "/split-lab",
  "How it works": "/how-it-works",
};

/** The labels that lead somewhere real today. */
export const BUILT = new Set(["Home", "Circles", "xStocks", "Split lab", "How it works", "Portfolio"]);

export function hrefFor(label: string): string {
  return NAV_HREF[label] ?? "/";
}
