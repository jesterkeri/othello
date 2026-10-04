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

const decodeOnce = (s: string): string | null => {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
};

/**
 * The side a path belongs to. Robinhood Chain pages are /robinhood and below, and a Robinhood circle's page. For
 * /circle/<id> this repeats the circle page's own test exactly (app/src/app/circle/[id]/page.tsx): Next decodes the
 * segment once, the page decodes it again, then `startsWith("rh:")`, case-sensitive; so /circle/%72h:0x… is Robinhood
 * and /circle/RH:0x… is not (adversary pass on 9a24341). Everything else is the Solana side. Pages that know their
 * side also say so to the Shell (`side`), so the top bar never depends on this for them.
 */
export function sideOf(pathname: string | null | undefined): ChainSide {
  const p = pathname || "/";
  if (p === "/robinhood" || p.startsWith("/robinhood/")) return "robinhood";
  const circle = /^\/circle\/([^/?#]+)/.exec(p);
  if (circle) {
    const once = decodeOnce(circle[1]!);
    const id = once === null ? null : decodeOnce(once);
    if (id !== null && id.startsWith("rh:")) return "robinhood";
  }
  return "solana";
}

/** After a person connects a wallet of `kind`: the side's home if they are elsewhere, or null to stay put. */
export function destinationAfterConnect(kind: ChainSide, pathname: string | null | undefined): string | null {
  return sideOf(pathname) === kind ? null : SIDE_HOME[kind];
}
