/**
 * The rules behind "the connected wallet decides what the site shows" (Joshua, 2026-10-03), as plain functions so
 * they are tested without React (tests/neutral-site.spec.ts). lib/active-side.ts and components/othello/SideGate.tsx
 * apply them.
 */
import type { ChainSide } from "./chains";
import { hrefFor } from "./nav";

export type Connected = { solana: boolean; robinhood: boolean };
export type GatedLabel = "Circles" | "Portfolio" | "Assets" | "Create" | "Split lab";

/** The side the site shows: the only connected wallet's; with both, the page's own; with none, null (neutral). */
export function activeSide(connected: Connected, routeSide: ChainSide): ChainSide | null {
  if (connected.solana && connected.robinhood) return routeSide;
  if (connected.robinhood) return "robinhood";
  if (connected.solana) return "solana";
  return null;
}

/** The chain switch (both sides as links) is shown only while no wallet, or both wallets, are connected. */
export const showsChainSwitch = (c: Connected) => c.solana === c.robinhood;

/** A page of one chain: shown with that chain's wallet; sent to the other side's page of the same kind; or a gate. */
export function gateDecision(page: ChainSide, label: GatedLabel, connected: Connected):
  { show: "page" } | { show: "connect" } | { show: "redirect"; to: string } {
  if (connected[page]) return { show: "page" };
  const other: ChainSide = page === "solana" ? "robinhood" : "solana";
  if (connected[other]) return { show: "redirect", to: hrefFor(label, other) };
  return { show: "connect" };
}

/** The menu label a gated route belongs to. */
export function labelOf(pathname: string): GatedLabel {
  if (pathname === "/assets" || pathname.startsWith("/assets/") || pathname === "/robinhood/assets" || pathname.startsWith("/robinhood/assets/")) return "Assets";
  if (pathname === "/portfolio" || pathname.startsWith("/portfolio/")) return "Portfolio";
  // each side's page to start a circle: sent to the other side's create page, not its circles home (adversary on 1ea71fe)
  if (pathname === "/circle/new" || pathname === "/robinhood/new") return "Create";
  // the Solana split lab sits under How it works in the menu; it has no Robinhood Chain equivalent, so an EVM-only
  // visitor goes to the Robinhood circles (adversary passes on 8e93a30 and 856f0d8)
  if (pathname === "/split-lab" || pathname.startsWith("/split-lab/")) return "Split lab";
  return "Circles";
}

/**
 * The network a page belongs to, for the connect window (Joshua, 2026-10-03: choose the network first, then the
 * wallet; a page of one chain opens straight at that chain's wallets). Null for the neutral pages (home, How it works,
 * the circles entry, anything unknown), where the window starts with the network choice.
 */
export function pageNetwork(pathname: string | null | undefined): "robinhood" | "solana" | null {
  const p = pathname || "/";
  if (p === "/robinhood" || p.startsWith("/robinhood/") || p.startsWith("/circle/rh:")) return "robinhood";
  if (/^\/(assets|portfolio|split-lab)(\/|$)/.test(p) || p.startsWith("/circle/")) return "solana";
  return null;
}
