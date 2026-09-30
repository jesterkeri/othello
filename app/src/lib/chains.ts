/**
 * Othello runs on two chains, and a page belongs to exactly one of them. The route decides which, so the chain
 * switch, the wallet button and the page itself can never disagree (A2-SWITCH, Joshua 2026-09-30).
 *
 * Choosing a wallet chooses the chain: connecting a Solana wallet takes the person to the Solana side, connecting an
 * EVM wallet takes them to Robinhood Chain. Both wallets may stay connected; each side uses its own.
 */
export type ChainSide = "solana" | "robinhood";

/** Where each side starts. */
export const SIDE_HOME: Record<ChainSide, string> = { solana: "/", robinhood: "/robinhood" };

/** The switch's labels: the chain, and the network under it, since both are test networks. */
export const SIDE_LABEL: Record<ChainSide, { chain: string; network: string }> = {
  solana: { chain: "Solana", network: "devnet" },
  robinhood: { chain: "Robinhood", network: "Chain testnet" },
};

/** "Solana devnet", "Robinhood Chain testnet". */
export const sideName = (k: ChainSide) => `${SIDE_LABEL[k].chain} ${SIDE_LABEL[k].network}`;

/**
 * The side a path belongs to. Robinhood Chain pages are /robinhood and below, and a Robinhood circle's page,
 * /circle/rh:<address> (the colon may arrive percent-encoded). Everything else is the Solana side.
 */
export function sideOf(pathname: string | null | undefined): ChainSide {
  const p = pathname || "/";
  if (p === "/robinhood" || p.startsWith("/robinhood/")) return "robinhood";
  if (/^\/circle\/rh(:|%3a)/i.test(p)) return "robinhood";
  return "solana";
}

/** After a person connects a wallet of `kind`: the side's home if they are elsewhere, or null to stay put. */
export function destinationAfterConnect(kind: ChainSide, pathname: string | null | undefined): string | null {
  return sideOf(pathname) === kind ? null : SIDE_HOME[kind];
}
