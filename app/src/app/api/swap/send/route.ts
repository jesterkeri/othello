/**
 * T18g: relays a buyer-signed Jupiter swap to Solana mainnet through the server's RPC and waits for
 * it to confirm. It relays nothing else: the bytes must decode, fit a packet, be paid for and signed
 * by the stated wallet, and invoke only Jupiter and its housekeeping programs (lib/swap.ts). Neither the
 * RPC URL nor any provider text reaches the browser: errors are this route's own fixed words.
 *
 * It relays only a transaction /api/swap sealed (lib/swapSeal.ts) and signed Solana-strictly by the fee payer.
 * Security boundary: the buyer's wallet signature is the authorisation; this relay is a convenience and does
 * not defend against a compromised browser or wallet (see lib/swapSeal.ts).
 */
import { NextResponse, type NextRequest } from "next/server";

import { checkSwapAccounts, checkSwapTx, fetchLookupTables, resolveKeys, signedTransactionSignature } from "@/lib/swap";
import { sealConfigured, verifySeal } from "@/lib/swapSeal";
import { TRADABLE_XSTOCKS } from "@/lib/xstocks";

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
  if (!sealConfigured()) return fail("relay unavailable", 503);
  const body = (await req.json().catch(() => null)) as { tx?: unknown; seal?: unknown; user?: unknown; lastValidBlockHeight?: unknown; symbol?: unknown } | null;
  // Codex T18d final: the relay checks the listed stock's mint too, from the registry, never the request.
  const listed = TRADABLE_XSTOCKS.find((t) => t.symbol === body?.symbol);
  if (!listed) return fail("not a listed xStock", 400);
  const lvbh = Number(body?.lastValidBlockHeight);
  if (!Number.isSafeInteger(lvbh) || lvbh <= 0) return fail("missing lastValidBlockHeight", 400);
  // B1 seal adversary: the buyer must be a plain string, never coerced from an array or object.
  if (typeof body?.user !== "string") return fail("not a wallet address", 400);
  let check;
  try {
    check = checkSwapTx(String(body?.tx ?? ""), body.user, true);
  } catch {
    return fail("not a wallet address", 400);
  }
  if (!check.ok) return fail(`refused: ${check.reason}`, 400);
  // B1 (Codex fresh review, MAJOR): relay only the exact message /api/swap built and sealed for this
  // buyer and symbol, unexpired. Signing never changes the message, so the signed bytes must match it.
  if (!verifySeal(body?.seal, { message: check.tx.message.serialize(), buyer: String(body?.user), symbol: listed.symbol }, Math.floor(Date.now() / 1000))) {
    return fail("refused: this is not the swap Othello built for you, or it expired; start the buy again", 400);
  }

  const url = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
  const tables = await fetchLookupTables(url, check.tx);
  const keys = tables ? resolveKeys(check.tx, tables) : null;
  if (!keys) return fail("refused: the transaction could not be checked (lookup table unreadable)", 400);
  const wrong = checkSwapAccounts(check.tx, keys, String(body!.user), listed.address);
  if (wrong) return fail(`refused: ${wrong}`, 400);
  const signature = signedTransactionSignature(check.tx);
  if (!signature) return fail("refused: the transaction is not signed by this wallet", 400);
  try {
    // Relay the checked transaction re-serialized, never the raw request bytes: what is sent is exactly
    // what the seal, signature and account checks covered.
    const checkedBytes = Buffer.from(check.tx.serialize()).toString("base64");
    const rpcSignature = await rpc(url, "sendTransaction", [checkedBytes, { encoding: "base64", skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 }]);
    // The network may only confirm the bytes we decoded. Its reply is checked but never becomes the
    // browser-visible identifier, so arbitrary provider text cannot be substituted for this signature.
    if (rpcSignature !== signature) return fail("sendTransaction: the network returned a different signature");
    const deadline = Date.now() + 50_000;
    while (Date.now() < deadline) {
      const st = (await rpc(url, "getSignatureStatuses", [[signature]])) as { value: ({ err: unknown; confirmationStatus?: string } | null)[] };
      const s = st.value[0];
      // Codex T18d r5: no provider text, even the chain's error object: fixed words and a number.
      if (s?.err) {
        const code = /"Custom":\s*(\d+)/.exec(JSON.stringify(s.err))?.[1];
        return NextResponse.json({ signature, status: "failed", error: code ? `the swap failed on chain (program error ${code})` : "the swap failed on chain" } satisfies SwapSent);
      }
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
