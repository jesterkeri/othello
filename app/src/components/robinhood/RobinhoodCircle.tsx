"use client";

/**
 * A savings circle on Robinhood Chain testnet (ARB-DESIGN r9). Nothing renders as an Othello circle,
 * and no approval or write is offered, until the four trust checks pass (lib/robinhood/adapter.ts).
 * Every action goes through the evm-usdg-v1 adapter: exact approvals, refusals decoded into plain words.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAddress, isAddress, parseAbi, parseEventLogs, parseUnits, type Address } from "viem";

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
import { closeOutOf, currentPhase, releaseButton, releaseSteps, ringOf, type ReleasePhase } from "@/lib/robinhood/circle-view";
import { reserveDisplay } from "@/lib/robinhood/reserve-display";
import { robinhoodPublicClient, useEvmWallet } from "@/lib/robinhood/wallet";

import { useWalletUi } from "@/lib/wallet";

import s from "@/components/circle/Circle.module.css";
import CircleRing from "./CircleRing";
import CloseOutPanel from "./CloseOutPanel";
import PayoutPanel from "./PayoutPanel";
import rh from "./Robinhood.module.css";

const REFRESH_MS = 8_000;
const NETWORK = { chip: "Robinhood Chain testnet", note: "Test USDG only. It has no value." };
const SEAT_SLOTS = ["teal", "acid", "cobalt", "clay", "sky"] as const;

type Busy = { what: string } | null;
type Last = { what: string; result: ActionResult } | null;

// The contract's own payout record (evm/src/OthelloCircle.sol): the confirmation names who was paid from the receipt.
const POT_RELEASED = parseAbi(["event PotReleased(uint8 round, address indexed recipient, uint256 pot, uint256 needed, uint256 remaining)"]);

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
  const connectUi = useWalletUi();
  const [trust, setTrust] = useState<TrustResult | null>(null);
  const [view, setView] = useState<RhCircleView | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [last, setLast] = useState<Last>(null);
  const [joinAmt, setJoinAmt] = useState("");
  const [addAmt, setAddAmt] = useState("");
  const [topAmt, setTopAmt] = useState("");
  const [inviteCopy, setInviteCopy] = useState<"idle" | "copied" | "failed">("idle");
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const latest = useRef(0);
  const inFlight = useRef(false);
  const [phase, setPhase] = useState<ReleasePhase>({ kind: "idle" });
  // Set only while a release is in flight: the adapter reports the wallet's hash here before the receipt.
  const onSent = useRef<((hash: string) => void) | null>(null);

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
            onSent: (hash) => onSent.current?.(hash),
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

  // A refusal belongs to the round it happened in: a new round starts clean.
  const viewRound = view?.round;
  useEffect(() => { setPhase((p) => (p.kind === "failed" ? { kind: "idle" } : p)); }, [viewRound]);

  /** Release this round's pot, following the real transaction: wallet, sent (hash), receipt, then a fresh read. */
  const release = useCallback(async (round: number, recipientTurn: number, amount: bigint) => {
    if (!adapter) return;
    setBusy({ what: "Release the pot" });
    setLast(null);
    setPhase({ kind: "wallet" });
    onSent.current = (hash) => setPhase({ kind: "sent", hash });
    try {
      const result = await adapter.releasePot({});
      if (!result.ok) {
        setPhase({ kind: "failed", message: result.message, error: result.error, round });
      } else {
        // Who was paid, how much and for which round: from the receipt's PotReleased event when it can be read
        // (another member may have released first, so this transaction released the next round); else the round
        // the button showed.
        let paid = { round, recipientTurn, amount };
        try {
          const receipt = await robinhoodPublicClient.getTransactionReceipt({ hash: result.txHash as `0x${string}` });
          const ev = parseEventLogs({ abi: POT_RELEASED, logs: receipt.logs.filter((l) => same(l.address, circle)) })[0];
          const seatOf = view?.seats.find((x) => same(x.wallet, ev?.args.recipient));
          if (ev && seatOf) paid = { round: ev.args.round, recipientTurn: seatOf.turn, amount: ev.args.pot };
        } catch { /* the read failed: the button's round stands, and "Confirmed" still waits for a fresh read */ }
        setPhase({ kind: "released", hash: result.txHash, ...paid });
      }
    } finally {
      onSent.current = null;
      setBusy(null);
      void refresh(true);
    }
  }, [adapter, refresh, circle, view]);

  if (!valid || (trust && !trust.ok)) {
    const notDeployed = trust && !trust.ok && trust.reason === "not-deployed";
    return (
      <Shell active="Circles" side="robinhood" network={NETWORK}>
        <main className={rh.page}>
          <section className={`${rh.banner} ${rh.refusal}`} role="alert">
            <h1 className={rh.bannerTitle}>{notDeployed ? "Robinhood circles aren't open yet" : "This isn't an Othello circle"}</h1>
            <p className={rh.bannerText}>
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
      <Shell active="Circles" side="robinhood" network={NETWORK}>
        <main className={rh.page}>
          <p className={rh.muted} role="status">{readError ? `Couldn't read the circle: ${readError}` : "Checking the circle on Robinhood Chain…"}</p>
          {readError && (
            <button type="button" className={rh.btn} onClick={() => void refresh(true)}>Try again</button>
          )}
        </main>
      </Shell>
    );
  }

  const v = view;
  const me = w.address ? v.seats.find((x) => same(x.wallet, w.address)) ?? null : null;
  const isCreator = same(v.creator, w.address);
  const pot = BigInt(v.n) * v.c;
  const reserve = reserveDisplay(v);
  const paused = v.status === "Active" && v.nextGateShortBy > 0n;
  const graceEnds = v.deadline + v.graceSecs;
  // Chain time (the last block's timestamp plus the seconds since that read) or the device clock, whichever is later:
  // a slow device clock cannot hide the buttons, and on a quiet chain an old last block cannot either. If a device
  // clock runs ahead the buttons can show early; the contract then refuses with "grace ends at …" (no funds move).
  const chainNow = Math.max(v.chainTime + Math.max(0, now - v.readAt), now);
  const afterGrace = chainNow > graceEnds;
  const allSettled = v.seats.every((x) => x.paid || x.defaulted);
  const canWrite = Boolean(adapter) && w.onRobinhood && !busy;
  const statusClass = paused
    ? s.statusPaused
    : v.status === "Forming"
      ? s.statusForming
      : v.status === "Active"
        ? s.statusActive
        : v.status === "Completed"
          ? s.statusCompleted
          : s.statusCancelled;
  const ring = ringOf(v, w.address, Math.max(v.chainTime + Math.max(0, now - v.readAt), now));
  const payout = releaseButton(v, { hasWallet: w.hasWallet, connected: Boolean(w.address), onRobinhood: w.onRobinhood, busy: Boolean(busy), me: w.address ?? null });
  // A finished release stays on screen until dismissed, even after the read has moved to the next round.
  const payoutShown = payout ?? (phase.kind === "released" ? { label: "", enabled: false, blocker: null, recipientTurn: phase.recipientTurn, amount: phase.amount } : null);
  // a refusal from a round the read has already left is not shown (two members releasing at once)
  const shownPhase = currentPhase(phase, v);
  const steps = releaseSteps(v, shownPhase);
  const close = closeOutOf(v, w.address);
  const writeBlocker = !w.hasWallet ? "Install MetaMask or another EVM wallet to collect." : !w.address ? "Connect the wallet of your seat to collect." : !w.onRobinhood ? "Switch your wallet to Robinhood Chain testnet to collect." : busy ? "A transaction is already waiting for your wallet or for Robinhood Chain." : null;
  const coverFailed = shownPhase.kind === "failed" && ["CoverageTooLow", "ReserveOvercommitted"].includes(shownPhase.error);
  const firstLateUnpaidPrePayout = v.status === "Active" && afterGrace
    ? v.seats.find((x) => !x.paid && !x.defaulted && !x.received)
    : undefined;

  const joinUnits = toUnits(joinAmt);
  const addUnits = toUnits(addAmt);
  const topUnits = toUnits(topAmt);
  const fill = topUnits !== null ? topUpFill(v.escrowDeficit, topUnits) : 0n;
  const invitePath = `/circle/rh:${v.address}`;
  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(new URL(invitePath, window.location.origin).toString());
      setInviteCopy("copied");
    } catch {
      setInviteCopy("failed");
    }
  };

  return (
    <Shell active="Circles" side="robinhood" network={NETWORK}>
      <main className={s.frame}>
        <div className={s.banners}>
          {paused && (
            <section className={`${s.banner} ${s.bannerRefusal}`} role="status">
              <span className={s.bannerMark} aria-hidden>!</span>
              <span className={s.bannerBody}>
                <span className={s.bannerTitle}>Payouts are paused</span>
                <p className={s.bannerText}>The reserve is {fmtUsdg(v.nextGateShortBy)} short. Any member can top up to restart it.</p>
              </span>
            </section>
          )}
          {firstLateUnpaidPrePayout && (
            <section className={`${s.banner} ${s.bannerNeutral}`} role="status">
              <span className={s.bannerMark} aria-hidden>!</span>
              <span className={s.bannerBody}>
                <span className={s.bannerTitle}>Waiting for a late payment</span>
                <p className={s.bannerText}>The circle can&apos;t move on until {short(firstLateUnpaidPrePayout.wallet)} pays this round. They cannot be defaulted before their turn.</p>
              </span>
            </section>
          )}
          {v.surplus > 0n && (
            <section className={`${s.banner} ${s.bannerNeutral}`}>
              <span className={s.bannerMark} aria-hidden>!</span>
              <span className={s.bannerBody}>
                <span className={s.bannerTitle}>{fmtUsdg(v.surplus)} was sent to this circle by mistake</span>
                <p className={s.bannerText}>Direct transfers are not credited to a member and remain locked. Use only the controls on this page.</p>
              </span>
            </section>
          )}
        </div>

        <section className={`${s.hero} ${rh.ringHero}`} aria-label="This savings circle">
          <CircleRing ring={ring} pot={pot} round={v.round} />
          <div className={s.heroMain}>
            <div className={s.headTop}>
              <span className={`${s.statusPill} ${statusClass} ${s.micro}`}>{paused ? "Paused" : v.status}</span>
              <span className={`${s.stockPill} ${s.micro}`}>Test USDG on Robinhood Chain</span>
            </div>
            <h1 className={`${s.display} ${s.h1}`}>A savings circle of {v.n}</h1>
            <p className={s.sub}>
              {fmtUsdg(v.c)} per member each round. One person receives {fmtUsdg(pot)} each round, in the agreed order.
              Every seat locks test USDG and adds a {fmtUsdg(v.g)} reserve guarantee.
            </p>
            <div className={s.clock}>
              <span className={s.clockBox}>
                <span className={s.clockLabel}>{v.status === "Active" ? "Round" : "Seats joined"}</span>
                <span className={`${s.display} ${s.clockValue}`}>{v.status === "Active" ? `${v.round + 1} of ${v.n}` : `${v.seats.filter((seat) => seat.joined).length} of ${v.n}`}</span>
              </span>
              <span className={`${s.clockBox} ${v.status === "Active" && afterGrace ? s.clockOver : ""}`}>
                <span className={s.clockLabel}>{v.status === "Active" ? (afterGrace ? "Grace ended" : "Payment due") : "Round length"}</span>
                <span className={`${s.display} ${s.clockValue}`}>{v.status === "Active" ? (afterGrace ? "Late still counts" : when(v.deadline)) : duration(v.roundSecs)}</span>
              </span>
              <span className={s.clockBox}>
                <span className={s.clockLabel}>Pot this round</span>
                <span className={`${s.display} ${s.clockValue}`}>{fmtUsdg(pot)}</span>
              </span>
            </div>
            {close && (
              <CloseOutPanel
                close={close}
                completed={v.status === "Completed"}
                canWrite={canWrite}
                blocker={writeBlocker}
                busy={busy?.what === "Withdraw"}
                onWithdraw={() => adapter && void run("Withdraw", () => adapter.withdraw({}))}
              />
            )}
            {payoutShown && (
              <PayoutPanel
                button={payoutShown}
                steps={steps}
                phase={shownPhase}
                showSafetyCheck={paused || coverFailed}
                canWrite={canWrite}
                onRelease={() => void release(v.round, payoutShown.recipientTurn, payoutShown.amount)}
                onCheckSafety={() => adapter && void run("Check payout safety", () => adapter.updateCoverage({}))}
                onClose={() => setPhase({ kind: "idle" })}
              />
            )}
          </div>
        </section>

          <section className={s.act} aria-live="polite">
            <span className={s.kicker}>Your next step</span>
            <div className={s.action}>
              <span className={s.actionText}>
                <span className={s.bannerTitle}>{v.status === "Forming" ? "Invite the remaining members" : "Share this circle"}</span>
                <span className={s.actFixture}>{v.status === "Forming" ? "Send one link. Each person opens it in their own wallet and locks their own USDG." : "Copy the permanent circle link to share its live state. New members cannot join after the circle starts."}</span>
              </span>
              <span className={s.actionButtons}>
                <button type="button" className={s.pay} onClick={() => void copyInvite()}>{v.status === "Forming" ? "Copy invite link" : "Copy circle link"}</button>
                <a className={`${s.pay} ${s.payQuiet}`} href={invitePath}>{v.status === "Forming" ? "Open invite" : "Open circle"}</a>
              </span>
              {inviteCopy === "copied" && <span className={s.actFixture}>{v.status === "Forming" ? "Invite link copied." : "Circle link copied."}</span>}
              {inviteCopy === "failed" && <span className={s.actFixture}>Copy was blocked. Copy this page&apos;s address from your browser instead.</span>}
            </div>
            {!w.hasWallet && <p className={s.actFixture}>Install MetaMask or another EVM wallet to take part.</p>}
            {w.hasWallet && !w.address && (
              <button type="button" className={s.pay} onClick={connectUi.openConnect}>Connect an EVM wallet</button>
            )}
            {w.address && !w.onRobinhood && (
              <button type="button" className={s.pay} onClick={() => void w.switchToRobinhood()}>Switch to Robinhood Chain testnet</button>
            )}
            {w.error && <p className={s.actFixture}>{w.error}</p>}

            {w.address && w.onRobinhood && (
              <>
                {v.status === "Forming" && me && !me.joined && (
                  <div className={s.action}>
                    <span className={s.actionText}>
                      <span className={s.bannerTitle}>Claim your seat</span>
                      <span className={s.actFixture}>Lock USDG as your promise plus the {fmtUsdg(v.g)} guarantee. Your wallet confirms the approval and the join separately.</span>
                    </span>
                    <span className={s.amountRow}>
                      <input className={s.amount} aria-label="USDG to lock" inputMode="decimal" placeholder="USDG" value={joinAmt} onChange={(e) => setJoinAmt(e.target.value)} />
                      <button type="button" className={s.pay} disabled={!canWrite || joinUnits === null} onClick={() => joinUnits !== null && adapter && void run("Join", () => adapter.joinAndLock({ amount: joinUnits }))}>
                        {joinUnits !== null ? `Approve ${fmtUsdg(joinUnits + v.g)} and join` : "Enter USDG to join"}
                      </button>
                    </span>
                  </div>
                )}
                {v.status === "Forming" && me?.joined && (
                  <div className={s.action}>
                    <span className={s.actionText}>
                      <span className={s.bannerTitle}>Your seat is locked</span>
                      <span className={s.actFixture}>You can leave while the circle is still forming.</span>
                    </span>
                    <button type="button" className={`${s.pay} ${s.payQuiet}`} disabled={!canWrite} onClick={() => adapter && void run("Leave", () => adapter.leaveForming({}))}>
                      Leave and take back {fmtUsdg(me.collateral + me.g + me.topUps)}
                    </button>
                  </div>
                )}
                {v.status === "Forming" && isCreator && (
                  <div className={s.action}>
                    <span className={s.actionText}>
                      <span className={s.bannerTitle}>Creator controls</span>
                      <span className={s.actFixture}>{v.seats.some((seat) => !seat.joined) ? "The circle starts after every seat has joined." : "Everyone is in. Start the first round when you are ready."}</span>
                    </span>
                    <span className={s.actionButtons}>
                      <button type="button" className={s.pay} disabled={!canWrite || v.seats.some((seat) => !seat.joined)} onClick={() => adapter && void run("Start the circle", () => adapter.activate({}))}>Start the circle</button>
                      <button type="button" className={`${s.pay} ${s.payQuiet}`} disabled={!canWrite} onClick={() => adapter && void run("Cancel the circle", () => adapter.cancelCircle({}))}>Cancel circle</button>
                    </span>
                  </div>
                )}
                {v.status === "Active" && me && !me.defaulted && !me.paid && (
                  <div className={s.action}>
                    <span className={s.actionText}>
                      <span className={s.bannerTitle}>Pay this round</span>
                      <span className={s.actFixture}>You are paying {fmtUsdg(v.c)} into this round&apos;s pot.</span>
                    </span>
                    <button type="button" className={s.pay} disabled={!canWrite} onClick={() => adapter && void run("Pay this round", () => adapter.contribute({}))}>Approve and pay {fmtUsdg(v.c)}</button>
                  </div>
                )}
                {v.status === "Active" && me && !me.defaulted && (
                  <div className={s.action}>
                    <span className={s.actionText}>
                      <span className={s.bannerTitle}>Strengthen the circle</span>
                      <span className={s.actFixture}>{topUnits !== null ? (fill > 0n ? `${fmtUsdg(fill)} covers missed payments; the rest enters the shared reserve.` : `All ${fmtUsdg(topUnits)} enters the shared reserve.`) : "Lock more of your USDG or top up the shared reserve."}</span>
                    </span>
                    <span className={s.amountRow}>
                      <input className={s.amount} aria-label="USDG to lock more" inputMode="decimal" placeholder="More USDG" value={addAmt} onChange={(e) => setAddAmt(e.target.value)} />
                      <button type="button" className={`${s.pay} ${s.payQuiet}`} disabled={!canWrite || addUnits === null} onClick={() => addUnits !== null && adapter && void run("Lock more", () => adapter.addStock({ amount: addUnits }))}>Approve and lock</button>
                    </span>
                    <span className={s.amountRow}>
                      <input className={s.amount} aria-label="USDG reserve top up" inputMode="decimal" placeholder={paused ? fmtUsdg(v.nextGateShortBy).replace(" USDG", "") : "Reserve USDG"} value={topAmt} onChange={(e) => setTopAmt(e.target.value)} />
                      <button type="button" className={`${s.pay} ${s.payQuiet}`} disabled={!canWrite || topUnits === null} onClick={() => topUnits !== null && adapter && void run("Top up", () => adapter.topUpReserve({ amount: topUnits, expectedFill: fill }))}>Approve and top up</button>
                    </span>
                  </div>
                )}
                {v.status === "Active" && afterGrace && v.seats.filter((seat) => !seat.paid && !seat.defaulted).map((seat) => (
                  <div key={seat.turn} className={s.action}>
                    <span className={s.actionText}>
                      <span className={s.bannerTitle}>{short(seat.wallet)} missed this round</span>
                      <span className={s.actFixture}>{seat.marked ? (seat.received ? "This member has received a pot and can now be settled in default." : "Recorded late. They have not received a pot, so they cannot be defaulted.") : "Record the missed payment after grace. A late payment can still settle the round."}</span>
                    </span>
                    {!seat.marked ? (
                      <button type="button" className={`${s.pay} ${s.payQuiet}`} disabled={!canWrite} onClick={() => adapter && void run("Record missed payment", () => adapter.markDelinquent({ round: v.round, turn: seat.turn }))}>Record missed payment</button>
                    ) : seat.received ? (
                      <button type="button" className={s.pay} disabled={!canWrite} onClick={() => adapter && void run("Settle default", () => adapter.declareDefault({ turn: seat.turn }))}>Settle default</button>
                    ) : null}
                  </div>
                ))}
                {!me && <p className={s.actFixture}>This wallet is not a member. Anyone can release a settled pot, check payout safety, or record a missed payment after grace.</p>}
              </>
            )}
            {busy && <p className={s.actFixture} role="status">{busy.what}: confirm in your wallet, then wait for Robinhood Chain.</p>}
            {last && <p className={s.actFixture} role="status">{last.result.ok ? <>{last.what}: done. <a className={s.link} href={explorerTx(last.result.txHash)} target="_blank" rel="noreferrer">See it on the explorer</a></> : `${last.what}: ${last.result.message}`}</p>}
          </section>

        {v.status === "Forming" ? (
          <section className={s.section}>
            <div className={s.empty}>
              <span className={`${s.display} ${s.emptyTitle}`}>Waiting for {v.seats.filter((seat) => !seat.joined).length} members to join</span>
              <p className={s.bannerText}>{v.seats.filter((seat) => seat.joined).length} of {v.n} seats have locked USDG and added their reserve guarantee. Send the invite link to the remaining seats.</p>
            </div>
          </section>
        ) : (
          <section className={s.section}>
            <div className={s.sectionHead}>
              <span className={s.sectionLabel}>Turn order</span>
              <span className={s.sectionLabel}>{duration(v.roundSecs)} rounds, {duration(v.graceSecs)} grace</span>
            </div>
            <div className={s.timeline}>
              {v.seats.map((seat) => {
                const done = seat.received;
                const current = v.status === "Active" && seat.turn === v.round;
                return <div key={seat.turn} className={`${s.round} ${current ? s.roundNow : done ? s.roundDone : ""}`}><span className={s.roundNum}>Round {seat.turn + 1}</span><span className={s.roundName}>{short(seat.wallet)}</span><span className={s.roundNote}>{done ? "Pot paid" : current ? "Receiving now" : "Upcoming"}</span></div>;
              })}
            </div>
          </section>
        )}

        <div className={s.money}>
          <section className={s.reserve} aria-label="Shared reserve">
            <span className={s.kicker}>{reserve.heading}</span>
            <div className={s.reserveTop}>
              <b className={`${s.display} ${s.reserveBig}`}>{fmtUsdg(reserve.amount)}<small>Test USDG</small></b>
              <span className={s.coins} aria-label={`${v.seats.filter((seat) => seat.joined).length} joined seats`}>
                <span className={s.coinRow}>{v.seats.filter((seat) => seat.joined).map((seat, index) => <span key={seat.wallet} className={s.coin} style={{ background: `var(--${SEAT_SLOTS[index % SEAT_SLOTS.length]})`, color: `var(--${SEAT_SLOTS[index % SEAT_SLOTS.length]}Ink)`, transform: `rotate(${[-8, 4, -3, 7, -5][index % 5]}deg)` }}>{seat.turn + 1}</span>)}</span>
                <span className={s.coinNote}>{v.seats.filter((seat) => seat.joined).length} guarantees deposited, one per joined seat</span>
              </span>
            </div>
            <dl className={s.ledger}>{reserve.lines.map(([sign, label, amount]) => <div key={label} className={`${s.ledgerRow} ${sign === "=" ? s.ledgerSum : ""}`}><span className={s.ledgerSign} aria-hidden>{sign}</span><dt>{label}</dt><dd>{fmtUsdg(amount)}</dd></div>)}</dl>
          </section>
          <section className={s.cover} aria-label="Test USDG promise">
            <span className={s.kicker}>What each seat locks</span>
            <span className={s.coverIntro}>Robinhood Chain circles use test USDG only. There is no price feed or mainnet token in this testnet flow.</span>
            <ol className={s.steps}>
              {([[fmtUsdg(v.minStockCover), "Minimum USDG promise"], [`−${v.haircutBps / 100}%`, "Safety haircut"], [fmtUsdg(v.g), "Reserve guarantee"], ["TEST USDG", "No monetary value"]] as const).map(([amount, label], index) => <li key={label} className={`${s.step} ${index === 3 ? s.stepLast : ""}`}><span className={s.stepN}>{index + 1}</span><b className={s.display}>{amount}</b><span>{label}</span></li>)}
            </ol>
            <span className={s.coverChips}><span className={s.coverChip}><span>Payment</span>{fmtUsdg(v.c)} per round</span><span className={s.coverChip}><span>Rounds</span>{v.n} total</span><span className={s.coverChip}><span>Round length</span>{duration(v.roundSecs)}</span></span>
          </section>
        </div>

        <section className={s.section} aria-label="Members">
          <div className={s.sectionHead}><span className={s.sectionLabel}>Members ({v.seats.filter((seat) => seat.joined).length} of {v.n} joined)</span><span className={s.sectionNote}><b>Each locked promise belongs to its owner.</b> It returns at the end unless a post-payout default is settled.</span></div>
          <div className={s.memberGrid}>
            {v.seats.map((seat) => {
              const you = same(seat.wallet, w.address);
              const current = v.status === "Active" && seat.turn === v.round;
              const slot = SEAT_SLOTS[seat.turn % SEAT_SLOTS.length];
              const roundTag = seat.defaulted ? s.tagClay : seat.paid ? s.tagTeal : seat.joined && v.status === "Active" ? s.tagAcid : "";
              const potTag = seat.received ? s.tagTeal : current ? s.tagCobalt : "";
              return <article key={seat.turn} className={s.member}>
                <span className={s.stub} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)` }}><span className={s.micro}>Seat</span><b className={`${s.display} ${s.stubNum}`}>{seat.turn + 1}</b><span className={s.stubWho}><b>{you ? "You" : "Member"}</b><span>{short(seat.wallet)}{same(seat.wallet, v.creator) ? " · creator" : ""}</span></span></span>
                <span className={s.memberBody}>
                  <span className={s.memberTop}><span className={s.kicker}>{you ? "Your stake" : "Member stake"}</span>{you && <span className={s.youTag}>You</span>}<a className={s.arrow} href={explorerAddress(seat.wallet)} target="_blank" rel="noreferrer" aria-label={`Open ${short(seat.wallet)} in the explorer`}>↗</a></span>
                  {seat.joined ? <span className={s.stake}><span className={s.lockedLine}><span className={s.lockedLabel}>Locked:</span><b className={`${s.display} ${s.lockedAmt}`}>{fmtUsdg(seat.collateral).replace(" USDG", "")}</b><span className={s.lockedUnit}>USDG</span></span><span className={s.coverLine}>{seat.topUps > 0n ? `Plus ${fmtUsdg(seat.topUps)} added later.` : "Test USDG promise, less the configured safety haircut."}</span></span> : <span className={s.coverLine}>Not joined yet: nothing is locked.</span>}
                  <span className={s.chips}><span className={`${s.chip} ${roundTag}`}><span>This round</span>{seat.defaulted ? "Defaulted" : seat.paid ? "Paid" : seat.joined && v.status === "Active" ? "Due" : seat.joined ? "Joined" : "Not joined"}</span><span className={`${s.chip} ${potTag}`}><span>Pot</span>{seat.received ? "Received" : current ? "Receiving" : "Waiting"}</span>{seat.marked && <span className={`${s.chip} ${s.tagClay}`}><span>Status</span>Late, recorded</span>}{seat.withdrawn && <span className={s.chip}><span>Status</span>Withdrawn</span>}</span>
                </span>
              </article>;
            })}
          </div>
        </section>

        <footer className={s.footer}><p className={s.helper}>Test USDG is issued by Paxos, which can freeze or change it. If that happens, this circle cannot move until that restriction is lifted.</p><p className={s.helper}>Testnet only. Test USDG has no value. Circle <a className={s.link} href={explorerAddress(v.address)} target="_blank" rel="noreferrer">{short(v.address)}</a>{trustedFactory && <> from trusted factory <a className={s.link} href={explorerAddress(trustedFactory.address)} target="_blank" rel="noreferrer">{short(trustedFactory.address)}</a></>}.</p></footer>
      </main>
    </Shell>
  );
}
