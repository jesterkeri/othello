/**
 * T18g: what a wallet can spend on Buy, read from Solana mainnet: its USDC (exact base units, as a
 * string) and its SOL (lamports, for fees). Read-only. The RPC URL stays on the server, and a failed
 * read says so in this route's own words.
 */
import { PublicKey } from "@solana/web3.js";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type WalletFunds = { owner: string; usdcRaw: string; lamports: string; readAt: number };

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), cache: "no-store" }).catch(() => null);
  const body = res ? ((await res.json().catch(() => null)) as { result?: unknown; error?: unknown } | null) : null;
  if (!res || !res.ok || !body || body.error || body.result === undefined) throw new Error(`${method} failed`);
  return body.result;
}

export async function GET(req: NextRequest) {
  let owner: string;
  try {
    owner = new PublicKey(req.nextUrl.searchParams.get("owner") ?? "").toBase58();
  } catch {
    return NextResponse.json({ error: "not a wallet address" }, { status: 400 });
  }
  const url = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
  try {
    const [bal, accts] = await Promise.all([
      rpc(url, "getBalance", [owner, { commitment: "confirmed" }]) as Promise<{ value: number }>,
      rpc(url, "getTokenAccountsByOwner", [owner, { mint: USDC }, { encoding: "jsonParsed", commitment: "confirmed" }]) as Promise<{
        value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[];
      }>,
    ]);
    const usdc = accts.value.reduce((t, a) => t + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    const body: WalletFunds = { owner, usdcRaw: usdc.toString(), lamports: String(bal.value), readAt: Math.floor(Date.now() / 1000) };
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const said = e instanceof Error ? e.message : "";
    return NextResponse.json({ error: /^(getBalance|getTokenAccountsByOwner) failed$/.test(said) ? `mainnet ${said}` : "wallet balances unavailable" }, { status: 502 });
  }
}
