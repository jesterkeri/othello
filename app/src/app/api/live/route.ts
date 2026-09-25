/**
 * S2b: the four real xStocks, read from MAINNET on the server.
 *
 * On the server so the browser never talks to mainnet: a keyed RPC URL stays
 * in MAINNET_RPC_URL (server-only, never NEXT_PUBLIC), and one cached read
 * serves every viewer instead of each one hitting a public rate limit.
 *
 * Nothing is invented on failure: the route answers 502 with the reason, and
 * the panel says "Live data unavailable" (PREFLIGHT, failure behaviour).
 */
import { NextResponse } from "next/server";

import { REAL_XSTOCKS } from "@/lib/devnet";
import { multiplierAt, readMint } from "@/lib/scaledUi";

export const dynamic = "force-dynamic";

const CACHE_SECONDS = 60;
let cache: { at: number; body: LiveXStocks } | null = null;

export type LiveXStock = {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  supply: string;
  multiplier: number;
  newMultiplier: number;
  effectiveAt: number;
  multiplierNow: number;
};
export type LiveXStocks = { readAt: number; slot: number; mints: LiveXStock[] };

async function readMainnet(): Promise<LiveXStocks> {
  const url = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [REAL_XSTOCKS.map((x) => x.address), { encoding: "base64", commitment: "confirmed" }],
    }),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`mainnet RPC answered ${res.status}`);
  const body = (await res.json()) as {
    result?: { context: { slot: number }; value: ({ data: [string, string]; owner: string } | null)[] };
    error?: { message: string };
  };
  if (!body.result) throw new Error(body.error?.message ?? "mainnet RPC returned no result");

  const readAt = Math.floor(Date.now() / 1000);
  const mints = REAL_XSTOCKS.map((x, i) => {
    const acc = body.result!.value[i];
    if (!acc) throw new Error(`${x.symbol} (${x.address}) not found on mainnet`);
    if (acc.owner !== "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") throw new Error(`${x.symbol} is not a Token-2022 mint`);
    const m = readMint(Buffer.from(acc.data[0], "base64"));
    if (!m.scaledUi) throw new Error(`${x.symbol} carries no ScaledUiAmountConfig`);
    return {
      symbol: x.symbol,
      name: x.name,
      address: x.address,
      decimals: m.decimals,
      supply: m.supply,
      ...m.scaledUi,
      multiplierNow: multiplierAt(m.scaledUi, readAt),
    };
  });
  return { readAt, slot: body.result.context.slot, mints };
}

export async function GET() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_SECONDS * 1000) {
    return NextResponse.json(cache.body, { headers: { "cache-control": `public, s-maxage=${CACHE_SECONDS}` } });
  }
  try {
    const body = await readMainnet();
    cache = { at: now, body };
    return NextResponse.json(body, { headers: { "cache-control": `public, s-maxage=${CACHE_SECONDS}` } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
