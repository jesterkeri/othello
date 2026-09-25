/**
 * T18g: relays a buyer-signed Jupiter swap to Solana mainnet through the server's RPC and waits for
 * it to confirm. It relays nothing else: the bytes must decode, fit a packet, be paid for and signed
 * by the stated wallet, and invoke only Jupiter and its housekeeping programs (lib/swap.ts). Neither the
 * RPC URL nor any provider text reaches the browser: errors are this route's own fixed words.
 */
import { NextResponse, type NextRequest } from "next/server";

import { checkSwapTx } from "@/lib/swap";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type SwapSent = { signature: string; status: "confirmed" | "failed" | "expired"; error?: string };

function fail(error: string, status = 502) {
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), cache: "no-store" }).catch(() => null);
  if (!res) throw new Error(`${method}: mainnet RPC unreachable`);
  const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
  if (!res.ok || !body) throw new Error(`${method}: mainnet RPC answered ${res.status}`);
  // The message is used only to classify the failure (the route never returns it).
  if (body.error) throw new Error(`${method}: ${String(body.error.message ?? "refused").slice(0, 300)}`);
  return body.result;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { tx?: unknown; user?: unknown; lastValidBlockHeight?: unknown } | null;
  const lvbh = Number(body?.lastValidBlockHeight);
  if (!Number.isSafeInteger(lvbh) || lvbh <= 0) return fail("missing lastValidBlockHeight", 400);
  let check;
  try {
    check = checkSwapTx(String(body?.tx ?? ""), String(body?.user ?? ""), true);
  } catch {
    return fail("not a wallet address", 400);
  }
  if (!check.ok) return fail(`refused: ${check.reason}`, 400);

  const url = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
  try {
    const signature = (await rpc(url, "sendTransaction", [body!.tx, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }])) as string;
    const deadline = Date.now() + 50_000;
    while (Date.now() < deadline) {
      const st = (await rpc(url, "getSignatureStatuses", [[signature]])) as { value: ({ err: unknown; confirmationStatus?: string } | null)[] };
      const s = st.value[0];
      if (s?.err) return NextResponse.json({ signature, status: "failed", error: JSON.stringify(s.err) } satisfies SwapSent);
      if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return NextResponse.json({ signature, status: "confirmed" } satisfies SwapSent);
      const height = (await rpc(url, "getBlockHeight", [{ commitment: "confirmed" }])) as number;
      if (height > lvbh) return NextResponse.json({ signature, status: "expired", error: "the transaction's blockhash expired before it landed" } satisfies SwapSent);
      await new Promise((r) => setTimeout(r, 1500));
    }
    return NextResponse.json({ signature, status: "expired", error: "not confirmed within 50 seconds; check the explorer" } satisfies SwapSent);
  } catch (e) {
    // Codex T18d r4: no provider text reaches the browser at all (a credential of any length could be
    // in it). Only the method and a fixed description of what went wrong.
    const said = e instanceof Error ? e.message : String(e);
    const method = /^(sendTransaction|getSignatureStatuses|getBlockHeight):/.exec(said)?.[1];
    if (!method) return fail("relay unavailable");
    const why = /insufficient|0x1\b|not enough/i.test(said)
      ? "not enough funds in the wallet (USDC for the swap, SOL for the fee)"
      : /blockhash/i.test(said)
        ? "the quote expired before it landed; try again"
        : /slippage|0x1771|6001/i.test(said)
          ? "the price moved beyond the 1% slippage; try again"
          : /simulat/i.test(said)
            ? "the network's simulation of the swap failed"
            : "the network refused it";
    return fail(`${method}: ${why}`);
  }
}
