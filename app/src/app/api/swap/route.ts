/**
 * T18g: builds a Jupiter swap, USDC into one listed xStock (mainnet), for the buyer to sign in their
 * own wallet on this page. The mint comes from the registry (lib/xstocks.ts), never the browser; the
 * quote is taken fresh here; Jupiter's transaction is checked (paid by the buyer, invokes Jupiter)
 * before it is returned. Nothing is signed or sent here.
 */
import { PublicKey } from "@solana/web3.js";
import { NextResponse, type NextRequest } from "next/server";

import { checkSwapTx } from "@/lib/swap";
import { TRADABLE_XSTOCKS } from "@/lib/xstocks";

export const dynamic = "force-dynamic";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP = "https://lite-api.jup.ag/swap/v1";

export type SwapBuild = { tx: string; lastValidBlockHeight: number; outRaw: string; minOutRaw: string; priceImpactPct: number; usdc: number };

function fail(error: string, status = 502) {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { symbol?: unknown; usdc?: unknown; user?: unknown } | null;
  const x = TRADABLE_XSTOCKS.find((t) => t.symbol === body?.symbol);
  if (!x) return fail("not a listed xStock", 404);
  // Adversary pass 5: never round or reinterpret money. Only a plain decimal with at most 6 places
  // ("1e2", "0x10", "1.0000005" are refused), converted with string arithmetic.
  const typed = typeof body?.usdc === "number" && Number.isFinite(body.usdc) ? String(body.usdc) : body?.usdc;
  const m = typeof typed === "string" ? /^(\d+)(?:\.(\d{1,6}))?$/.exec(typed.trim()) : null;
  if (!m) return fail("enter a plain USDC amount with at most 6 decimal places", 400);
  const micro = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  if (micro < 1_000_000n || micro > 100_000_000_000n) return fail("enter between 1 and 100,000 USDC", 400);
  let user: string;
  try {
    user = new PublicKey(String(body?.user)).toBase58();
  } catch {
    return fail("not a wallet address", 400);
  }
  const amount = micro.toString();
  try {
    const q = await fetch(`${JUP}/quote?inputMint=${USDC}&outputMint=${x.address}&amount=${amount}&slippageBps=100&restrictIntermediateTokens=true`, { cache: "no-store" }).catch(() => null);
    if (!q) throw new Error("Jupiter unreachable");
    const quote = (await q.json().catch(() => null)) as { outAmount?: unknown; otherAmountThreshold?: unknown; priceImpactPct?: unknown; outputMint?: unknown } | null;
    if (!q.ok || !quote) throw new Error("Jupiter found no route");
    if (quote.outputMint !== x.address) throw new Error("Jupiter quoted a different token");
    const out = typeof quote.outAmount === "string" && /^[0-9]+$/.test(quote.outAmount) ? quote.outAmount : null;
    const min = typeof quote.otherAmountThreshold === "string" && /^[0-9]+$/.test(quote.otherAmountThreshold) ? quote.otherAmountThreshold : null;
    const impact = Number(quote.priceImpactPct);
    if (!out || !min || !Number.isFinite(impact)) throw new Error("Jupiter returned an incomplete quote");

    const s = await fetch(`${JUP}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: user, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: "auto" }),
      cache: "no-store",
    }).catch(() => null);
    if (!s) throw new Error("Jupiter unreachable");
    const swap = (await s.json().catch(() => null)) as { swapTransaction?: unknown; lastValidBlockHeight?: unknown } | null;
    if (!s.ok || typeof swap?.swapTransaction !== "string" || typeof swap.lastValidBlockHeight !== "number") throw new Error("Jupiter could not build the swap");
    const check = checkSwapTx(swap.swapTransaction, user, false);
    if (!check.ok) throw new Error(`Jupiter's transaction was refused: ${check.reason}`);

    const built: SwapBuild = { tx: swap.swapTransaction, lastValidBlockHeight: swap.lastValidBlockHeight, outRaw: out, minOutRaw: min, priceImpactPct: impact * 100, usdc: Number(micro) / 1_000_000 };
    return NextResponse.json(built, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const said = e instanceof Error ? e.message : String(e);
    return fail(/^Jupiter/.test(said) ? said : "swap unavailable");
  }
}
