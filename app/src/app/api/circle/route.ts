/**
 * T18: a circle (the demo by default), read from devnet on the SERVER and shared.
 *
 * Every viewer's browser used to poll public devnet itself every few seconds;
 * a handful of judges at once would hit its rate limit (429, seen during the
 * seed) and the page would say "Live data unavailable". One read here serves
 * everyone for CACHE_SECONDS, and a keyed endpoint can sit in DEVNET_RPC_URL
 * (server-only, never NEXT_PUBLIC).
 *
 * The browser still SENDS its own transactions (Contribute) through the wallet;
 * only reads come through here. Failure answers 502 with this route's own
 * words, never the RPC client's, which could carry the URL.
 */
import { NextResponse, type NextRequest } from "next/server";
import { Connection, clusterApiUrl } from "@solana/web3.js";

import { DEMO_CIRCLE } from "@/lib/devnet";
import { readLiveCircle, type LiveCircle } from "@/lib/live";
import { OWN_ERROR, namesFor, parseAddress, stockWord } from "@/lib/solana-circles";

export const dynamic = "force-dynamic";

const CACHE_SECONDS = 4;
/** Reads kept, by circle: the demo plus the circles people open from their lists (oldest dropped first). */
const MAX_CACHED = 64;
const cache = new Map<string, { at: number; body: LiveCircle }>();

/**
 * ?address=<circle> reads any Othello circle (Joshua 2026-10-06: Solana circles in the shared list open their own
 * page); without it, the demo circle. readLiveCircle refuses an account the program does not own.
 */
export async function GET(req: NextRequest) {
  const asked = req.nextUrl.searchParams.get("address");
  const address = asked === null ? DEMO_CIRCLE : parseAddress(asked);
  if (!address) return NextResponse.json({ error: "Not a Solana address" }, { status: 400 });
  const now = Date.now();
  const headers = { "cache-control": `public, s-maxage=${CACHE_SECONDS}` };
  const hit = cache.get(address);
  if (hit && now - hit.at < CACHE_SECONDS * 1000) return NextResponse.json(hit.body, { headers });

  const url = process.env.DEVNET_RPC_URL || clusterApiUrl("devnet");
  try {
    const body = await readLiveCircle(new Connection(url, "confirmed"), address, stockWord, namesFor(address));
    cache.delete(address);
    cache.set(address, { at: now, body });
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
    return NextResponse.json(body, { headers });
  } catch (e) {
    const said = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: OWN_ERROR.test(said) ? said : "devnet RPC unreachable or rate-limited" }, { status: 502 });
  }
}
