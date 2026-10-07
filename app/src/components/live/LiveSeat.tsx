"use client";

/**
 * The Position and Join pages of a live Solana circle (/circle/demo/position/N, /circle/sol:<address>/join/N): the
 * shared circle page with that seat in focus (Joshua 2026-10-07: the seat pages move onto the shared circle page).
 * LiveCircle reads the chain and refuses a seat the circle does not have.
 */
import LiveCircle from "./LiveCircle";
import { DEMO_CIRCLE } from "@/lib/devnet";

/** `address`: any Othello circle (default the demo; Joshua 2026-10-06, circles opened from the shared list). */
export default function LiveSeat({ kind, seat, address = DEMO_CIRCLE }: { kind: "position" | "join"; seat: number; address?: string }) {
  return <LiveCircle address={address} seat={seat} kind={kind} />;
}
