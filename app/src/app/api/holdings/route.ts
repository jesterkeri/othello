/**
 * Portfolio: what one wallet holds, read on the server (keyed RPC URLs stay server-only).
 *
 * - xStocks on MAINNET: every Token-2022 account the wallet owns whose mint is a listed xStock
 *   (lib/xstocks.ts), with the raw amount, the amount as wallets display it (raw x the mint's
 *   multiplier in force), and a value at Jupiter's price per displayed token when Jupiter has one.
 * - The demo's tokens on DEVNET: the NFLXx mirror and test USDC in the same wallet.
 * Public data only: a wallet address in, balances out. A failed read is a 502 with this route's own
 * words; no number is ever filled in.
 */
import { NextResponse, type NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { NFLXX_MIRROR, TEST_USDC } from "@/lib/devnet";
import { multiplierAt, readScaledUi } from "@/lib/scaledUi";
import { TRADABLE_XSTOCKS } from "@/lib/xstocks";

export const dynamic = "force-dynamic";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type Holding = { symbol: string; name: string; address: string; raw: string; decimals: number; shown: number; usdValue: number | null; multiplier: number };
export type Holdings = {
  owner: string;
  readAt: number;
  xstocks: Holding[];
  devnet: { mirrorRaw: string; testUsdc: string };
};

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  }).catch(() => null);
  if (!res || !res.ok) throw new Error(`${method} failed`);
  const body = (await res.json().catch(() => null)) as { result?: unknown } | null;
  if (!body || body.result === undefined) throw new Error(`${method} returned no result`);
  return body.result;
}

type ParsedAccount = { account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number } } } } } };

async function balances(url: string, owner: string, filter: object): Promise<ParsedAccount[]> {
  const r = (await rpc(url, "getTokenAccountsByOwner", [owner, filter, { encoding: "jsonParsed", commitment: "confirmed" }])) as { value: ParsedAccount[] };
  return r.value;
}

export async function GET(req: NextRequest) {
  const owner = req.nextUrl.searchParams.get("owner") ?? "";
  try {
    new PublicKey(owner);
  } catch {
    return NextResponse.json({ error: "not a wallet address" }, { status: 400 });
  }
  const mainnet = process.env.MAINNET_RPC_URL || "https://api.mainnet-beta.solana.com";
  const devnet = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";

  try {
    const listed = new Map(TRADABLE_XSTOCKS.map((x) => [x.address, x]));
    const accounts = (await balances(mainnet, owner, { programId: TOKEN_2022 })).filter(
      (a) => listed.has(a.account.data.parsed.info.mint) && a.account.data.parsed.info.tokenAmount.amount !== "0",
    );
    const mints = [...new Set(accounts.map((a) => a.account.data.parsed.info.mint))];

    // The multiplier in force, from each mint itself; prices from Jupiter.
    const now = Math.floor(Date.now() / 1000);
    const mult = new Map<string, number>();
    if (mints.length) {
      const infos = (await rpc(mainnet, "getMultipleAccounts", [mints, { encoding: "base64" }])) as { value: ({ data: [string, string] } | null)[] };
      infos.value.forEach((acc, i) => {
        const s = acc ? readScaledUi(Buffer.from(acc.data[0], "base64")) : null;
        if (s) mult.set(mints[i]!, multiplierAt(s, now));
      });
    }
    let prices: Record<string, { usdPrice?: number } | undefined> = {};
    if (mints.length) {
      prices = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mints.join(",")}`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}));
    }

    const byMint = new Map<string, bigint>();
    let decimals = 8;
    for (const a of accounts) {
      const i = a.account.data.parsed.info;
      byMint.set(i.mint, (byMint.get(i.mint) ?? 0n) + BigInt(i.tokenAmount.amount));
      decimals = i.tokenAmount.decimals;
    }
    const xstocks: Holding[] = [...byMint.entries()].map(([mint, raw]) => {
      const x = listed.get(mint)!;
      const m = mult.get(mint);
      if (m === undefined) throw new Error(`could not read ${x.symbol}'s multiplier`);
      const shown = (Number(raw) / 10 ** decimals) * m;
      const p = prices[mint]?.usdPrice;
      return { symbol: x.symbol, name: x.name, address: mint, raw: raw.toString(), decimals, shown, multiplier: m, usdValue: Number.isFinite(p) ? shown * p! : null };
    });

    const [mirror, usdc] = await Promise.all([
      balances(devnet, owner, { mint: NFLXX_MIRROR }),
      balances(devnet, owner, { mint: TEST_USDC }),
    ]);
    const sum = (xs: ParsedAccount[]) => xs.reduce((t, a) => t + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n).toString();

    const body: Holdings = { owner, readAt: now, xstocks: xstocks.sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0)), devnet: { mirrorRaw: sum(mirror), testUsdc: sum(usdc) } };
    return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const said = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: /^(getTokenAccountsByOwner|getMultipleAccounts|could not read)/.test(said) ? said : "holdings unavailable" }, { status: 502 });
  }
}
