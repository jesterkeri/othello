/**
 * The rules behind "the connected wallet decides what the site shows" (Joshua, 2026-10-03), as plain functions so
 * they are tested without React (tests/neutral-site.spec.ts). lib/active-side.ts and components/othello/SideGate.tsx
 * apply them.
 */
import type { ChainSide } from "./chains";
import { STATE_KEYS } from "../fixtures/circles";
import { sideOf } from "./chains";
import { hrefFor } from "./nav";
import { TRADABLE_XSTOCKS } from "./xstocks";

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

/** The routes that exist on each chain (app/src/app): anything else is the 404, which is neutral. */
const ROBINHOOD_ROUTES = new Set(["/robinhood", "/robinhood/new", "/robinhood/assets"]);
const SOLANA_ROUTES = new Set(["/portfolio", "/split-lab", "/circle/new", "/assets"]);
const SOLANA_CIRCLES = new Set<string>([...STATE_KEYS, "demo", "stale"]);
const XSTOCK_SYMBOLS = new Set(TRADABLE_XSTOCKS.map((x) => x.symbol));
const decodeOnce = (s: string): string | null => { try { return decodeURIComponent(s); } catch { return null; } };

/**
 * The network a page belongs to, for the connect window (Joshua, 2026-10-03: choose the network first, then the
 * wallet; a page of one chain opens straight at that chain's wallets). Null for the neutral pages (home, How it works,
 * the circles entry) and for any route that does not exist, which renders the 404 (adversary pass on b47a8ac). A
 * circle page is decided by lib/chains.ts sideOf, which decodes its id exactly as the page does, so an encoded
 * Robinhood circle address (/circle/rh%3A0x…) is Robinhood's.
 */
export function pageNetwork(pathname: string | null | undefined): "robinhood" | "solana" | null {
  const p = pathname || "/";
  if (ROBINHOOD_ROUTES.has(p)) return "robinhood";
  if (SOLANA_ROUTES.has(p)) return "solana";
  const asset = /^\/assets\/([^/]+)$/.exec(p);
  if (asset) return XSTOCK_SYMBOLS.has(decodeOnce(asset[1]!) ?? "") ? "solana" : null;
  const circle = /^\/circle\/([^/]+)(?:\/(join|position)\/([^/]+))?$/.exec(p);
  if (circle) {
    if (!circle[2] && sideOf(p) === "robinhood") return "robinhood";
    const id = decodeOnce(circle[1]!);
    if (id !== null && SOLANA_CIRCLES.has(id) && (!circle[2] || /^[1-5]$/.test(circle[3]!))) return "solana";
  }
  return null;
}
