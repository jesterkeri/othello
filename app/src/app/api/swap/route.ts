/**
 * T18g: builds a Jupiter swap, USDC into one listed xStock (mainnet), for the buyer to sign in their
 * own wallet on this page. The mint comes from the registry (lib/xstocks.ts), never the browser; the
 * quote is taken fresh here; Jupiter's transaction is checked (paid by the buyer, invokes Jupiter)
 * before it is returned. Nothing is signed or sent here.
 */
import { PublicKey } from "@solana/web3.js";
import { NextResponse, type NextRequest } from "next/server";

import { checkSwapAccounts, checkSwapTx, fetchLookupTables, jupiterRouteTail, resolveKeys } from "@/lib/swap";
import { sealConfigured, sealSwap } from "@/lib/swapSeal";
import { TRADABLE_XSTOCKS } from "@/lib/xstocks";

export const dynamic = "force-dynamic";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const JUP = "https://lite-api.jup.ag/swap/v1";

/** `seal` binds this exact transaction to the buyer and symbol; /api/swap/send relays nothing without it. */
export type SwapBuild = { tx: string; seal: string; lastValidBlockHeight: number; outRaw: string; minOutRaw: string; priceImpactPct: number; usdc: number };

function fail(error: string, status = 502) {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest) {
  // B1: without the binding key the relay could not recognise this swap, so none is built.
  if (!sealConfigured()) return fail("swap unavailable", 503);
  const body = (await req.json().catch(() => null)) as { symbol?: unknown; usdc?: unknown; user?: unknown } | null;
  const x = TRADABLE_XSTOCKS.find((t) => t.symbol === body?.symbol);
  if (!x) return fail("not a listed xStock", 404);
  // Adversary pass 5: never round or reinterpret money. Only a plain decimal with at most 6 places
  // ("1e2", "0x10", "1.0000005" are refused), converted with string arithmetic.
  // Codex T18d r4: a JSON number has already lost its spelling (1e2 arrives as 100), so only a
  // string is accepted.
  const typed = body?.usdc;
  const m = typeof typed === "string" ? /^(\d+)(?:\.(\d{1,6}))?$/.exec(typed.trim()) : null;
  if (!m) return fail("enter a plain USDC amount with at most 6 decimal places", 400);
  const micro = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  // Joshua: a judge can try a real buy for pocket change, so the minimum is 0.10 USDC.
  if (micro < 100_000n || micro > 100_000_000_000n) return fail("enter between 0.10 and 100,000 USDC", 400);
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
    const quote = (await q.json().catch(() => null)) as { inAmount?: unknown; outAmount?: unknown; otherAmountThreshold?: unknown; priceImpactPct?: unknown; outputMint?: unknown } | null;
    if (!q.ok || !quote) throw new Error("Jupiter found no route");
    if (quote.outputMint !== x.address) throw new Error("Jupiter quoted a different token");
    // B1 (fresh review r2, MAJOR): the quote must be for exactly the amount requested.
    if (quote.inAmount !== amount) throw new Error("Jupiter quoted a different amount");
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
    // Codex T18d final: resolve the lookup tables and check what each instruction does.
    const rpcUrl = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
    const tables = await fetchLookupTables(rpcUrl, check.tx);
    const keys = tables ? resolveKeys(check.tx, tables) : null;
    if (!keys) throw new Error("Jupiter's transaction could not be checked (lookup table unreadable)");
    const wrong = checkSwapAccounts(check.tx, keys, user, x.address);
    if (wrong) throw new Error(`Jupiter's transaction was refused: ${wrong}`);
    // B1 (fresh review r2, MAJOR): the transaction must spend exactly the requested amount and promise
    // exactly the quoted output, with the slippage asked for; otherwise the seal would fix a purchase the
    // buyer did not request. (Its route plan steps are not decoded: a stated limit.)
    const tail = jupiterRouteTail(check.tx, keys);
    if (!tail || tail.inAmount !== micro || tail.quotedOut !== BigInt(out) || tail.slippageBps !== 100) throw new Error("Jupiter's transaction does not match the quote");

    // B1: seal the exact message approved above; the relay recomputes it from the signed bytes.
    const seal = sealSwap({ message: check.tx.message.serialize(), buyer: user, symbol: x.symbol }, Math.floor(Date.now() / 1000));
    if (!seal) return fail("swap unavailable", 503);
    const built: SwapBuild = { tx: swap.swapTransaction, seal, lastValidBlockHeight: swap.lastValidBlockHeight, outRaw: out, minOutRaw: min, priceImpactPct: impact * 100, usdc: Number(micro) / 1_000_000 };
    return NextResponse.json(built, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const said = e instanceof Error ? e.message : String(e);
    return fail(/^Jupiter/.test(said) ? said : "swap unavailable");
  }
}
