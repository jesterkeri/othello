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

  // Codex T18c r1: quote and report the SAME amount. The micro-USDC integer sent to Jupiter is the
  // canonical figure; the USDC shown back is derived from it (1.0000004 is quoted and shown as 1).
  const amount = Math.round(usdc * 1_000_000);
  const slippageBps = 100;
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${USDC}&outputMint=${x.address}&amount=${amount}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`;
  try {
    const res = await fetch(url, { cache: "no-store" }).catch(() => null);
    if (!res) throw new Error("Jupiter unreachable");
    const q = (await res.json().catch(() => null)) as {
      outAmount?: unknown;
      priceImpactPct?: unknown;
      routePlan?: unknown;
      error?: string;
    } | null;
    if (!res.ok) throw new Error(q?.error ? "Jupiter found no route" : `Jupiter answered ${res.status}`);
    // Codex T18c r1: a quote missing any fact is not shown with a default in its place. Every field
    // the panel prints must come from Jupiter, well-formed, or there is no quote.
    const out = typeof q?.outAmount === "string" && /^[0-9]+$/.test(q.outAmount) && BigInt(q.outAmount) > 0n ? q.outAmount : null;
    // Codex T18c r2: Number(" ") is 0, so a blank impact passed as zero. The impact must be a real
    // decimal numeral (or a finite number), and every route label must have visible text.
    const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
    const rawImpact = q?.priceImpactPct;
    const impact =
      typeof rawImpact === "number" ? rawImpact : typeof rawImpact === "string" && DECIMAL.test(rawImpact) ? Number(rawImpact) : Number.NaN;
    const plan = Array.isArray(q?.routePlan) ? (q!.routePlan as { swapInfo?: { label?: unknown } }[]) : [];
    const route = plan
      .map((r) => r?.swapInfo?.label)
      // Codex T18c r3/r4: whitespace, zero-width and control characters all render blank. Rather
      // than list every invisible class, a label must contain a letter, number, punctuation mark or
      // symbol.
      .filter((l): l is string => typeof l === "string" && /[\p{L}\p{N}\p{P}\p{S}]/u.test(l))
      .map((l) => l.trim());
    if (!out || !Number.isFinite(impact) || impact < 0 || plan.length === 0 || route.length !== plan.length) {
      throw new Error("Jupiter returned an incomplete quote");
    }
    const body: Quote = {
      symbol,
      usdc: amount / 1_000_000,
      outRaw: out,
      priceImpactPct: impact * 100,
      route,
      slippageBps,
    };
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    // Only this route's own words reach the browser; anything else (an engine TypeError on an odd
    // upstream body) is summarised.
    const said = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: /^(Jupiter)/.test(said) ? said : "price data unavailable" }, { status: 502 });
  }
}
