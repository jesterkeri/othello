// P0 evidence helpers (read-only). Derives Pyth's shard-0 price-update account for a feed and decodes
// a PriceUpdateV2 account completely, so the probes can show every field they rely on. Layout from
// pyth-crosschain target_chains/solana/pyth_solana_receiver_sdk/src/price_update.rs:49-59 and
// pythnet_sdk messages.rs (PriceFeedMessage). Not product code: the program will use the SDK (P0.3).
import * as anchor from "@coral-xyz/anchor";

const { PublicKey } = anchor.web3;

export const PUSH_ORACLE = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
export const RECEIVER = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
export const PRICE_UPDATE_V2_DISC = "22f123639d7ef4cd";

export const SEVEN = ["AAPLx", "AMZNx", "GOOGLx", "METAx", "MSFTx", "NVDAx", "TSLAx"] as const;

export function shard0(feedIdHex: string): anchor.web3.PublicKey {
  const shard = Buffer.alloc(2); // u16 LE shard id 0
  return PublicKey.findProgramAddressSync([shard, Buffer.from(feedIdHex, "hex")], PUSH_ORACLE)[0];
}

export type PriceUpdateV2 = {
  owner: string; length: number; discriminator: string; writeAuthority: string;
  verification: "Full" | `Partial(${number})`;
  feedId: string; price: bigint; conf: bigint; exponent: number;
  publishTime: number; prevPublishTime: number; emaPrice: bigint; emaConf: bigint; postedSlot: bigint;
};

export function decodePriceUpdateV2(owner: string, d: Buffer): PriceUpdateV2 {
  let o = 0;
  const discriminator = d.subarray(o, o + 8).toString("hex"); o += 8;
  const writeAuthority = new PublicKey(d.subarray(o, o + 32)).toBase58(); o += 32;
  const tag = d[o]; o += 1;
  let verification: PriceUpdateV2["verification"];
  if (tag === 1) verification = "Full";
  else if (tag === 0) { verification = `Partial(${d[o]})`; o += 1; }
  else throw new Error(`unknown verification tag ${tag}`);
  const feedId = d.subarray(o, o + 32).toString("hex"); o += 32;
  const price = d.readBigInt64LE(o); o += 8;
  const conf = d.readBigUInt64LE(o); o += 8;
  const exponent = d.readInt32LE(o); o += 4;
  const publishTime = Number(d.readBigInt64LE(o)); o += 8;
  const prevPublishTime = Number(d.readBigInt64LE(o)); o += 8;
  const emaPrice = d.readBigInt64LE(o); o += 8;
  const emaConf = d.readBigUInt64LE(o); o += 8;
  const postedSlot = d.readBigUInt64LE(o); o += 8;
  return { owner, length: d.length, discriminator, writeAuthority, verification, feedId, price, conf, exponent,
    publishTime, prevPublishTime, emaPrice, emaConf, postedSlot };
}

export const toNum = (v: bigint, exponent: number) => Number(v) * 10 ** exponent;

// Feed ids come from Hermes' free metadata endpoint, never typed from memory.
export async function feedId(symbol: string): Promise<string> {
  const base = symbol.slice(0, -1).toUpperCase(); // AAPLx -> AAPL
  const res = await fetch(`https://hermes.pyth.network/v2/price_feeds?query=${base}X`);
  if (!res.ok) throw new Error(`hermes metadata ${res.status}`);
  const list = (await res.json()) as { id: string; attributes: { symbol: string } }[];
  const f = list.find((x) => x.attributes.symbol === `Crypto.${base}X/USD`);
  if (!f) throw new Error(`no Crypto.${base}X/USD feed`);
  return f.id;
}
