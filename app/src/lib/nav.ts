import type { ChainSide } from "./chains";

/**
 * Where each nav label goes.
 *
 * Landing and Shell carry the same labels, and a control that looks live and does nothing is worse than one that is
 * plainly absent, so every label routes.
 *
 * Circles, Portfolio and Assets belong to one chain, so where they go depends on the side the connected wallet
 * decides (lib/active-side.ts): with no wallet they go to pages that ask for one; with an EVM wallet to the Robinhood
 * Chain pages; with a Solana wallet to the Solana pages. Home and How it works are the same for everyone.
 */
export const NAV_HREF: Record<string, string> = {
  Home: "/",
  Circles: "/circles",
  xStocks: "/assets",
  Stocks: "/assets",
  Assets: "/assets",
  Portfolio: "/portfolio",
  "Split lab": "/split-lab",
  "How it works": "/how-it-works",
  Create: "/circles",
};

const SIDE_HREF: Record<ChainSide, Record<string, string>> = {
  solana: { Create: "/circle/new", Circles: "/circle/demo", Portfolio: "/portfolio", Assets: "/assets", xStocks: "/assets", Stocks: "/assets" },
  robinhood: { Create: "/robinhood/new", Circles: "/robinhood", Portfolio: "/robinhood", Assets: "/robinhood/assets", xStocks: "/robinhood/assets", Stocks: "/robinhood/assets" },
};

/** The labels that lead somewhere real today. */
export const BUILT = new Set(["Home", "Circles", "xStocks", "Split lab", "How it works", "Portfolio", "Stocks", "Assets"]);

export function hrefFor(label: string, side: ChainSide | null = null): string {
  return (side ? SIDE_HREF[side][label] : undefined) ?? NAV_HREF[label] ?? "/";
}
