/**
 * T18: the demo circle, read from devnet on the SERVER and shared.
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
import { NextResponse } from "next/server";
import { Connection, clusterApiUrl } from "@solana/web3.js";

import { DEMO_CIRCLE } from "@/lib/devnet";
import { readLiveCircle, type LiveCircle } from "@/lib/live";

export const dynamic = "force-dynamic";

const CACHE_SECONDS = 4;
const STOCK_WORD = "NFLXx mirror";
let cache: { at: number; body: LiveCircle } | null = null;

export async function GET() {
  const now = Date.now();
  const headers = { "cache-control": `public, s-maxage=${CACHE_SECONDS}` };
  if (cache && now - cache.at < CACHE_SECONDS * 1000) return NextResponse.json(cache.body, { headers });

  const url = process.env.DEVNET_RPC_URL || clusterApiUrl("devnet");
  try {
    const body = await readLiveCircle(new Connection(url, "confirmed"), DEMO_CIRCLE, STOCK_WORD);
    cache = { at: now, body };
    return NextResponse.json(body, { headers });
  } catch (e) {
    const said = e instanceof Error ? e.message : String(e);
    // readLiveCircle's own refusals are safe to show; anything from the RPC
    // client is summarised, so a keyed URL can never reach the browser.
    const own = /^(No circle at|Missing |Seat \d|Member account|Expected \d|Unknown circle status|The circle's stock mint|Multiplier |.* is not an Othello account)/.test(said);
    return NextResponse.json({ error: own ? said : "devnet RPC unreachable or rate-limited" }, { status: 502 });
  }
}
