"use client";

/**
 * Joining a seat of a forming Solana circle from the shared circle page (PR 2, Joshua 2026-10-08). The member types
 * how much of the circle's stock to lock, prefilled with the least the circle accepts (lib/circle.ts minJoinStock, the
 * program's own CollateralBelowMinimum rule), sees what it counts as in cover, and joins from their own wallet;
 * join_and_lock also moves the guarantee in test USDC. The button is enabled only when everything the program checks
 * that this page can know holds (joinReadiness); the program still checks, and any refusal shows in its own words.
 *
 * Its own component so LiveCircle's state (seeded in order by its tests) is untouched.
 */
import { useEffect, useState } from "react";
import type { Connection, PublicKey } from "@solana/web3.js";

import { parseUnits, tokenAccountOf, unitsText } from "@/lib/actions";
import { countedOfRaw, minJoinStock, type CircleView } from "@/lib/circle";
import { joinReadiness, STOCK_DECIMALS, type JoinBalances } from "@/lib/solana-join";
import s from "@/components/circle/Circle.module.css";

/** The u64 amount of an SPL / Token-2022 token account (bytes 64..72). */
function amountOf(data: Uint8Array): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

export default function SolanaJoin({ c, owner, mints, connection, blocked, readAt, words, onJoin }: {
  c: CircleView;
  owner: PublicKey;
  mints: { stockMint: PublicKey; usdcMint: PublicKey };
  connection: Connection;
  blocked: string | null;
  /** The circle read's time: balances are read again with each new read. */
  readAt: number;
  words: { stock: string; stockShort: string; usdc: (base: bigint) => string };
  onJoin: (raw: bigint) => void;
}) {
  const least = minJoinStock(c);
  const [amount, setAmount] = useState(least !== null && least > 0n ? unitsText(least, STOCK_DECIMALS) : "");
  const [balances, setBalances] = useState<JoinBalances | "reading">("reading");
  const ownerKey = owner.toBase58();

  useEffect(() => {
    let live = true;
    setBalances("reading");
    void Promise.all([
      connection.getAccountInfo(tokenAccountOf(owner, mints, "stock")),
      connection.getAccountInfo(tokenAccountOf(owner, mints, "usdc")),
    ]).then(
      ([stock, usdc]) => {
        if (live) setBalances({ stock: stock ? amountOf(stock.data) : null, usdc: usdc ? amountOf(usdc.data) : null });
      },
      () => {
        if (live) setBalances("reading");
      },
    );
    return () => {
      live = false;
    };
    // a new wallet or a new circle read reads the balances again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey, readAt, connection]);

  const raw = parseUnits(amount, STOCK_DECIMALS);
  const ready = joinReadiness(c, raw, balances, blocked, words);
  const cover = raw !== null ? countedOfRaw(c, raw) : null;
  const guarantee = BigInt(c.guaranteePerMember);
  return (
    <div className={s.action} aria-live="polite">
      <span className={s.actionText}>
        <span className={s.bannerTitle}>Claim your seat</span>
        <p className={s.bannerText}>
          Lock the {words.stock} as your cover and add the {words.usdc(guarantee)} guarantee to the shared reserve.
          {least !== null ? ` This circle needs at least ${unitsText(least, STOCK_DECIMALS)} ${words.stock}.` : ""}
          {cover !== null && !blocked ? ` ${unitsText(raw!, STOCK_DECIMALS)} ${words.stock} counts as ${words.usdc(cover)} of cover at the current price.` : ""}
          {" "}You can leave and take both back until the circle starts.
        </p>
        {ready.reason && <p className={s.bannerText}>{ready.reason}</p>}
      </span>
      <span className={s.actionButtons}>
        <label className={s.amountRow}>
          <input className={s.amount} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={`${words.stock} to lock`} />
          <button type="button" className={s.pay} disabled={!ready.enabled} onClick={() => raw !== null && onJoin(raw)}>
            Join: lock {raw !== null ? unitsText(raw, STOCK_DECIMALS) : "0"} {words.stockShort} and the {words.usdc(guarantee)} guarantee
          </button>
        </label>
      </span>
    </div>
  );
}
