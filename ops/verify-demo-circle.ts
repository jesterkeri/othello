/**
 * Reads the seeded demo circle back from devnet in ONE request and prints what
 * the chain says (T24 evidence). Read-only: no key, no signing.
 *
 *   pnpm tsx ops/verify-demo-circle.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import { SPL_TOKEN, TOKEN_2022, ataAddress } from "./devnet-mints.ts";

const REPO = resolve(import.meta.dirname, "..");
const rec = JSON.parse(readFileSync(resolve(import.meta.dirname, "demo-circle.json"), "utf8")) as {
  program: string; circle: string; members: string[]; pool: string; priceFeed: string; stockMint: string; usdcMint: string;
};
const idl = JSON.parse(readFileSync(resolve(REPO, "target/idl/othello.json"), "utf8")) as anchor.Idl;
const c = new anchor.web3.Connection(process.env.SOLANA_RPC ?? "https://api.devnet.solana.com", "confirmed");
// Through a Program so account names and fields are the camelCase the rest of ops/ uses.
const coder = new anchor.Program(idl, { connection: c } as anchor.Provider).coder.accounts;
const pk = (s: string) => new anchor.web3.PublicKey(s);
const programId = pk(rec.program);
const circle = pk(rec.circle);
const stock = pk(rec.stockMint);
const usdc = pk(rec.usdcMint);
const memberPda = (w: string) => anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("member"), circle.toBuffer(), pk(w).toBuffer()], programId)[0];

const keys = [
  circle,
  pk(rec.priceFeed),
  ataAddress(stock, circle, TOKEN_2022),
  ataAddress(usdc, circle, SPL_TOKEN),
  ataAddress(usdc, pk(rec.pool), SPL_TOKEN),
  ...rec.members.map(memberPda),
];
const infos = await c.getMultipleAccountsInfo(keys);
const amount = (i: number) => infos[i]!.data.readBigUInt64LE(64);

const ci = coder.decode("circle", infos[0]!.data);
const feed = coder.decode("priceFeed", infos[1]!.data);
console.log("circle", rec.circle, "status", Object.keys(ci.status)[0], "round", ci.round, "n", ci.n, "joined_bitmap", ci.joinedBitmap.toString(2));
console.log("  contribution", ci.contribution.toString(), "guarantee", ci.guaranteePerMember.toString(), "round_secs", ci.roundSecs.toString(), "deadline", new Date(ci.roundDeadline.toNumber() * 1000).toISOString());
console.log("feed wrapper", feed.wrapperPrice.toString(), "share", feed.sharePrice.toString(), "priced_for", feed.pricedForMultiplier.toString(), "updated", new Date(feed.updatedAt.toNumber() * 1000).toISOString());
console.log("circle stock vault", amount(2).toString(), "raw  circle usdc vault", amount(3).toString(), "  pool usdc", amount(4).toString());
rec.members.forEach((w, i) => {
  const m = coder.decode("member", infos[5 + i]!.data);
  console.log(`member ${i + 1} ${w} turn ${m.turn} stock_raw ${m.stockRaw.toString()}`);
});
