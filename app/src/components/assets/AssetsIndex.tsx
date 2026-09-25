"use client";

/** /assets: the four real xStocks Othello accepts, read live from mainnet. */
import Link from "next/link";

import s from "@/components/circle/Circle.module.css";
import { shortAddress } from "@/lib/circle";
import { multiplierAt } from "@/lib/scaledUi";

import AssetShell, { Unavailable } from "./Shell";
import { mult, tokens, useLiveXStocks } from "./useLiveXStocks";

export default function AssetsIndex() {
  const { data, error } = useLiveXStocks();

  return (
    <AssetShell back={{ href: "/", label: "Back" }}>
      <section className={s.head}>
        <div className={s.headTop}>
          <span className={`${s.stockPill} ${s.micro}`}>Accepted as cover, by mint address</span>
        </div>
        <h1 className={`${s.display} ${s.h1}`}>The stocks a circle can lock</h1>
        <p className={s.sub}>
          Four tokenized stocks, each identified by its mint address, never its name: anyone can make a token called NFLXx.
          Open one to see what its mint says about itself and what its issuer can do.
        </p>
      </section>

      {error ? (
        <Unavailable error={error} />
      ) : !data ? (
        <div className={s.section}>
          <p className={s.panelNote}>Reading mainnet…</p>
        </div>
      ) : (
        <div className={s.cards}>
          {data.mints.map((m) => (
            <Link key={m.address} href={`/assets/${m.symbol}`} className={`${s.card} ${s.cardCoverage}`}>
              <span className={s.micro}>{m.info.metadata?.name ?? m.name}</span>
              <span className={`${s.display} ${s.cardBig}`}>{m.symbol}</span>
              <div className={s.rows}>
                <span className={s.row}>
                  <span className={s.rowLabel}>Multiplier now</span>
                  <span className={s.rowValue}>{mult(multiplierAt(m, Date.now() / 1000))}</span>
                </span>
                <span className={s.row}>
                  <span className={s.rowLabel}>Supply, as wallets show it</span>
                  <span className={s.rowValue}>about {tokens(m.supply, m.decimals, multiplierAt(m, Date.now() / 1000))}</span>
                </span>
                <span className={s.row}>
                  <span className={s.rowLabel}>Mint</span>
                  <span className={s.rowValue}>{shortAddress(m.address)}</span>
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
      <div className={s.footer}>
        <p className={s.helper}>{data ? `Mainnet slot ${data.slot.toLocaleString("en-US")}.` : ""}</p>
      </div>
    </AssetShell>
  );
}
