/**
 * The rules behind "the connected wallet decides what the site shows" (Joshua, 2026-10-03), as plain functions so
 * they are tested without React (tests/neutral-site.spec.ts). lib/active-side.ts and components/othello/SideGate.tsx
 * apply them.
 */
import type { ChainSide } from "./chains";
import { hrefFor } from "./nav";

export type Connected = { solana: boolean; robinhood: boolean };
export type GatedLabel = "Circles" | "Portfolio" | "Assets" | "Create";

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
  return "Circles";
}
