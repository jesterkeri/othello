// P0.1 units probe (read-only). NFLXx's Token-2022 multiplier is 10 since its 10-for-1 split, so a
// per-share price and a per-raw-token price differ tenfold. Compares Pyth's Crypto.NFLXX/USD (mainnet
// shard-0 account) with (a) Jupiter now, per displayed unit and per raw token (a sale of exactly
// 100,000,000 raw base units = 1 whole raw token), and (b) GeckoTerminal's per-raw daily candle on the
// day of Pyth's last publish. Run: npx tsx ops/p0/units-nflxx.ts
import { readFileSync } from "node:fs";

import * as anchor from "@coral-xyz/anchor";

import { decodePriceUpdateV2, feedId, RECEIVER, shard0, toNum } from "./pyth";

const NFLXX = "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Token-2022 ScaledUiAmountConfig (extension type 25, 56 bytes: authority, multiplier f64, timestamp i64, new f64). */
function scaledUiConfig(d: Buffer): { multiplier: number; effectiveAt: number; newMultiplier: number } | null {
  for (let o = 166; o + 4 <= d.length; ) {
    const type = d.readUInt16LE(o), len = d.readUInt16LE(o + 2);
    if (type === 25 && len === 56) return { multiplier: d.readDoubleLE(o + 4 + 32), effectiveAt: Number(d.readBigInt64LE(o + 4 + 40)), newMultiplier: d.readDoubleLE(o + 4 + 48) };
    if (type === 0 && len === 0) break;
    o += 4 + len;
  }
  return null;
}

async function main() {
  const conn = new anchor.web3.Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const id = await feedId("NFLXx");
  const acct = shard0(id);
  const info = await conn.getAccountInfo(acct);
  if (!info) throw new Error("no NFLXX account");
  const u = decodePriceUpdateV2(info.owner.toBase58(), info.data as Buffer);
  if (u.owner !== RECEIVER.toBase58() || u.feedId !== id) throw new Error("owner or feed mismatch");
  const pyth = toNum(u.price, u.exponent);
  const day = new Date(u.publishTime * 1000).toISOString().slice(0, 10);

  const live = (await (await fetch("https://othello-circle.vercel.app/api/live")).json()) as {
    mints: { address: string; multiplierNow: number; multiplier: number; newMultiplier: number; effectiveAt: number }[];
  };
  const mult = live.mints.find((x) => x.address === NFLXX)?.multiplierNow;
  // P0 review r2 (MAJOR 4): the multiplier on the candle day comes from SAVED mint bytes decoded here, never from
  // an application endpoint. Two dated snapshots: the repo's T00 fixture and units-nflxx-mint.json. A Token-2022
  // mint overwrites its ScaledUiAmountConfig timestamp on every UpdateMultiplier, so a snapshot whose last change
  // predates the candle day proves no change between that change and the snapshot (issuer trusted not to backdate).
  const candleDayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
  const snapshots = ["tests/fixtures/NFLXx.json", "reviews/p0-evidence/units-nflxx-mint.json"].map((path) => {
    const f = JSON.parse(readFileSync(path, "utf8")) as { dataBase64: string; slot?: number; fetchedAtSlot?: number; fetchedAt: string };
    return { path, slot: f.slot ?? f.fetchedAtSlot, fetchedAt: f.fetchedAt, config: scaledUiConfig(Buffer.from(f.dataBase64, "base64")) };
  });
  const consistent = snapshots.every((x) => x.config && x.config.effectiveAt < candleDayStart && Date.parse(x.fetchedAt) / 1000 > candleDayStart);
  const multiplierInForceOnCandleDay = consistent ? snapshots[0]!.config!.newMultiplier : null;
  const perUi = ((await (await fetch(`https://lite-api.jup.ag/price/v3?ids=${NFLXX}`, { headers: { "user-agent": "othello-p0" } })).json()) as Record<string, { usdPrice: number }>)[NFLXX].usdPrice;
  const q = (await (await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${NFLXX}&outputMint=${USDC}&amount=100000000&slippageBps=50`)).json()) as { outAmount: string };
  const perRaw = Number(q.outAmount) / 1e6;

  const chart = (await (await fetch("https://othello-circle.vercel.app/api/chart?symbol=NFLXx")).json()) as {
    displayed: unknown; pool: { address: string }; [k: string]: unknown;
  };
  const candles = Object.values(chart).find(Array.isArray) as { t: number; o: number; c: number }[];
  const candle = candles.find((c) => new Date(c.t * 1000).toISOString().slice(0, 10) === day);

  console.log(JSON.stringify({
    sampledAt: new Date().toISOString(),
    pyth: { account: acct.toBase58(), owner: u.owner, verification: u.verification, feedId: u.feedId,
      price: pyth, conf: toNum(u.conf, u.exponent), exponent: u.exponent, publishTime: new Date(u.publishTime * 1000).toISOString() },
    mint: { address: NFLXX, multiplierNow: mult, snapshots: snapshots.map((x) => ({ path: x.path, slot: x.slot, fetchedAt: x.fetchedAt, lastChange: x.config ? { from: x.config.multiplier, to: x.config.newMultiplier, effectiveAt: new Date(x.config.effectiveAt * 1000).toISOString() } : null })), multiplierInForceOnCandleDay },
    jupiterNow: { perDisplayedUnit: perUi, perRawToken_sell_1e8_raw: perRaw },
    geckoTerminalSameDay: candle ? { day, pool: chart.pool.address, perRawOpen: candle.o, perRawClose: candle.c,
      perShareOpen: candle.o / (multiplierInForceOnCandleDay ?? NaN), perShareClose: candle.c / (multiplierInForceOnCandleDay ?? NaN) } : null,
    ratios: {
      pythOverJupiterPerUi: pyth / perUi,
      pythOverJupiterPerRaw: pyth / perRaw,
      pythOverSameDayPerRawClose: candle ? pyth / candle.c : null,
      pythOverSameDayPerShareClose: candle && multiplierInForceOnCandleDay ? pyth / (candle.c / multiplierInForceOnCandleDay) : null,
    },
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
