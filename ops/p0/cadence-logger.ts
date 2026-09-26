// P0.2 cadence + P0.1 secondary units check (read-only). Polls the seven xStocks' devnet shard-0
// PriceUpdateV2 accounts every 60 s. Whenever a feed's publish_time changes, appends one JSON line with
// the full decode, and Jupiter's per-displayed-unit price and per-raw price (a sale of exactly
// 100,000,000 raw base units) for the real mainnet mint, plus its multiplier at that second.
// Run (background, >= 48 h): npx tsx ops/p0/cadence-logger.ts reviews/p0-evidence/cadence.jsonl
import { appendFileSync } from "node:fs";

import * as anchor from "@coral-xyz/anchor";

import { decodePriceUpdateV2, feedId, SEVEN, shard0, toNum } from "./pyth";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const out = process.argv[2] ?? "reviews/p0-evidence/cadence.jsonl";
const devnet = new anchor.web3.Connection("https://api.devnet.solana.com", "confirmed");

type Live = { mints: { symbol: string; address: string; multiplierNow: number }[] };

async function jupiter(mint: string) {
  try {
    const p = (await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { headers: { "user-agent": "othello-p0" } })).json()) as Record<string, { usdPrice: number }>;
    const q = (await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${USDC}&amount=100000000&slippageBps=50`)).json()) as { outAmount?: string };
    return { perDisplayedUnit: p[mint]?.usdPrice ?? null, perRawToken: q.outAmount ? Number(q.outAmount) / 1e6 : null };
  } catch (e) { return { error: String(e) }; }
}

async function main() {
  const ids = Object.fromEntries(await Promise.all(SEVEN.map(async (s) => [s, await feedId(s)] as const)));
  const last: Record<string, number> = {};
  for (;;) {
    try {
      const keys = SEVEN.map((s) => shard0(ids[s]));
      const infos = await devnet.getMultipleAccountsInfo(keys);
      const changed = SEVEN.filter((s, i) => {
        const info = infos[i];
        if (!info) return false;
        const u = decodePriceUpdateV2(info.owner.toBase58(), info.data as Buffer);
        return u.publishTime !== last[s];
      });
      if (changed.length) {
        const live = (await (await fetch("https://othello-circle.vercel.app/api/live")).json()) as Live;
        for (const s of changed) {
          const i = SEVEN.indexOf(s);
          const info = infos[i]!;
          const u = decodePriceUpdateV2(info.owner.toBase58(), info.data as Buffer);
          const gapS = last[s] === undefined ? null : u.publishTime - last[s];
          last[s] = u.publishTime;
          const m = live.mints.find((x) => x.symbol === s);
          const row = {
            observedAt: new Date().toISOString(), symbol: s, account: keys[i].toBase58(), owner: u.owner,
            verification: u.verification, feedMatches: u.feedId === ids[s], exponent: u.exponent,
            price: toNum(u.price, u.exponent), conf: toNum(u.conf, u.exponent),
            publishTime: new Date(u.publishTime * 1000).toISOString(), gapSinceLastSeenS: gapS,
            postedSlot: u.postedSlot.toString(), writeAuthority: u.writeAuthority,
            multiplierNow: m?.multiplierNow ?? null, jupiter: m ? await jupiter(m.address) : null,
          };
          appendFileSync(out, JSON.stringify(row) + "\n");
        }
      }
    } catch (e) {
      appendFileSync(out, JSON.stringify({ observedAt: new Date().toISOString(), error: String(e) }) + "\n");
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

main();
