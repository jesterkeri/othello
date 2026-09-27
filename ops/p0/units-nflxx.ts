// P0.1 units probe (read-only). NFLXx's Token-2022 multiplier is 10 since its 10-for-1 split, so a
// per-share price and a per-raw-token price differ tenfold. Compares Pyth's Crypto.NFLXX/USD (mainnet
// shard-0 account) with (a) Jupiter now, per displayed unit and per raw token (a sale of exactly
// 100,000,000 raw base units = 1 whole raw token), and (b) GeckoTerminal's per-raw daily candle on the
// day of Pyth's last publish. Run: npx tsx ops/p0/units-nflxx.ts
import * as anchor from "@coral-xyz/anchor";

import { decodePriceUpdateV2, feedId, RECEIVER, shard0, toNum } from "./pyth";

const NFLXX = "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

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
  const m = live.mints.find((x) => x.address === NFLXX);
  const mult = m?.multiplierNow;
  // P0 review r1 (MINOR): the multiplier must be the one in force on the candle's day, not only today's.
  // A Token-2022 mint keeps only its latest scheduled change, so if that change took effect before the candle
  // day and is the current value, it was in force that day (a later change would carry a later timestamp).
  const candleDayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
  const multiplierInForceOnCandleDay = m && m.effectiveAt < candleDayStart && m.newMultiplier === m.multiplierNow ? m.multiplierNow : null;
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
    mint: { address: NFLXX, multiplierNow: mult, lastChange: m ? { from: m.multiplier, to: m.newMultiplier, effectiveAt: new Date(m.effectiveAt * 1000).toISOString() } : null, multiplierInForceOnCandleDay },
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
