/**
 * The Solana circles a wallet created or holds a seat in, for the shared circles list (Joshua 2026-10-06). Read on the
 * server, as /api/circle is, so a keyed DEVNET_RPC_URL stays server-side and one scan serves repeat views for
 * CACHE_SECONDS. Failure answers 502 with this route's own words, never the RPC client's.
 */
import { NextResponse, type NextRequest } from "next/server";
import { Connection, clusterApiUrl } from "@solana/web3.js";

import type { LiveCircle } from "@/lib/live";
import { OWN_ERROR, parseAddress, solanaCirclesOf } from "@/lib/solana-circles";

export const dynamic = "force-dynamic";

const CACHE_SECONDS = 10;
const MAX_CACHED = 64;
const cache = new Map<string, { at: number; body: { circles: LiveCircle[]; failed: string[]; total: number } }>();

export async function GET(req: NextRequest) {
  const wallet = parseAddress(req.nextUrl.searchParams.get("wallet"));
  if (!wallet) return NextResponse.json({ error: "Not a Solana address" }, { status: 400 });
  const now = Date.now();
  const headers = { "cache-control": "private, no-store" };
  const hit = cache.get(wallet);
  if (hit && now - hit.at < CACHE_SECONDS * 1000) return NextResponse.json(hit.body, { headers });

  const url = process.env.DEVNET_RPC_URL || clusterApiUrl("devnet");
  try {
    const body = await solanaCirclesOf(new Connection(url, "confirmed"), wallet);
    cache.delete(wallet);
    // an answer with circles that could not be read is not kept: Try again must scan again (adversary on d9a3db1)
    if (body.failed.length === 0) cache.set(wallet, { at: now, body });
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
    return NextResponse.json(body, { headers });
  } catch (e) {
    const said = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: OWN_ERROR.test(said) ? said : "devnet RPC unreachable or rate-limited" }, { status: 502 });
  }
}
