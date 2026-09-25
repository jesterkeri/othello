/**
 * T18g: what a wallet can spend on Buy, read from Solana mainnet: its USDC (exact base units, as a
 * string) and its SOL (lamports, for fees). T18i (Joshua: "we are running everything in devnet"): also
 * the same wallet's DEVNET SOL and Othello test USDC, which the circle's actions spend. Read-only. The RPC URL stays on the server, and a failed
 * read says so in this route's own words.
 */
import { PublicKey } from "@solana/web3.js";
import { NextResponse, type NextRequest } from "next/server";

import { TEST_USDC } from "@/lib/devnet";

export const dynamic = "force-dynamic";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export type WalletFunds = {
  owner: string;
  /** Mainnet: what Buy spends. */
  usdcRaw: string;
  lamports: string;
  /** Jupiter's SOL price in USD (null if Jupiter had none), to value SOL in the portfolio total. */
  solUsd: number | null;
  /** Devnet: what the demo circle's actions spend (null if devnet could not be read). */
  devnet: { lamports: string; testUsdcRaw: string } | null;
  readAt: number;
};

/** getBalance's lamports, digit for digit from the raw reply (Codex T18d r5: JSON numbers above 2^53 lose digits). */
async function lamports(url: string, owner: string): Promise<string> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [owner, { commitment: "confirmed" }] }), cache: "no-store" }).catch(() => null);
  const text = res && res.ok ? await res.text().catch(() => "") : "";
  const m = /"value"\s*:\s*(\d+)/.exec(text);
  if (!m || /"error"/.test(text)) throw new Error("getBalance failed");
  return m[1]!;
}

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
      lamports(url, owner),
      rpc(url, "getTokenAccountsByOwner", [owner, { mint: USDC }, { encoding: "jsonParsed", commitment: "confirmed" }]) as Promise<{
        value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[];
      }>,
    ]);
    const usdc = accts.value.reduce((t, a) => t + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
    // Devnet is read separately: a devnet failure never hides the mainnet figures Buy needs.
    const dev = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
    const devnet = await Promise.all([
      lamports(dev, owner),
      rpc(dev, "getTokenAccountsByOwner", [owner, { mint: TEST_USDC }, { encoding: "jsonParsed", commitment: "confirmed" }]) as Promise<{
        value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[];
      }>,
    ])
      .then(([b, t]) => ({ lamports: b, testUsdcRaw: t.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n).toString() }))
      .catch(() => null);
    const SOL = "So11111111111111111111111111111111111111112";
    const solUsd = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, { usdPrice?: unknown } | undefined>>) : null))
      .then((j) => (j && typeof j[SOL]?.usdPrice === "number" && Number.isFinite(j[SOL]!.usdPrice) ? (j[SOL]!.usdPrice as number) : null))
      .catch(() => null);
    const body: WalletFunds = { owner, usdcRaw: usdc.toString(), lamports: bal, solUsd, devnet, readAt: Math.floor(Date.now() / 1000) };
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const said = e instanceof Error ? e.message : "";
    return NextResponse.json({ error: /^(getBalance|getTokenAccountsByOwner) failed$/.test(said) ? `mainnet ${said}` : "wallet balances unavailable" }, { status: 502 });
  }
}
