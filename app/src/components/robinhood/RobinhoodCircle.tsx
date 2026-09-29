"use client";

/**
 * A savings circle on Robinhood Chain testnet (ARB-DESIGN r9). Nothing renders as an Othello circle,
 * and no approval or write is offered, until the four trust checks pass (lib/robinhood/adapter.ts).
 * Every action goes through the evm-usdg-v1 adapter: exact approvals, refusals decoded into plain words.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAddress, isAddress, parseUnits, type Address } from "viem";

import Shell from "@/components/othello/Shell";
import type { ActionResult } from "@/lib/core/adapter";
import {
  checkTrusted,
  createRobinhoodAdapter,
  readCircle,
  topUpFill,
  trustedFactory,
  type RhCircleView,
  type RhSeat,
  type TrustResult,
} from "@/lib/robinhood/adapter";
import { explorerAddress, explorerTx } from "@/lib/robinhood/chain";
import { fmtUsdg } from "@/lib/robinhood/copy";
import { robinhoodPublicClient, useEvmWallet } from "@/lib/robinhood/wallet";

import EvmWalletPill from "./EvmWalletPill";

import s from "./Robinhood.module.css";

const REFRESH_MS = 8_000;
const NETWORK = { chip: "Robinhood Chain testnet", note: "Test USDG only. It has no value." };

type Busy = { what: string } | null;
type Last = { what: string; result: ActionResult } | null;

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const same = (a?: string | null, b?: string | null) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

function toUnits(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const v = parseUnits(t, 6);
  return v > 0n ? v : null;
}

function when(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function duration(secs: number): string {
  if (secs % 86_400 === 0) return `${secs / 86_400} day${secs === 86_400 ? "" : "s"}`;
  if (secs % 3_600 === 0) return `${secs / 3_600} hour${secs === 3_600 ? "" : "s"}`;
  if (secs % 60 === 0) return `${secs / 60} minute${secs === 60 ? "" : "s"}`;
  return `${secs} seconds`;
}

function seatTags(v: RhCircleView, seat: RhSeat): string[] {
  const t: string[] = [];
  if (v.status === "Forming") t.push(seat.joined ? "Joined" : "Not joined");
  if (v.status === "Active") {
    if (seat.defaulted) t.push("Defaulted");
    else t.push(seat.paid ? "Paid this round" : "Not paid yet");
    if (seat.marked) t.push("Late, recorded");
  }
  if (seat.received) t.push("Received the pot");
  if (seat.turn === v.round && v.status === "Active") t.push("Receives this round");
  if (seat.withdrawn) t.push("Withdrew");
  return t;
}

export default function RobinhoodCircle({ address }: { address: string }) {
  // Any casing is accepted (an all-caps or all-lowercase link is still this address); a mixed-case one must
  // carry a valid checksum.
  const valid = isAddress(address, { strict: false });
  const circle = (valid ? getAddress(address.toLowerCase()) : "0x0000000000000000000000000000000000000000") as Address;
  const w = useEvmWallet();
  const [trust, setTrust] = useState<TrustResult | null>(null);
  const [view, setView] = useState<RhCircleView | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [last, setLast] = useState<Last>(null);
  const [joinAmt, setJoinAmt] = useState("");
  const [addAmt, setAddAmt] = useState("");
  const [topAmt, setTopAmt] = useState("");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const latest = useRef(0);
  const inFlight = useRef(false);

  // The timer skips a tick while a read is still running, so a slow RPC cannot keep cancelling every read.
  // After an action, `force` starts a fresh read that supersedes any older one.
  const refresh = useCallback(async (force = false) => {
    if (!valid || (inFlight.current && !force)) return;
    inFlight.current = true;
    const mine = ++latest.current;
    try {
      const t = await checkTrusted(robinhoodPublicClient, circle);
      if (mine !== latest.current) return;
      setTrust(t);
      if (!t.ok) return;
      const v = await readCircle(robinhoodPublicClient, circle);
      if (mine !== latest.current) return;
      setView(v);
      setReadError(null);
    } catch (e) {
      if (mine === latest.current) setReadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === latest.current) inFlight.current = false;
    }
  }, [valid, circle]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), REFRESH_MS);
    const tick = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => {
      window.clearInterval(id);
      window.clearInterval(tick);
    };
  }, [refresh]);

  const adapter = useMemo(
    () =>
      w.walletClient && w.address
        ? createRobinhoodAdapter({
            publicClient: robinhoodPublicClient,
            walletClient: w.walletClient,
            account: w.address,
            circle,
          })
        : null,
    [w.walletClient, w.address, circle],
  );

  const run = useCallback(
    async (what: string, fn: () => Promise<ActionResult>) => {
      setBusy({ what });
      setLast(null);
      try {
        const result = await fn();
        setLast({ what, result });
      } finally {
        setBusy(null);
        void refresh(true);
      }
    },
    [refresh],
  );

  if (!valid || (trust && !trust.ok)) {
    const notDeployed = trust && !trust.ok && trust.reason === "not-deployed";
    return (
      <Shell active="Circles" network={NETWORK} wallet={<EvmWalletPill w={w} />}>
        <main className={s.page}>
          <section className={`${s.banner} ${s.refusal}`} role="alert">
            <h1 className={s.bannerTitle}>{notDeployed ? "Robinhood circles aren't open yet" : "This isn't an Othello circle"}</h1>
            <p className={s.bannerText}>
              {notDeployed
                ? "Othello's contracts on Robinhood Chain testnet are waiting for their final review. Nothing can be joined yet."
                : "Othello only shows circles made by its own factory on Robinhood Chain testnet. Don't approve or send anything to this address."}
            </p>
          </section>
        </main>
      </Shell>
    );
  }

  if (!view) {
    return (
      <Shell active="Circles" network={NETWORK} wallet={<EvmWalletPill w={w} />}>
        <main className={s.page}>
          <p className={s.muted} role="status">{readError ? `Couldn't read the circle: ${readError}` : "Checking the circle on Robinhood Chain…"}</p>
          {readError && (
            <button type="button" className={s.btn} onClick={() => void refresh(true)}>Try again</button>
          )}
        </main>
      </Shell>
    );
  }

  const v = view;
  const me = w.address ? v.seats.find((x) => same(x.wallet, w.address)) ?? null : null;
  const isCreator = same(v.creator, w.address);
  const pot = BigInt(v.n) * v.c;
  const remains = v.reserveTotal - v.reserveLosses;
  const finished = v.status === "Completed" || v.status === "Cancelled";
  // After the end, the pooled part is paid out by withdrawals; show what is still waiting to be withdrawn.
  const reserveShown = finished ? remains + v.escrow - v.withdrawnFromReserve : remains;
  const paused = v.status === "Active" && v.nextGateShortBy > 0n;
  const graceEnds = v.deadline + v.graceSecs;
  // Chain time (the last block's timestamp plus the seconds since that read) or the device clock, whichever is later:
  // a slow device clock cannot hide the buttons, and on a quiet chain an old last block cannot either. If a device
  // clock runs ahead the buttons can show early; the contract then refuses with "grace ends at …" (no funds move).
  const chainNow = Math.max(v.chainTime + Math.max(0, now - v.readAt), now);
  const afterGrace = chainNow > graceEnds;
  const allSettled = v.seats.every((x) => x.paid || x.defaulted);
  const canWrite = Boolean(adapter) && w.onRobinhood && !busy;
  const statusClass = paused ? s.paused : s[v.status.toLowerCase() as "forming" | "active" | "completed" | "cancelled"];
  const firstLateUnpaidPrePayout = v.status === "Active" && afterGrace
    ? v.seats.find((x) => !x.paid && !x.defaulted && !x.received)
    : undefined;

  const joinUnits = toUnits(joinAmt);
  const addUnits = toUnits(addAmt);
  const topUnits = toUnits(topAmt);
  const fill = topUnits !== null ? topUpFill(v.escrowDeficit, topUnits) : 0n;

  return (
    <Shell active="Circles" network={NETWORK} wallet={<EvmWalletPill w={w} />}>
      <main className={s.page}>
        <header className={s.head}>
          <div className={s.pills}>
            <span className={`${s.pill} ${statusClass}`}>{paused ? "Paused" : v.status}</span>
            <span className={s.pill}>USDG on Robinhood Chain</span>
            <a className={s.pill} href={explorerAddress(v.address)} target="_blank" rel="noreferrer">{short(v.address)}</a>
            <a className={s.pill} href="/robinhood">My circles</a>
          </div>
          <h1 className={s.title}>A savings circle of {v.n}</h1>
          <p className={s.sub}>
            Each round every member pays {fmtUsdg(v.c)} and one member takes the whole pot of {fmtUsdg(pot)}, in turn.
            Every member also locks USDG as a promise and adds a {fmtUsdg(v.g)} guarantee to a shared reserve, so a
            member who stops paying after their turn is covered without anyone chasing them.
          </p>
          {v.status === "Active" && (
            <p className={s.clock}>
              Round {v.round + 1} of {v.n}. Payments are due by {when(v.deadline)}; a missed payment can be recorded
              after {when(graceEnds)}.
            </p>
          )}
        </header>

        {paused && (
          <section className={`${s.banner} ${s.refusal}`} role="status">
            <h2 className={s.bannerTitle}>Payouts are paused</h2>
            <p className={s.bannerText}>
              The reserve is {fmtUsdg(v.nextGateShortBy)} short. Any member can top up to restart it.
            </p>
          </section>
        )}
        {firstLateUnpaidPrePayout && (
          <section className={`${s.banner} ${s.neutral}`} role="status">
            <h2 className={s.bannerTitle}>Waiting for a late payment</h2>
            <p className={s.bannerText}>
              The circle can&apos;t move on until {short(firstLateUnpaidPrePayout.wallet)} pays this round. Nobody can
              default them before their turn. Everyone&apos;s money stays locked until they pay.
            </p>
          </section>
        )}
        {v.surplus > 0n && (
          <section className={`${s.banner} ${s.neutral}`}>
            <h2 className={s.bannerTitle}>{fmtUsdg(v.surplus)} was sent to this circle by mistake</h2>
            <p className={s.bannerText}>USDG sent straight to a circle isn&apos;t counted for anyone and is locked for good. Only use the buttons here.</p>
          </section>
        )}

        <section className={s.grid}>
          <div className={s.card}>
            <h2 className={s.cardTitle}>{finished ? "Shared reserve still to withdraw" : "Shared reserve"}</h2>
            <p className={s.big}>{fmtUsdg(reserveShown)}</p>
            <dl className={s.facts}>
              <div><dt>Set aside for members who have received</dt><dd>{fmtUsdg(v.reserveAllocated)}</dd></div>
              <div><dt>Prepaid missed payments</dt><dd>{fmtUsdg(v.escrow)}</dd></div>
              <div><dt>Paid in this round</dt><dd>{fmtUsdg(v.heldContributions)}</dd></div>
              {v.reserveLosses > 0n && <div><dt>Used to cover defaults</dt><dd>{fmtUsdg(v.reserveLosses)}</dd></div>}
            </dl>
          </div>
          <div className={s.card}>
            <h2 className={s.cardTitle}>The rules</h2>
            <dl className={s.facts}>
              <div><dt>Payment per round</dt><dd>{fmtUsdg(v.c)}</dd></div>
              <div><dt>Guarantee per member</dt><dd>{fmtUsdg(v.g)}</dd></div>
              <div><dt>Least cover to lock</dt><dd>{fmtUsdg(v.minStockCover)} ({v.haircutBps / 100}% haircut)</dd></div>
              <div><dt>Round length</dt><dd>{duration(v.roundSecs)}, then {duration(v.graceSecs)} grace</dd></div>
              <div><dt>Fee</dt><dd>None on testnet</dd></div>
              <div><dt>Interest on locked USDG</dt><dd>0% · USDG has no built-in yield</dd></div>
            </dl>
          </div>
        </section>

        <section className={s.section}>
          <h2 className={s.sectionTitle}>Members, in payout order</h2>
          <ol className={s.members}>
            {v.seats.map((seat) => (
              <li key={seat.turn} className={`${s.member} ${same(seat.wallet, w.address) ? s.you : ""}`}>
                <span className={s.turn}>{seat.turn + 1}</span>
                <div className={s.memberBody}>
                  <a className={s.addr} href={explorerAddress(seat.wallet)} target="_blank" rel="noreferrer">
                    {short(seat.wallet)}{same(seat.wallet, w.address) ? " (you)" : ""}{same(seat.wallet, v.creator) ? " · creator" : ""}
                  </a>
                  <span className={s.tags}>{seatTags(v, seat).map((t) => <span key={t} className={s.tag}>{t}</span>)}</span>
                  {(seat.joined || seat.collateral > 0n) && (
                    <span className={s.muted}>Locked {fmtUsdg(seat.collateral)}{seat.topUps > 0n ? ` · topped up ${fmtUsdg(seat.topUps)}` : ""}</span>
                  )}
                </div>
                {v.status === "Active" && afterGrace && !seat.paid && !seat.defaulted && (
                  <div className={s.rowActions}>
                    {!seat.marked && (
                      <button type="button" className={s.btnQuiet} disabled={!canWrite}
                        onClick={() => adapter && void run("Record missed payment", () => adapter.markDelinquent({ round: v.round, turn: seat.turn }))}>
                        Record missed payment
                      </button>
                    )}
                    {seat.marked && seat.received && (
                      <button type="button" className={s.btnQuiet} disabled={!canWrite}
                        onClick={() => adapter && void run("Settle default", () => adapter.declareDefault({ turn: seat.turn }))}>
                        Settle default
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section className={`${s.section} ${s.act}`} aria-live="polite">
          <h2 className={s.sectionTitle}>What you can do</h2>
          {!w.hasWallet && <p className={s.muted}>Install MetaMask or another EVM wallet to take part.</p>}
          {w.hasWallet && !w.address && (
            <button type="button" className={s.btn} onClick={() => void w.connect()}>Connect an EVM wallet (MetaMask)</button>
          )}
          {w.address && !w.onRobinhood && (
            <button type="button" className={s.btn} onClick={() => void w.switchToRobinhood()}>Switch to Robinhood Chain testnet</button>
          )}
          {w.error && <p className={s.error}>{w.error}</p>}

          {w.address && w.onRobinhood && (
            <>
              {v.status === "Forming" && me && !me.joined && (
                <div className={s.form}>
                  <p className={s.helper}>
                    Lock USDG as your promise (it counts for its value less the {v.haircutBps / 100}% haircut) plus the
                    {" "}{fmtUsdg(v.g)} guarantee. Your wallet asks you to approve exactly that total, then to join.
                  </p>
                  <ul className={s.disclose}>
                    <li>No identity check yet: only join circles with people you know.</li>
                    <li>A member who hasn&apos;t received the pot yet can&apos;t be defaulted. If they stop paying, the circle waits and everyone&apos;s money stays locked until they pay.</li>
                    <li>If a default uses up reserve the next payout needs, the circle pauses until any member tops up. A top-up joins the shared reserve and comes back through the end-of-circle split, which later losses can reduce.</li>
                    <li>USDG is issued by Paxos, which can freeze or change it. If that happens, nothing in this circle can move until they lift it.</li>
                  </ul>
                  <label className={s.field}>
                    <span>USDG to lock</span>
                    <input inputMode="decimal" placeholder="e.g. 20" value={joinAmt} onChange={(e) => setJoinAmt(e.target.value)} />
                  </label>
                  <button type="button" className={s.btn} disabled={!canWrite || joinUnits === null}
                    onClick={() => joinUnits !== null && adapter && void run("Join", () => adapter.joinAndLock({ amount: joinUnits }))}>
                    {joinUnits !== null ? `Approve ${fmtUsdg(joinUnits + v.g)} and join` : "Join"}
                  </button>
                </div>
              )}
              {v.status === "Forming" && me?.joined && (
                <button type="button" className={s.btnQuiet} disabled={!canWrite}
                  onClick={() => adapter && void run("Leave", () => adapter.leaveForming({}))}>
                  Leave and take back {fmtUsdg(me.collateral + me.g + me.topUps)}
                </button>
              )}
              {v.status === "Forming" && isCreator && (
                <div className={s.buttons}>
                  <button type="button" className={s.btn} disabled={!canWrite || v.seats.some((x) => !x.joined)}
                    onClick={() => adapter && void run("Start the circle", () => adapter.activate({}))}>
                    Start the circle
                  </button>
                  <button type="button" className={s.btnQuiet} disabled={!canWrite}
                    onClick={() => adapter && void run("Cancel the circle", () => adapter.cancelCircle({}))}>
                    Cancel the circle
                  </button>
                </div>
              )}

              {v.status === "Active" && me && !me.defaulted && !me.paid && (
                <button type="button" className={s.btn} disabled={!canWrite}
                  onClick={() => adapter && void run("Pay this round", () => adapter.contribute({}))}>
                  Approve and pay {fmtUsdg(v.c)}
                </button>
              )}
              {v.status === "Active" && (
                <div className={s.buttons}>
                  <button type="button" className={s.btnQuiet} disabled={!canWrite || !allSettled}
                    onClick={() => adapter && void run("Release the pot", () => adapter.releasePot({}))}>
                    Release the pot to {short(v.seats[v.round]?.wallet ?? "")}
                  </button>
                  <button type="button" className={s.btnQuiet} disabled={!canWrite}
                    onClick={() => adapter && void run("Recheck cover", () => adapter.updateCoverage({}))}>
                    Recheck cover
                  </button>
                </div>
              )}
              {v.status === "Active" && me && !me.defaulted && (
                <div className={s.form}>
                  <label className={s.field}>
                    <span>Lock more USDG</span>
                    <input inputMode="decimal" placeholder="e.g. 5" value={addAmt} onChange={(e) => setAddAmt(e.target.value)} />
                  </label>
                  <button type="button" className={s.btnQuiet} disabled={!canWrite || addUnits === null}
                    onClick={() => addUnits !== null && adapter && void run("Lock more", () => adapter.addStock({ amount: addUnits }))}>
                    Approve and lock
                  </button>
                  <label className={s.field}>
                    <span>Top up the shared reserve</span>
                    <input inputMode="decimal" placeholder={paused ? fmtUsdg(v.nextGateShortBy).replace(" USDG", "") : "e.g. 5"}
                      value={topAmt} onChange={(e) => setTopAmt(e.target.value)} />
                  </label>
                  {topUnits !== null && (
                    <p className={s.helper}>
                      {fill > 0n
                        ? `${fmtUsdg(fill)} of your ${fmtUsdg(topUnits)} pays for missed payments by other members. It is not paid back to you personally: it only comes back through the end-of-circle split of whatever is left, shared by everyone, and that can be zero. The rest (${fmtUsdg(topUnits - fill)}) goes into the shared reserve.`
                        : `All ${fmtUsdg(topUnits)} goes into the shared reserve. It comes back through the end-of-circle split, minus any losses.`}
                    </p>
                  )}
                  <button type="button" className={s.btnQuiet} disabled={!canWrite || topUnits === null}
                    onClick={() => topUnits !== null && adapter && void run("Top up", () => adapter.topUpReserve({ amount: topUnits, expectedFill: fill }))}>
                    Approve and top up
                  </button>
                </div>
              )}

              {(v.status === "Completed" || v.status === "Cancelled") && me && !me.withdrawn && (v.status === "Completed" || me.joined) && (
                <button type="button" className={s.btn} disabled={!canWrite}
                  onClick={() => adapter && void run("Withdraw", () => adapter.withdraw({}))}>
                  Withdraw your share
                </button>
              )}
              {finished && me?.withdrawn && <p className={s.muted}>You&apos;ve withdrawn your share. Nothing more to do here.</p>}
              {!me && <p className={s.muted}>This wallet isn&apos;t a member. Anyone can release a pot, recheck cover, or record a missed payment once grace ends.</p>}
            </>
          )}

          {busy && <p className={s.status} role="status">{busy.what}: confirm in your wallet, then wait for Robinhood Chain…</p>}
          {last && (
            <p className={last.result.ok ? s.status : s.error} role="status">
              {last.result.ok ? (
                <>
                  {last.what}: done.{" "}
                  <a href={explorerTx(last.result.txHash)} target="_blank" rel="noreferrer">See it on the explorer</a>
                </>
              ) : (
                `${last.what}: ${last.result.message}`
              )}
            </p>
          )}
        </section>

        <footer className={s.footer}>
          <p>
            USDG is issued by Paxos, which can freeze or change it. If that happens, nothing in this circle can move
            until they lift it.
          </p>
          <p>
            Testnet only. Test USDG has no value. Not financial advice. Circle contract{" "}
            <a href={explorerAddress(v.address)} target="_blank" rel="noreferrer">{short(v.address)}</a>
            {trustedFactory && (
              <>
                {" "}from factory{" "}
                <a href={explorerAddress(trustedFactory.address)} target="_blank" rel="noreferrer">{short(trustedFactory.address)}</a>
              </>
            )}
            .
          </p>
        </footer>
      </main>
    </Shell>
  );
}
