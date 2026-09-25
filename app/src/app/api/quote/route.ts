/**
 * Buy: a live Jupiter quote for USDC into one listed xStock (mainnet), read on the server. Read-only:
 * no transaction is built here; the buyer completes it on Jupiter, in their own wallet.
 */
import { NextResponse, type NextRequest } from "next/server";

import { TRADABLE_XSTOCKS } from "@/lib/xstocks";

export const dynamic = "force-dynamic";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type Quote = { symbol: string; usdc: number; outRaw: string; priceImpactPct: number; route: string[]; slippageBps: number };

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol") ?? "";
  const usdc = Number(req.nextUrl.searchParams.get("usdc"));
  const x = TRADABLE_XSTOCKS.find((t) => t.symbol === symbol);
  if (!x) return NextResponse.json({ error: "not a listed xStock" }, { status: 404 });
  if (!Number.isFinite(usdc) || usdc < 1 || usdc > 100_000) return NextResponse.json({ error: "enter between 1 and 100,000 USDC" }, { status: 400 });

  const amount = Math.round(usdc * 1_000_000);
  const slippageBps = 100;
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${USDC}&outputMint=${x.address}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  try {
    const res = await fetch(url, { cache: "no-store" }).catch(() => null);
    if (!res) throw new Error("Jupiter unreachable");
    const q = (await res.json().catch(() => null)) as {
      outAmount?: string;
      priceImpactPct?: string;
      routePlan?: { swapInfo?: { label?: string } }[];
      error?: string;
    } | null;
    if (!res.ok || !q?.outAmount) throw new Error(q?.error ? "Jupiter found no route" : `Jupiter answered ${res.status}`);
    const body: Quote = {
      symbol,
      usdc,
      outRaw: q.outAmount,
      priceImpactPct: Number(q.priceImpactPct ?? 0) * 100,
      route: (q.routePlan ?? []).map((r) => r.swapInfo?.label ?? "?"),
      slippageBps,
    };
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
