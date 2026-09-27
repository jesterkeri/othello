// P0.2 cadence + P0.1 secondary units check (read-only). Polls the seven xStocks' devnet shard-0
// PriceUpdateV2 accounts every 60 s. Whenever a feed's publish_time changes, appends one JSON line with
// the full decode, and Jupiter's per-displayed-unit price and per-raw price (a sale of exactly
// 100,000,000 raw base units) for the real mainnet mint, plus its multiplier at that second.
// Run (background, >= 48 h): npx tsx ops/p0/cadence-logger.ts reviews/p0-evidence/cadence.jsonl
// v2 (P0 review r1): a heartbeat row every 15 minutes proves the logger was still polling when nothing
// changed, and each heartbeat keeps the raw account bytes (base64) so any age claim can be re-derived.
// v3 (P0 review r3): every network call is bounded (15 s), and the heartbeat depends only on the devnet
// account read, never on the optional pricing calls, so a hung request cannot silence it.
import { appendFileSync } from "node:fs";

import * as anchor from "@coral-xyz/anchor";

import { decodePriceUpdateV2, feedId, SEVEN, shard0, toNum } from "./pyth";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const out = process.argv[2] ?? "reviews/p0-evidence/cadence.jsonl";
const TIMEOUT_MS = 15_000;
const bounded: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
const devnet = new anchor.web3.Connection("https://api.devnet.solana.com", { commitment: "confirmed", fetch: bounded });

type Live = { mints: { symbol: string; address: string; multiplierNow: number }[] };

async function jupiter(mint: string) {
  try {
    const p = (await (await bounded(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { headers: { "user-agent": "othello-p0" } })).json()) as Record<string, { usdPrice: number }>;
    const q = (await (await bounded(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${mint}&outputMint=${USDC}&amount=100000000&slippageBps=50`)).json()) as { outAmount?: string };
    return { perDisplayedUnit: p[mint]?.usdPrice ?? null, perRawToken: q.outAmount ? Number(q.outAmount) / 1e6 : null };
  } catch (e) { return { error: String(e) }; }
}

async function main() {
  const ids = Object.fromEntries(await Promise.all(SEVEN.map(async (s) => [s, await feedId(s)] as const)));
  const last: Record<string, number> = {};
  let lastBeat = 0;
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
      if (Date.now() - lastBeat >= 15 * 60_000) {
        lastBeat = Date.now();
        const slot = await devnet.getSlot().catch(() => null);
        appendFileSync(out, JSON.stringify({
          observedAt: new Date().toISOString(), heartbeat: true, slot,
          accounts: SEVEN.map((s, i) => ({ symbol: s, account: keys[i].toBase58(), owner: infos[i]?.owner.toBase58() ?? null, dataBase64: infos[i] ? Buffer.from(infos[i]!.data).toString("base64") : null })),
        }) + "\n");
      }
      if (changed.length) {
        const live = ((await (await bounded("https://othello-circle.vercel.app/api/live")).json().catch(() => null)) ?? { mints: [] }) as Live;
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
