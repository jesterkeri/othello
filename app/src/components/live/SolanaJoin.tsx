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
import { JOIN_SPACE, joinLamports, joinPriceProblem, joinReadiness, joinViewAt, STOCK_DECIMALS, type BalanceRead } from "@/lib/solana-join";
import type { ScaledUi } from "@/lib/scaledUi";
import s from "@/components/circle/Circle.module.css";

/** The u64 amount of an SPL / Token-2022 token account (bytes 64..72). */
function amountOf(data: Uint8Array): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

export default function SolanaJoin({ c: read, split, owner, mints, vaults, connection, blocked, readAt, words, onJoin }: {
  /** The circle as last read. */
  c: CircleView;
  /** The mint's scheduled split, from the same read: the multiplier in force is judged on this row's own clock. */
  split: Pick<ScaledUi, "multiplier" | "newMultiplier" | "effectiveAt">;
  owner: PublicKey;
  mints: { stockMint: PublicKey; usdcMint: PublicKey };
  /** The circle's own stock and USDC vaults: a join creates them, at the joiner's cost, when they do not exist yet. */
  vaults: { stock: PublicKey; usdc: PublicKey };
  connection: Connection;
  blocked: string | null;
  /** The circle read's time: balances are read again with each new read. */
  readAt: number;
  words: { stock: string; stockShort: string; usdc: (base: bigint) => string };
  onJoin: (raw: bigint) => void;
}) {
  // this row's own clock, one tick a second: the price ages and a split takes effect between reads, and nothing else
  // redraws the page while reads keep failing (adversary on b620e79)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(id);
  }, []);
  // never earlier than the read: chain time only moves forward, so a device clock running behind must not make a price
  // the read found stale look fresh (adversary on ba8bef5)
  const at = Math.max(now, readAt);
  const priceProblem = joinPriceProblem(read, split, at);
  // the circle at the multiplier in force (the read itself when that cannot be carried; priceProblem then stops all)
  const c = joinViewAt(read, split, at) ?? read;
  // no least from a price the program would refuse
  const least = priceProblem ? null : minJoinStock(c);
  // the least, from each new read, until the member types their own amount (adversary on 6587a2b)
  const [typed, setTyped] = useState<string | null>(null);
  const amount = typed ?? (least !== null ? unitsText(least, STOCK_DECIMALS) : "");
  const [balances, setBalances] = useState<BalanceRead>("reading");
  const ownerKey = owner.toBase58();

  useEffect(() => {
    let live = true;
    setBalances("reading");
    void Promise.all([
      connection.getAccountInfo(tokenAccountOf(owner, mints, "stock")),
      connection.getAccountInfo(tokenAccountOf(owner, mints, "usdc")),
      connection.getBalance(owner),
      connection.getAccountInfo(vaults.stock),
      connection.getAccountInfo(vaults.usdc),
    ]).then(async ([stock, usdc, sol, stockVault, usdcVault]) => {
      const rents = new Map<number, bigint>();
      for (const space of new Set([JOIN_SPACE.member, JOIN_SPACE.usdcAccount, JOIN_SPACE.stockVault, JOIN_SPACE.usdcVault])) {
        rents.set(space, BigInt(await connection.getMinimumBalanceForRentExemption(space)));
      }
      const solNeeded = joinLamports({ usdcAccount: !usdc, stockVault: !stockVault, usdcVault: !usdcVault }, (space) => rents.get(space)!);
      const solKeep = BigInt(await connection.getMinimumBalanceForRentExemption(0));
      return { stock: stock ? amountOf(stock.data) : null, usdc: usdc ? amountOf(usdc.data) : null, sol: BigInt(sol), solNeeded, solKeep };
    }).then(
      (read) => {
        if (live) setBalances(read);
      },
      () => {
        if (live) setBalances("failed");
      },
    );
    return () => {
      live = false;
    };
    // a new wallet or a new circle read reads the balances again
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey, readAt, connection]);

  // a circle whose minimum cover is 0 takes a join with no stock (h = 0 >= 0); parseUnits refuses 0, so read it here
  const raw = parseUnits(amount, STOCK_DECIMALS) ?? (/^0*(?:\.0*)?$/.test(amount.trim()) && /\d/.test(amount) ? 0n : null);
  const stopped = blocked ?? priceProblem;
  const ready = joinReadiness(c, raw, balances, stopped, words);
  const cover = raw !== null ? countedOfRaw(c, raw) : null;
  const guarantee = BigInt(c.guaranteePerMember);
  return (
    <div className={s.action} aria-live="polite">
      <span className={s.actionText}>
        <span className={s.bannerTitle}>Claim your seat</span>
        <p className={s.bannerText}>
          Lock the {words.stock} as your cover and add the {words.usdc(guarantee)} guarantee to the shared reserve.
          {/* no figure from a price the program would refuse (stale, unset, or set for another multiplier) */}
          {least !== null && !stopped ? ` This circle needs at least ${unitsText(least, STOCK_DECIMALS)} ${words.stock}.` : ""}
          {cover !== null && !stopped ? ` ${unitsText(raw!, STOCK_DECIMALS)} ${words.stock} counts as ${words.usdc(cover)} of cover at the current price.` : ""}
          {" "}You can leave and take both back until the circle starts.
        </p>
        {ready.reason && <p className={s.bannerText}>{ready.reason}</p>}
      </span>
      <span className={s.actionButtons}>
        <label className={s.amountRow}>
          <input className={s.amount} inputMode="decimal" value={amount} onChange={(e) => setTyped(e.target.value)} aria-label={`${words.stock} to lock`} />
          <button type="button" className={s.pay} disabled={!ready.enabled} onClick={() => raw !== null && onJoin(raw)}>
            {raw !== null && !stopped ? `Join: lock ${unitsText(raw, STOCK_DECIMALS)} ${words.stockShort} and the ${words.usdc(guarantee)} guarantee` : "Join"}
          </button>
        </label>
      </span>
    </div>
  );
}
