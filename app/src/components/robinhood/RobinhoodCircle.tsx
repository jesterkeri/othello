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
  type TrustResult,
} from "@/lib/robinhood/adapter";
import { explorerAddress, explorerTx } from "@/lib/robinhood/chain";
import { fmtUsdg } from "@/lib/robinhood/copy";
import { closeOutOf, currentPhase, releaseButton, releaseSteps, ringOf, RH_WORDS, type ReleasePhase } from "@/lib/robinhood/circle-view";
import { reserveDisplay } from "@/lib/robinhood/reserve-display";
import { robinhoodPublicClient, useEvmWallet } from "@/lib/robinhood/wallet";

import { useWalletUi } from "@/lib/wallet";

import CirclePage, { ActionRow, NextStep, type PageBanner } from "@/components/circle-page/CirclePage";
import CloseOutPanel from "@/components/circle-page/CloseOutPanel";
import PayoutPanel from "@/components/circle-page/PayoutPanel";
import s from "@/components/circle/Circle.module.css";
import rh from "./Robinhood.module.css";

const REFRESH_MS = 8_000;
const NETWORK = { chip: "Robinhood Chain testnet", note: "Test USDG only. It has no value." };

type Busy = { what: string } | null;
type Last = { what: string; result: ActionResult } | null;

// The contract's own payout record (evm/src/OthelloCircle.sol): the confirmation names who was paid from the receipt.

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

export default function RobinhoodCircle({ address }: { address: string }) {
  // Any casing is accepted (an all-caps or all-lowercase link is still this address); a mixed-case one must
  // carry a valid checksum.
  const valid = isAddress(address, { strict: false });
  const circle = (valid ? getAddress(address.toLowerCase()) : "0x0000000000000000000000000000000000000000") as Address;
  const w = useEvmWallet();
  const connectUi = useWalletUi();
  const [trust, setTrust] = useState<TrustResult | null>(null);
  const [view, setView] = useState<RhCircleView | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [last, setLast] = useState<Last>(null);
  const [joinAmt, setJoinAmt] = useState("");
  const [addAmt, setAddAmt] = useState("");
  const [topAmt, setTopAmt] = useState("");
  const [inviteCopy, setInviteCopy] = useState<"idle" | "copied" | "failed">("idle");
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
      // never back to an earlier block: a read that fell back a block (or a lagging RPC node) must not make a payment,
      // a released pot or a cancellation un-happen on screen (adversary on de3c654)
      setView((prev) => (prev && same(prev.address, v.address) && v.block < prev.block ? prev : v));
      setReadFailed(false);
    } catch {
      // the RPC's own error (its URL, the request body) is not for the screen
      if (mine === latest.current) setReadFailed(true);
    } finally {
      if (mine === latest.current) inFlight.current = false;
    }
  }, [valid, circle]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(id);
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
  const release = useCallback(async (round: number) => {
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
        // Who was paid and for which round comes only from this transaction's own receipt, as the adapter read it:
        // another member may have released first, so this one released the next round (Codex r2 on PR #22). With no
        // such event the page names no seat: a plain "done" with the explorer link.
        const paid = result.released;
        const seatOf = paid ? view?.seats.find((x) => same(x.wallet, paid.recipient)) : undefined;
        if (paid && seatOf) {
          setPhase({ kind: "released", hash: result.txHash, round: paid.round, recipientTurn: seatOf.turn, amount: paid.pot });
        } else {
          setPhase({ kind: "idle" });
          setLast({ what: "Release the pot", result });
        }
      }
    } finally {
      onSent.current = null;
      setBusy(null);
      void refresh(true);
    }
  }, [adapter, refresh, view]);

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
          <p className={rh.muted} role="status">{readFailed ? "Couldn't read the circle from Robinhood Chain. The page tries again every few seconds." : "Checking the circle on Robinhood Chain…"}</p>
          {readFailed && (
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
  // The chain's own time: the latest block's timestamp in the last read, never the device clock. Late, "Grace ended"
  // and "Record missed payment" show only once the chain is past grace, when markDelinquent can succeed (Codex r1 on
  // PR #22: a device clock ten minutes fast showed seats late inside grace). Robinhood Chain makes a block about every
  // second and the page reads every 8 s, so this trails the chain by seconds.
  const chainNow = v.chainTime;
  const afterGrace = chainNow > graceEnds;
  const allSettled = v.seats.every((x) => x.paid || x.defaulted);
  const canWrite = Boolean(adapter) && w.onRobinhood && !busy;
  const ring = ringOf(v, w.address, chainNow);
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

  // "Your next step": below the hero while the circle runs; in a finished circle it fills the space under the ring.
  const actBlock = (
    <NextStep>
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
            <ActionRow title="Claim your seat" text={`Lock USDG as your promise plus the ${fmtUsdg(v.g)} guarantee. Your wallet confirms the approval and the join separately.`}>
              <span className={s.amountRow}>
                <input className={s.amount} aria-label="USDG to lock" inputMode="decimal" placeholder="USDG" value={joinAmt} onChange={(e) => setJoinAmt(e.target.value)} />
                <button type="button" className={s.pay} disabled={!canWrite || joinUnits === null} onClick={() => joinUnits !== null && adapter && void run("Join", () => adapter.joinAndLock({ amount: joinUnits }))}>
                  {joinUnits !== null ? `Approve ${fmtUsdg(joinUnits + v.g)} and join` : "Enter USDG to join"}
                </button>
              </span>
            </ActionRow>
          )}
          {v.status === "Forming" && me?.joined && (
            <ActionRow title="Your seat is locked" text="You can leave while the circle is still forming.">
              <button type="button" className={`${s.pay} ${s.payQuiet}`} disabled={!canWrite} onClick={() => adapter && void run("Leave", () => adapter.leaveForming({}))}>
                Leave and take back {fmtUsdg(me.collateral + me.g + me.topUps)}
              </button>
            </ActionRow>
          )}
          {v.status === "Forming" && isCreator && (
            <ActionRow title="Creator controls" text={v.seats.some((seat) => !seat.joined) ? "The circle starts after every seat has joined." : "Everyone is in. Start the first round when you are ready."}>
              <span className={s.actionButtons}>
                <button type="button" className={s.pay} disabled={!canWrite || v.seats.some((seat) => !seat.joined)} onClick={() => adapter && void run("Start the circle", () => adapter.activate({}))}>Start the circle</button>
                <button type="button" className={`${s.pay} ${s.payQuiet}`} disabled={!canWrite} onClick={() => adapter && void run("Cancel the circle", () => adapter.cancelCircle({}))}>Cancel circle</button>
              </span>
            </ActionRow>
          )}
          {v.status === "Active" && me && !me.defaulted && !me.paid && (
            <ActionRow title="Pay this round" text={<>You are paying {fmtUsdg(v.c)} into this round&apos;s pot.</>}>
              <button type="button" className={s.pay} disabled={!canWrite} onClick={() => adapter && void run("Pay this round", () => adapter.contribute({}))}>Approve and pay {fmtUsdg(v.c)}</button>
            </ActionRow>
          )}
          {v.status === "Active" && me && !me.defaulted && (
            <ActionRow title="Strengthen the circle" text={topUnits !== null ? (fill > 0n ? `${fmtUsdg(fill)} covers missed payments; the rest enters the shared reserve.` : `All ${fmtUsdg(topUnits)} enters the shared reserve.`) : "Lock more of your USDG or top up the shared reserve."}>
              <span className={s.amountRow}>
                <input className={s.amount} aria-label="USDG to lock more" inputMode="decimal" placeholder="More USDG" value={addAmt} onChange={(e) => setAddAmt(e.target.value)} />
                <button type="button" className={`${s.pay} ${s.payQuiet}`} disabled={!canWrite || addUnits === null} onClick={() => addUnits !== null && adapter && void run("Lock more", () => adapter.addStock({ amount: addUnits }))}>Approve and lock</button>
              </span>
              <span className={s.amountRow}>
                <input className={s.amount} aria-label="USDG reserve top up" inputMode="decimal" placeholder={paused ? fmtUsdg(v.nextGateShortBy).replace(" USDG", "") : "Reserve USDG"} value={topAmt} onChange={(e) => setTopAmt(e.target.value)} />
                <button type="button" className={`${s.pay} ${s.payQuiet}`} disabled={!canWrite || topUnits === null} onClick={() => topUnits !== null && adapter && void run("Top up", () => adapter.topUpReserve({ amount: topUnits, expectedFill: fill }))}>Approve and top up</button>
              </span>
            </ActionRow>
          )}
          {v.status === "Active" && afterGrace && v.seats.filter((seat) => !seat.paid && !seat.defaulted).map((seat) => (
            <div key={seat.turn}>
              <ActionRow title={`${short(seat.wallet)} missed this round`} text={seat.marked ? (seat.received ? "This member has received a pot and can now be settled in default." : "Recorded late. They have not received a pot, so they cannot be defaulted.") : "Record the missed payment after grace. A late payment can still settle the round."}>
                {!seat.marked ? (
                  <button type="button" className={`${s.pay} ${s.payQuiet}`} disabled={!canWrite} onClick={() => adapter && void run("Record missed payment", () => adapter.markDelinquent({ round: v.round, turn: seat.turn }))}>Record missed payment</button>
                ) : seat.received ? (
                  <button type="button" className={s.pay} disabled={!canWrite} onClick={() => adapter && void run("Settle default", () => adapter.declareDefault({ turn: seat.turn }))}>Settle default</button>
                ) : null}
              </ActionRow>
            </div>
          ))}
          {!me && <p className={s.actFixture}>This wallet is not a member. Anyone can release a settled pot, check payout safety, or record a missed payment after grace.</p>}
        </>
      )}
      {busy && <p className={s.actFixture} role="status">{busy.what}: confirm in your wallet, then wait for Robinhood Chain.</p>}
      {last && <p className={s.actFixture} role="status">{last.result.ok ? <>{last.what}: done. <a className={s.link} href={explorerTx(last.result.txHash)} target="_blank" rel="noreferrer">See it on the explorer</a></> : `${last.what}: ${last.result.message}`}</p>}
    </NextStep>
  );

  const banners: PageBanner[] = [];
  if (paused) banners.push({ kind: "refusal", mark: "!", title: "Payouts are paused", text: `The reserve is ${fmtUsdg(v.nextGateShortBy)} short. Any member can top up to restart it.` });
  if (firstLateUnpaidPrePayout) banners.push({ kind: "neutral", mark: "!", title: "Waiting for a late payment", text: <>The circle can&apos;t move on until {short(firstLateUnpaidPrePayout.wallet)} pays this round. They cannot be defaulted before their turn.</> });
  if (v.surplus > 0n) banners.push({ kind: "neutral", mark: "!", title: `${fmtUsdg(v.surplus)} was sent to this circle by mistake`, text: "Direct transfers are not credited to a member and remain locked. Use only the controls on this page." });

  const joined = v.seats.filter((seat) => seat.joined);
  return (
    <CirclePage
      side="robinhood"
      network={NETWORK}
      banners={banners}
      ring={ring}
      pot={pot}
      round={v.round}
      fmt={fmtUsdg}
      collateral="USDG"
      status={paused ? "Paused" : v.status}
      moneyPill="Test USDG on Robinhood Chain"
      heading={`A savings circle of ${v.n}`}
      sub={<>{fmtUsdg(v.c)} per member each round. One person receives {fmtUsdg(pot)} each round, in the agreed order. Every seat locks test USDG and adds a {fmtUsdg(v.g)} reserve guarantee.</>}
      clock={[
        { label: v.status === "Active" ? "Round" : "Seats joined", value: v.status === "Active" ? `${v.round + 1} of ${v.n}` : `${joined.length} of ${v.n}` },
        { label: v.status === "Active" ? (afterGrace ? "Grace ended" : "Payment due") : "Round length", value: v.status === "Active" ? (afterGrace ? "Late still counts" : when(v.deadline)) : duration(v.roundSecs), over: v.status === "Active" && afterGrace },
        { label: "Pot this round", value: fmtUsdg(pot) },
      ]}
      closeOut={close ? (
        <CloseOutPanel
          words={RH_WORDS}
          close={close}
          completed={v.status === "Completed"}
          canWrite={canWrite}
          blocker={writeBlocker}
          busy={busy?.what === "Withdraw"}
          onWithdraw={() => adapter && void run("Withdraw", () => adapter.withdraw({}))}
        />
      ) : null}
      payout={payoutShown ? (
        <PayoutPanel
          words={RH_WORDS}
          button={payoutShown}
          steps={steps}
          phase={shownPhase}
          showSafetyCheck={paused || coverFailed}
          canWrite={canWrite}
          onRelease={() => void release(v.round)}
          onCheckSafety={() => adapter && void run("Check payout safety", () => adapter.updateCoverage({}))}
          onClose={() => setPhase({ kind: "idle" })}
        />
      ) : null}
      act={actBlock}
      turns={{
        forming: v.status === "Forming" ? { title: `Waiting for ${v.n - joined.length} members to join`, text: `${joined.length} of ${v.n} seats have locked USDG and added their reserve guarantee. Send the invite link to the remaining seats.` } : null,
        label: "Turn order",
        note: `${duration(v.roundSecs)} rounds, ${duration(v.graceSecs)} grace`,
        rounds: v.seats.map((seat) => {
          const current = v.status === "Active" && seat.turn === v.round;
          return { turn: seat.turn, name: short(seat.wallet), note: seat.received ? "Pot paid" : current ? "Receiving now" : "Upcoming", state: current ? "now" : seat.received ? "done" : "" };
        }),
      }}
      reserve={{
        heading: reserve.heading,
        amount: fmtUsdg(reserve.amount),
        unit: "Test USDG",
        coins: joined.map((seat) => seat.turn),
        coinNote: `${joined.length} guarantees deposited, one per joined seat`,
        lines: reserve.lines.map(([sign, label, amount]) => [sign, label, fmtUsdg(amount)] as const),
      }}
      locks={{
        label: "Test USDG promise",
        kicker: "What each seat locks",
        intro: "Robinhood Chain circles use test USDG only. There is no price feed or mainnet token in this testnet flow.",
        steps: [[fmtUsdg(v.minStockCover), "Minimum USDG promise"], [`−${v.haircutBps / 100}%`, "Safety haircut"], [fmtUsdg(v.g), "Reserve guarantee"], ["TEST USDG", "No monetary value"]],
        chips: [["Payment", `${fmtUsdg(v.c)} per round`], ["Rounds", `${v.n} total`], ["Round length", duration(v.roundSecs)]],
      }}
      members={{
        head: `Members (${joined.length} of ${v.n} joined)`,
        note: <><b>Each locked promise belongs to its owner.</b> It returns at the end unless a post-payout default is settled.</>,
        cards: v.seats.map((seat) => {
          const current = v.status === "Active" && seat.turn === v.round;
          return {
            turn: seat.turn,
            you: same(seat.wallet, w.address),
            wallet: seat.wallet,
            creator: same(seat.wallet, v.creator),
            explorer: explorerAddress(seat.wallet),
            stake: seat.joined
              ? <span className={s.stake}><span className={s.lockedLine}><span className={s.lockedLabel}>Locked:</span><b className={`${s.display} ${s.lockedAmt}`}>{fmtUsdg(seat.collateral).replace(" USDG", "")}</b><span className={s.lockedUnit}>USDG</span></span><span className={s.coverLine}>{seat.topUps > 0n ? `Plus ${fmtUsdg(seat.topUps)} added later.` : "Test USDG promise, less the configured safety haircut."}</span></span>
              : <span className={s.coverLine}>Not joined yet: nothing is locked.</span>,
            chips: [
              { label: "This round", value: seat.defaulted ? "Defaulted" : seat.paid ? "Paid" : seat.joined && v.status === "Active" ? "Due" : seat.joined ? "Joined" : "Not joined", tone: seat.defaulted ? "clay" : seat.paid ? "teal" : seat.joined && v.status === "Active" ? "acid" : "" },
              { label: "Pot", value: seat.received ? "Received" : current ? "Receiving" : "Waiting", tone: seat.received ? "teal" : current ? "cobalt" : "" },
              ...(seat.marked ? [{ label: "Status", value: "Late, recorded", tone: "clay" as const }] : []),
              ...(seat.withdrawn ? [{ label: "Status", value: "Withdrawn", tone: "" as const }] : []),
            ],
          };
        }),
      }}
      footer={<><p className={s.helper}>Test USDG is issued by Paxos, which can freeze or change it. If that happens, this circle cannot move until that restriction is lifted.</p><p className={s.helper}>Testnet only. Test USDG has no value. Circle <a className={s.link} href={explorerAddress(v.address)} target="_blank" rel="noreferrer">{short(v.address)}</a>{trustedFactory && <> from trusted factory <a className={s.link} href={explorerAddress(trustedFactory.address)} target="_blank" rel="noreferrer">{short(trustedFactory.address)}</a></>}.</p></>}
    />
  );
}
