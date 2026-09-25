"use client";

/**
 * /assets/[symbol]: one real xStock, read live from its mint on mainnet (CLAUDE-CODE-STOCK-PAGE.md,
 * from xStocks.dc.html). A header band in the stock's colour, then a bento grid: price history
 * (GeckoTerminal) beside Buy (a Jupiter quote handed off to Jupiter's own page: Othello builds no
 * swap and never holds funds) and the multiplier, the demo's split card for NFLXx, and the
 * identity strip. Issuer powers, decoded from the mint, open in a dialog. Every figure is from the
 * mint read, Jupiter or GeckoTerminal; a failed read says so and shows no figure.
 */
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import s from "@/components/circle/Circle.module.css";
import { shortAddress } from "@/lib/circle";
import { explorer } from "@/lib/devnet";
import { multiplierAt } from "@/lib/scaledUi";

import BuyPanel from "./BuyPanel";
import PriceChart from "./PriceChart";
import AssetShell, { Unavailable } from "./Shell";
import { exactTokens } from "@/lib/format";

import { mult, tokens, useLiveXStocks, when } from "./useLiveXStocks";
import d from "./AssetDetail.module.css";
import { slotFor } from "./slots";

/** A power's tile colour (spec §3): held by a key cobalt, enabled sky, multiplier changeable acid, safe teal. */
function tone(kind: "held" | "enabled" | "yes" | "safe"): string {
  return { held: d.toneHeld, enabled: d.toneEnabled, yes: d.toneYes, safe: d.toneSafe }[kind]!;
}

function Row({ label, value, note, kind }: { label: string; value: ReactNode; note?: string; kind: "held" | "enabled" | "yes" | "safe" }) {
  return (
    <tr>
      <td>
        <span className={`${s.seatName} ${tone(kind)}`}>
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
  const slot = slotFor(symbol);
  const [powers, setPowers] = useState(false);
  useEffect(() => {
    if (!powers) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPowers(false);
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [powers]);
  const change = m && m.effectiveAt && m.newMultiplier !== m.multiplier ? { from: m.multiplier, to: m.newMultiplier, at: m.effectiveAt } : null;
  // How many of the eight powers a key can use today (the header button's count).
  const held = m
    ? [
        m.info.mintAuthority,
        m.info.freezeAuthority,
        m.info.permanentDelegate,
        m.info.pausable?.authority,
        m.info.transferHook?.program,
        m.info.defaultAccountState === "frozen" ? "frozen" : null,
        m.info.confidentialTransfers ? "on" : null,
        m.info.scaledUi ? m.info.scaledUiAuthority : null,
      ].filter(Boolean).length
    : 0;

  return (
    <AssetShell back={{ href: "/assets", label: "All assets" }}>
      {error ? (
        <Unavailable error={error} />
      ) : data && !m ? (
        <Unavailable
          error={`${symbol} could not be read from mainnet this time${
            data.unavailable.find((u) => u.symbol === symbol) ? ` (${data.unavailable.find((u) => u.symbol === symbol)!.reason})` : ""
          }.`}
        />
      ) : !m ? (
        <div className={d.loading} aria-busy="true">
          <div className={d.skelBand} />
          <div className={d.bento}>
            <div className={`${d.skel} ${d.chartArea}`} />
            <div className={`${d.skel} ${d.buyArea}`} />
            <div className={`${d.skel} ${d.multArea}`} />
          </div>
          <span>Reading {symbol} from mainnet…</span>
        </div>
      ) : (
        <>
          <section className={d.band} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)` }}>
            <div className={d.bandRow}>
              <Link href="/assets" className={d.back}>‹ All assets</Link>
              <span className={d.readChip}>
                <span className={d.dot} aria-hidden />
                Mainnet, read only · slot {data!.slot.toLocaleString("en-US")}
              </span>
            </div>
            <div className={d.bandRow}>
              <span className={d.titleLine}>
                <h1 className={d.sym}>{m.symbol}</h1>
                {m.info.metadata && (
                  <span className={d.says}>
                    The mint says <b>{m.info.metadata.name}</b>
                  </span>
                )}
              </span>
              <span className={d.bandRight}>
                <button type="button" className={d.powersBtn} aria-haspopup="dialog" aria-expanded={powers} onClick={() => setPowers(true)}>
                  <span className={d.countDisc}>{held}</span>Issuer powers
                </button>
                <span className={d.kicker}>Mint</span>
                <a className={d.mintPill} href={explorer("address", m.address, "mainnet")} target="_blank" rel="noreferrer">
                  {shortAddress(m.address)}
                </a>
              </span>
            </div>
          </section>

          <div className={`${d.bento} ${m.symbol === "NFLXx" ? d.bentoDemo : ""}`}>
            <section className={`${d.card} ${d.chartArea}`} aria-label="Price">
              <span className={d.cardKicker}>
                {m.market ? `Jupiter: ${"$"}${m.market.usdPrice.toFixed(2)} per token as wallets show it` : "Jupiter price unavailable"}
              </span>
              <PriceChart symbol={m.symbol} multiplierNow={multiplierAt(m, now)} change={change} embedded />
              <div className={d.stats}>
                <span><small>Multiplier now</small><b>{mult(multiplierAt(m, now))}</b></span>
                <span><small>Supply, as wallets show it</small><b>about {tokens(m.supply, m.decimals, multiplierAt(m, now))}</b></span>
                <span><small>Raw supply, exact</small><b>{exactTokens(m.supply, m.decimals)}</b></span>
                <span><small>Pool liquidity (Jupiter)</small><b>{m.market?.liquidity != null ? `${"$"}${Math.round(m.market.liquidity).toLocaleString("en-US")}` : "unavailable"}</b></span>
              </div>
            </section>

            <section className={`${d.card} ${d.buyArea} ${d.buyCard}`} aria-label={`Buy ${m.symbol}`}>
              <span className={d.buyHead}>
                <b>Buy {m.symbol}</b>
                <span className={d.realMoney}>Mainnet · real money</span>
              </span>
              {m.info.pausable?.paused ? (
                <Unavailable error={`${m.symbol} is paused by its issuer right now: nobody can transfer or buy it until they unpause it.`} />
              ) : (
                <BuyPanel symbol={m.symbol} address={m.address} decimals={m.decimals} multiplier={multiplierAt(m, now)} accepted={m.accepted} embedded />
              )}
            </section>

            <section className={`${d.card} ${d.multArea}`} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)` }} aria-label="Multiplier">
              <span className={d.outlined}>Multiplier now</span>
              <b className={d.multBig}>{mult(multiplierAt(m, now))}</b>
              <span className={d.dotted} />
              <span className={d.changeLine}>
                {change ? (
                  <>
                    <span>{change.at <= now ? "Last scheduled change" : "Next scheduled change"}</span>
                    <b>{mult(change.from)} → {mult(change.to)}</b>
                    <span className={d.datePill} style={{ color: `var(--${slot})` }}>{when(change.at)}</span>
                  </>
                ) : (
                  <span>No scheduled change on the mint.</span>
                )}
              </span>
              <p className={d.multNote}>
                Read from the Scaled UI amount extension on the mint. Wallets show raw × multiplier; Othello values locked stock
                the same way and refuses to value it while price and multiplier disagree, so a split can neither inflate nor
                erase anyone&apos;s cover.
              </p>
            </section>

            {m.symbol === "NFLXx" && (
              <section className={`${d.card} ${d.demoArea}`} aria-label="The split the demo replays">
                <b className={d.demoTitle}>The split the demo replays</b>
                <span>The demo circle locks a labelled devnet mirror of NFLXx, not the real token on this page, and puts it through the same x1 to x10.</span>
                <span className={d.demoBtns}>
                  <Link href="/circle/demo" className={d.btnInk}>See the demo circle ↗</Link>
                  <Link href="/split-lab" className={d.btnLine}>Open Split lab</Link>
                </span>
              </section>
            )}

            <section className={`${d.ident} ${d.identArea}`} aria-label="Identity">
              <span className={d.identItem}>
                <small>Mint</small>
                <a className={d.addr} href={explorer("address", m.address, "mainnet")} target="_blank" rel="noreferrer">{m.address} ↗</a>
              </span>
              {m.info.metadata?.uri && (
                <span className={d.identItem}><small>Metadata</small><span className={d.addr}>{m.info.metadata.uri}</span></span>
              )}
              <span className={d.identItem}><small>Extensions</small><span>{m.info.extensions.map((e) => e.name).join(", ")}</span></span>
              {m.accepted && (
                <span className={d.coverPill}>
                  Accepted as cover (Othello&apos;s mainnet build) <span className={d.l7}>L7</span>
                </span>
              )}
            </section>
          </div>

          {/* In the DOM always (hidden when closed), so the powers are readable without JavaScript. */}
          <div className={d.scrim} hidden={!powers} onClick={() => setPowers(false)}>
            <div role="dialog" aria-modal="true" aria-label="Issuer powers" className={d.dialog} onClick={(e) => e.stopPropagation()}>
              <div className={d.dialogHead}>
                <span>
                  <b>Issuer powers</b>
                  <small>What the issuer can do to any holder&apos;s tokens</small>
                </span>
                <button type="button" className={d.close} aria-label="Close" onClick={() => setPowers(false)}>×</button>
              </div>
              <table className={d.powers}>
                <tbody>
                  <Row kind={m.info.mintAuthority ? "held" : "safe"} label="Mint new tokens" note="Mint authority" value={<Key address={m.info.mintAuthority} />} />
                  <Row kind={m.info.freezeAuthority ? "held" : "safe"} label="Freeze any holder's account" note="Freeze authority" value={<Key address={m.info.freezeAuthority} />} />
                  <Row
                    kind={m.info.permanentDelegate ? "held" : "safe"}
                    label="Move or burn tokens from any account, without the holder"
                    note="Permanent delegate"
                    value={<Key address={m.info.permanentDelegate} />}
                  />
                  <Row
                    kind={m.info.pausable?.paused ? "held" : "safe"}
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
                    kind={m.info.transferHook?.program ? "held" : m.info.transferHook ? "enabled" : "safe"}
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
                    kind={m.info.defaultAccountState === "frozen" ? "held" : "safe"}
                    label="New accounts start"
                    note="Default account state"
                    value={m.info.defaultAccountState ?? "usable (no default set)"}
                  />
                  <Row
                    kind={m.info.confidentialTransfers ? "enabled" : "safe"}
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
                  <Row
                    kind={m.info.scaledUi && m.info.scaledUiAuthority ? "yes" : "safe"}
                    label="Change the multiplier (splits, dividends)"
                    note="Scaled UI amount authority"
                    value={
                      !m.info.scaledUi ? (
                        <span className={`${s.tag} ${s.tagNo}`}>Not enabled</span>
                      ) : m.info.scaledUiAuthority ? (
                        <Key address={m.info.scaledUiAuthority} />
                      ) : (
                        <span className={`${s.tag} ${s.tagNo}`}>Nobody: authority revoked</span>
                      )
                    }
                  />
                </tbody>
              </table>
              <p className={d.dialogFoot}>
                Decoded from the mint account on Solana mainnet, slot {data!.slot.toLocaleString("en-US")}. Othello does not
                defend against these powers yet (KNOWN-LIMITS L7): a circle trusts the issuer exactly as any holder does.
              </p>
            </div>
          </div>
        </>
      )}
    </AssetShell>
  );
}
