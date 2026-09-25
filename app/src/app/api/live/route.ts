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
import { TRADABLE_XSTOCKS } from "@/lib/xstocks";
import { readMintInfo, type MintInfo } from "@/lib/mintInfo";
import { multiplierAt } from "@/lib/scaledUi";

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
  /** Authorities, extensions, issuer powers and on-chain metadata (the asset page). */
  info: MintInfo;
  /** In the program's allowlist: a circle accepts it as cover (ADR-012). */
  accepted: boolean;
  /** Jupiter, per DISPLAYED token; null if Jupiter had no price for it in this read. */
  market: { usdPrice: number; liquidity: number | null; change24h: number | null } | null;
};
export type LiveXStocks = { readAt: number; slot: number; mints: LiveXStock[]; unavailable: { symbol: string; reason: string }[] };

/**
 * Jupiter's current price per DISPLAYED token for every listed xStock, one request. A failure here
 * leaves every market null (the page says the price is unavailable); it never fails the mint read.
 */
async function readJupiter(): Promise<Record<string, LiveXStock["market"]>> {
  try {
    const ids = TRADABLE_XSTOCKS.map((x) => x.address).join(",");
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`, { cache: "no-store" });
    if (!res.ok) return {};
    const body = (await res.json()) as Record<string, { usdPrice?: number; liquidity?: number; priceChange24h?: number } | undefined>;
    const out: Record<string, LiveXStock["market"]> = {};
    for (const [mint, p] of Object.entries(body)) {
      if (p && Number.isFinite(p.usdPrice) && p.usdPrice! > 0) {
        out[mint] = {
          usdPrice: p.usdPrice!,
          liquidity: Number.isFinite(p.liquidity) ? p.liquidity! : null,
          change24h: Number.isFinite(p.priceChange24h) ? p.priceChange24h! : null,
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

async function readMainnet(): Promise<LiveXStocks> {
  const url = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
  // T18 adversary: a malformed MAINNET_RPC_URL made fetch throw "Failed to parse
  // URL from <url>", and the 502 carried a keyed URL to the browser. Nothing
  // fetch says is passed on; only this route's own words are.
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getMultipleAccounts",
      params: [TRADABLE_XSTOCKS.map((x) => x.address), { encoding: "base64", commitment: "confirmed" }],
    }),
    cache: "no-store",
  }).catch(() => {
    throw new Error("mainnet RPC unreachable");
  });
  if (!res.ok) throw new Error(`mainnet RPC answered ${res.status}`);
  const body = (await res.json().catch(() => {
    throw new Error("mainnet RPC returned invalid JSON");
  })) as {
    result?: { context: { slot: number }; value: ({ data: [string, string]; owner: string } | null)[] };
    error?: { message: string };
  };
  if (!body.result) throw new Error("mainnet RPC returned no result");

  const readAt = Math.floor(Date.now() / 1000);
  const accepted = new Set<string>(REAL_XSTOCKS.map((x) => x.address));
  const market = await readJupiter();
  // One unreadable mint must not blank the whole catalog: it is listed by name in `unavailable`
  // (the page says so) and no figure is shown for it. Nothing is filled in.
  const unavailable: { symbol: string; reason: string }[] = [];
  const mints: LiveXStock[] = [];
  TRADABLE_XSTOCKS.forEach((x, i) => {
    const acc = body.result!.value[i];
    const skip = (reason: string) => unavailable.push({ symbol: x.symbol, reason });
    if (!acc) return skip("not found on mainnet");
    if (acc.owner !== "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") return skip("not a Token-2022 mint");
    let m: MintInfo;
    try {
      m = readMintInfo(Buffer.from(acc.data[0], "base64"));
    } catch {
      return skip("not a readable Token-2022 mint");
    }
    if (!m.scaledUi) return skip("carries no ScaledUiAmountConfig");
    mints.push({
      symbol: x.symbol,
      name: x.name,
      address: x.address,
      decimals: m.decimals,
      supply: m.supply,
      ...m.scaledUi,
      multiplierNow: multiplierAt(m.scaledUi, readAt),
      info: m,
      accepted: accepted.has(x.address),
      market: market[x.address] ?? null,
    });
  });
  if (mints.length === 0) throw new Error("no listed xStock could be read from mainnet");
  return { readAt, slot: body.result.context.slot, mints, unavailable };
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
