"use client";

/**
 * /assets/[symbol]: one real xStock, read live from its mint on mainnet.
 * Everything shown is decoded from the mint account (lib/mintInfo.ts); there
 * is no price here, because Othello has no price source for the real mints.
 */
import Link from "next/link";
import type { ReactNode } from "react";

import s from "@/components/circle/Circle.module.css";
import { shortAddress } from "@/lib/circle";
import { explorer } from "@/lib/devnet";
import { multiplierAt } from "@/lib/scaledUi";

import AssetShell, { Unavailable } from "./Shell";
import { mult, tokens, useLiveXStocks, when } from "./useLiveXStocks";

function Row({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <tr>
      <td>
        <span className={s.seatName}>
          <span>{label}</span>
          {note && <span className={s.seatAddr}>{note}</span>}
        </span>
      </td>
      <td>{value}</td>
    </tr>
  );
}

function Key({ address }: { address: string | null }) {
  if (!address) return <span className={`${s.tag} ${s.tagNo}`}>None</span>;
  return (
    <a className={s.link} href={explorer("address", address, "mainnet")} target="_blank" rel="noreferrer">
      {shortAddress(address)}
    </a>
  );
}

export default function AssetDetail({ symbol }: { symbol: string }) {
  const { data, error } = useLiveXStocks();
  const m = data?.mints.find((x) => x.symbol === symbol);
  const now = Date.now() / 1000;

  return (
    <AssetShell back={{ href: "/assets", label: "All xStocks" }}>
      {error ? (
        <Unavailable error={error} />
      ) : !m ? (
        <div className={s.section}>
          <p className={s.panelNote}>Reading {symbol} from mainnet…</p>
        </div>
      ) : (
        <>
          <section className={s.head}>
            <div className={s.headTop}>
              <span className={`${s.statusPill} ${s.statusActive} ${s.micro}`}>Real xStock</span>
              <span className={`${s.stockPill} ${s.micro}`}>Accepted as cover in Othello&apos;s mainnet build</span>
            </div>
            <h1 className={`${s.display} ${s.h1}`}>{m.info.metadata?.name ?? m.name}</h1>
            <p className={s.sub}>
              {m.info.metadata
                ? `The mint names itself "${m.info.metadata.name}" with symbol ${m.info.metadata.symbol}. `
                : ""}
              Othello knows it by its address,{" "}
              <a className={s.link} href={explorer("address", m.address, "mainnet")} target="_blank" rel="noreferrer">
                {shortAddress(m.address)}
              </a>
              , not by that name.
            </p>
          </section>

          <div className={s.cards}>
            <div className={`${s.card} ${s.cardReserve}`}>
              <span className={s.micro}>Multiplier now</span>
              <span className={`${s.display} ${s.cardBig}`}>{mult(multiplierAt(m, now))}</span>
              <div className={s.rows}>
                <span className={s.row}>
                  <span className={s.rowLabel}>Last scheduled change</span>
                  <span className={s.rowValue}>
                    {m.effectiveAt && m.newMultiplier !== m.multiplier
                      ? `${mult(m.multiplier)} to ${mult(m.newMultiplier)}, ${m.effectiveAt <= now ? "took effect" : "takes effect"} ${when(m.effectiveAt)}`
                      : "None"}
                  </span>
                </span>
                <span className={s.row}>
                  <span className={s.rowLabel}>Supply, raw</span>
                  <span className={s.rowValue}>{tokens(m.supply, m.decimals)}</span>
                </span>
                <span className={s.row}>
                  <span className={s.rowLabel}>Supply, as wallets show it</span>
                  <span className={s.rowValue}>{tokens(m.supply, m.decimals, multiplierAt(m, now))}</span>
                </span>
              </div>
            </div>
            <div className={`${s.card} ${s.cardCoverage}`}>
              <span className={s.micro}>Why the multiplier matters</span>
              <p className={s.bannerText}>
                A split or dividend changes the multiplier, not anyone&apos;s raw balance. Wallets show raw times the
                multiplier, so a 10-for-1 makes a balance look ten times bigger at a tenth of the price. Othello values
                locked stock as raw times the multiplier in force times the share price, and refuses to value it while
                the price and the multiplier disagree, so a split can neither inflate nor erase anyone&apos;s cover.
              </p>
              {symbol === "NFLXx" && (
                <p className={s.bannerText}>
                  This is the split the demo replays.{" "}
                  <Link className={s.link} href="/circle/demo">
                    The demo circle
                  </Link>{" "}
                  locks a devnet mirror of NFLXx (not the real NFLXx) and puts it through the same x1 to x10.{" "}
                  <Link className={s.link} href="/split-lab">
                    See what it does to locked stock in the Split lab
                  </Link>
                  .
                </p>
              )}
            </div>
          </div>

          <div className={s.section}>
            <div className={s.sectionHead}>
              <span className={s.sectionLabel}>What the issuer can do</span>
              <span className={s.sectionLabel}>decoded from the mint</span>
            </div>
            <div className={s.tableWrap}>
              <table className={s.table}>
                <tbody>
                  <Row label="Mint new tokens" note="Mint authority" value={<Key address={m.info.mintAuthority} />} />
                  <Row label="Freeze any holder's account" note="Freeze authority" value={<Key address={m.info.freezeAuthority} />} />
                  <Row
                    label="Move or burn tokens from any account, without the holder"
                    note="Permanent delegate"
                    value={<Key address={m.info.permanentDelegate} />}
                  />
                  <Row
                    label="Pause every transfer of this token"
                    note="Pausable"
                    value={
                      m.info.pausable ? (
                        <span>
                          <Key address={m.info.pausable.authority} />{" "}
                          <span className={`${s.tag} ${m.info.pausable.paused ? s.tagDue : s.tagYes}`}>
                            {m.info.pausable.paused ? "Paused now" : "Not paused"}
                          </span>
                        </span>
                      ) : (
                        <span className={`${s.tag} ${s.tagNo}`}>Not enabled</span>
                      )
                    }
                  />
                  <Row
                    label="Run a program on every transfer"
                    note="Transfer hook"
                    value={
                      m.info.transferHook ? (
                        m.info.transferHook.program ? (
                          <Key address={m.info.transferHook.program} />
                        ) : (
                          <span>
                            <span className={`${s.tag} ${s.tagNo}`}>No program set</span> can be set by{" "}
                            <Key address={m.info.transferHook.authority} />
                          </span>
                        )
                      ) : (
                        <span className={`${s.tag} ${s.tagNo}`}>Not enabled</span>
                      )
                    }
                  />
                  <Row
                    label="New accounts start"
                    note="Default account state"
                    value={m.info.defaultAccountState ?? "usable (no default set)"}
                  />
                  <Row
                    label="Confidential transfers"
                    note="Each account needs approval"
                    value={
                      m.info.confidentialTransfers
                        ? m.info.confidentialTransfers.autoApprove
                          ? "Enabled, auto-approved"
                          : "Enabled, approval required"
                        : "Not enabled"
                    }
                  />
                  <Row label="Change the multiplier (splits, dividends)" note="Scaled UI amount" value={m.info.scaledUi ? "Yes" : "No"} />
                </tbody>
              </table>
            </div>
            <p className={s.panelNote}>
              Othello does not defend against these powers yet (KNOWN-LIMITS L7). A circle trusts the issuer exactly as
              any holder of the token does: a frozen or moved vault would stop a default from settling.
            </p>
          </div>

          <div className={s.footer}>
            <p className={s.helper}>
              Extensions on this mint: {m.info.extensions.map((e) => e.name).join(", ")}. Mainnet slot{" "}
              {data!.slot.toLocaleString("en-US")}.
            </p>
          </div>
        </>
      )}
    </AssetShell>
  );
}
