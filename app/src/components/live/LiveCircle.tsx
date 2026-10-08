"use client";

/**
 * T18: the demo circle, live from devnet. Reads through /api/circle (the
 * server reads devnet once and shares it) every REFRESH_MS, renders the shared circle page (components/circle-page,
 * Joshua 2026-10-07: one page for both chains) in Solana's words, and gives a
 * connected member one action: pay this round (`contribute`), signed in their
 * own wallet. T18d: and gives ANY connected wallet the three instructions anyone may send
 * (SPEC §5): release the pot once every seat has paid, update coverage, and declare a seat in
 * default once its grace has run out. Nothing in Othello runs by itself.
 *
 * A failed refresh keeps the last good read on screen with the failure shown
 * over it; a first read that fails shows the failure and a retry. Nothing is
 * ever filled in.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";

import CirclePage, { ActionRow, NextStep, type MemberCard, type PageBanner } from "@/components/circle-page/CirclePage";
import CloseOutPanel from "@/components/circle-page/CloseOutPanel";
import CopyLink from "@/components/circle-page/CopyLink";
import PayoutPanel from "@/components/circle-page/PayoutPanel";
import s from "@/components/circle/Circle.module.css";
import Shell from "@/components/othello/Shell";
import { type CircleStatus, coverageLabel, defaultRecovered, derive, execValue, formatDuration, formatRaw, formatUsdc, fundValue, obligations, releaseBlock, seatSet, shortAddress, stockCover } from "@/lib/circle";
import { payoutSteps, type ChainWords, type CloseOut, type ReleasePhase } from "@/lib/core/circle-page";
import { ringOf, seatLabel } from "@/lib/core/ring";
import { solToList } from "@/lib/to-list-solana";
import { addStockIx, declareDefaultIx, parseUnits, releasePotIx, topUpReserveIx, updateCoverageIx, withdrawIx } from "@/lib/actions";
import { contributeIx, explainFailure } from "@/lib/contribute";
import { DEMO_CIRCLE, LABELS, explorer, liveCircleUrl, liveKeyOf } from "@/lib/devnet";
import type { LiveCircle as Live } from "@/lib/live";
import { multiplierAt } from "@/lib/scaledUi";

import SolanaPanel from "./SolanaPanel";

const REFRESH_MS = 5_000;
const USDC_WORD = "test USDC";
// what pays a defaulted seat's share of a round: the escrow its default prepaid (declare_default sells the stock only
// up to the debt and the reserve pays the rest, SPEC.md section 6), never "the locked stock"
const COVERED = "the escrow its default prepaid";
/** An amount a member sends, to the base unit: whole test USDC without decimals, else as many as it has (adversary on b28e8d2). */
const exactUsdc = (base: number) => formatUsdc(base, base % 1_000_000 === 0 ? 0 : base % 10_000 === 0 ? 2 : 6);
/** Solana's money in its own words: base units of test USDC (6 decimals). */
// to the cent, or to the base unit when an amount has more: a shortfall shown rounded down would leave the round unfunded
// after a top-up of the figure shown (adversary on 5a46c40)
const usdc = (base: bigint) => `${formatUsdc(Number(base), base % 10_000n === 0n ? 2 : 6)} ${USDC_WORD}`;

/**
 * One transaction at a time, whichever button sent it; `what` names it in the status line, `round` is the round the
 * read showed when it was sent: its outcome belongs to that round and is not shown once the read has moved on
 * (adversary on a76dfd8: round 1's "Payment: done." showed under round 2's payment due); `by` is the wallet that
 * sent it, and another wallet is never shown it (adversary on 84686f9).
 */
// Each transaction carries the wallet that sent it (`by`) and the round and status of the read it was sent from: its
// outcome belongs to that wallet, that round and that state of the circle.
type Sent = { what: string; round: number; status: CircleStatus; by: string };
type Pay =
  | { phase: "idle" }
  | ({ phase: "wallet" } & Sent)
  | ({ phase: "confirming"; sig: string } & Sent)
  | ({ phase: "done"; sig: string } & Sent)
  | ({ phase: "failed"; reason: string; sig?: string } & Sent);

function isRejection(e: unknown): boolean {
  const inner = (e as { error?: { code?: number; message?: string } }).error;
  if (inner?.code === 4001) return true;
  return /reject|declin|denied|cancel/i.test(`${e instanceof Error ? e.message : String(e)} ${inner?.message ?? ""}`);
}

/**
 * `address`: any Othello circle (default the demo; Joshua 2026-10-06, circles opened from the shared list). `seat`
 * and `kind`: a seat page (/circle/<id>/position/N, /join/N) is this page with that seat in focus (Joshua
 * 2026-10-07: the seat pages move onto the shared circle page).
 */
export default function LiveCircle({ address = DEMO_CIRCLE, seat, kind }: { address?: string; seat?: number; kind?: "position" | "join" }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [payState, setPay] = useState<Pay>({ phase: "idle" });
  // T18g: the member's own amounts, typed as decimals and converted exactly (parseUnits).
  const [lockAmt, setLockAmt] = useState("0.1");
  const [topAmt, setTopAmt] = useState("10");
  // Only the latest read may write: a slow response must not put an older circle back.
  const latest = useRef(0);
  // The round, seat and pot a release was sent for: release_pot names its recipient, so a release that succeeds paid
  // exactly that seat for that round (a stale one is refused); the payout panel confirms it from this.
  const releasing = useRef<{ round: number; turn: number; amount: bigint } | null>(null);

  const refresh = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const res = await fetch(liveCircleUrl(address), { cache: "no-store" });
      const body = (await res.json()) as Live | { error: string };
      if (mine !== latest.current) return;
      if ("error" in body) throw new Error(body.error);
      setLive(body);
      setError(null);
    } catch (e) {
      if (mine === latest.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [address]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const you = wallet.publicKey?.toBase58() ?? null;
  // only the wallet that sent a transaction sees it (in flight or finished), never the next wallet connected here
  const pay: Pay = payState.phase !== "idle" && payState.by !== you ? { phase: "idle" } : payState;
  // but the page follows one transaction at a time, whichever wallet sent it: a second send would overwrite the first's
  // progress while it is still in flight (adversary on 8e069e5), so every send waits for it
  const busy = payState.phase === "wallet" || payState.phase === "confirming";
  const othersInFlight = busy && payState.by !== you;
  const yourTurn = live && you ? (live.view.members.find((m) => m.address === you)?.turn ?? null) : null;

  const send = useCallback(
    async (what: string, build: (me: PublicKey) => Promise<TransactionInstruction>) => {
      if (!live || !wallet.publicKey) return;
      const { round, status } = live.view;
      const by = wallet.publicKey.toBase58();
      setPay({ phase: "wallet", what, round, status, by });
      // Once the wallet returns a signature the transaction was sent, and the fee is spent, even
      // if the chain then refuses it: the screen must never say "not sent" after that point.
      let sent: string | null = null;
      try {
        const ix = await build(wallet.publicKey);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(ix);
        const sig = await wallet.sendTransaction(tx, connection);
        sent = sig;
        setPay({ phase: "confirming", what, sig, round, status, by });
        const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        if (res.value.err) {
          const t = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          throw Object.assign(new Error(JSON.stringify(res.value.err)), { logs: t?.meta?.logMessages ?? [], onChain: true });
        }
        setPay({ phase: "done", what, sig, round, status, by });
        await refresh();
      } catch (e) {
        const reason = !sent
          ? isRejection(e)
            ? "you declined in your wallet. Nothing was sent."
            : `not sent. ${explainFailure(e)}`
          : (e as { onChain?: boolean }).onChain
            ? `sent, and the program refused it. ${explainFailure(e)}`
            : `sent, but not confirmed: ${explainFailure(e)}. Check the transaction below.`;
        setPay(sent ? { phase: "failed", what, reason, sig: sent, round, status, by } : { phase: "failed", what, reason, round, status, by });
        if (sent) await refresh();
      }
    },
    [live, wallet, connection, refresh],
  );

  const onPay = useCallback(
    () =>
      live &&
      send("Payment", (me) => contributeIx(me, new PublicKey(live.accounts.circle), new PublicKey(live.accounts.usdcMint))),
    [live, send],
  );

  // a read of another circle (the route moved on to a new address) is not drawn while this one's loads
  if (!live || live.accounts.circle !== address) {
    return (
      <Shell active="Circles" side="solana">
        <div className={s.frame}>
          <div className={s.banners} style={{ padding: 24 }}>
            {error ? (
              <div className={`${s.banner} ${s.bannerRefusal}`} role="status">
                <span className={s.bannerMark} aria-hidden>?</span>
                <span className={s.bannerBody}>
                  <span className={s.bannerTitle}>Live data unavailable</span>
                  <p className={s.bannerText}>{error}</p>
                  <button type="button" className={s.pay} onClick={() => void refresh()}>
                    Try again
                  </button>
                </span>
              </div>
            ) : (
              <p className={s.panelNote}>Reading the {address === DEMO_CIRCLE ? "demo " : ""}circle from devnet…</p>
            )}
          </div>
        </div>
      </Shell>
    );
  }

  const c = live.view;
  const now = live.readAt;
  if (seat !== undefined && seat > c.n) {
    return (
      <Shell active="Circles" side="solana">
        <div className={s.frame}>
          <div className={s.banners} style={{ padding: 24 }}>
            <p className={s.panelNote}>This circle has {c.n} seats; there is no seat {seat}.</p>
          </div>
        </div>
      </Shell>
    );
  }
  const mirrorNow = multiplierAt(live.split, Math.floor(Date.now() / 1000));

  let text: string;
  let button: { label: string; enabled: boolean } | null = null;
  if (!you) {
    text = "Members pay from their own wallet. Connect one to pay this round.";
  } else if (yourTurn === null) {
    text = "This wallet is not a member of this circle. You are viewing it.";
  } else if (c.status !== "Active") {
    text = `Contributions open while the circle is Active. It is ${c.status}.`;
  } else if (seatSet(c.defaultedBitmap, yourTurn)) {
    // declare_default sells the stock up to what the seat owes and the reserve pays the shortfall as far as it can; what
    // it cannot is the escrow deficit, cured by a top-up (SPEC.md section 6; adversary on 3f0dc00 and cda5631)
    text = c.escrowDeficit > 0
      ? `This seat has defaulted. Its stock was sold and the shared reserve paid what it could, but the circle's escrow is still ${formatUsdc(c.escrowDeficit)} ${USDC_WORD} short of the prepaid payments; a reserve top-up cures it.`
      : "This seat has defaulted. Declaring the default prepaid its remaining payments: its stock was sold, and the shared reserve paid any shortfall.";
  } else if (seatSet(c.paidBitmap, yourTurn)) {
    text = `You have paid round ${c.round + 1}.`;
    button = { label: "Paid", enabled: false };
  } else {
    text = `Seat ${yourTurn + 1}: your ${exactUsdc(c.contribution)} ${USDC_WORD} for round ${c.round + 1} is due.`;
    button = { label: `Pay ${exactUsdc(c.contribution)} ${USDC_WORD}`, enabled: !busy };
  }

  // a release's progress, refusal and transaction link are the shared payout panel's, which shows a refusal only in
  // the round it was sent for (adversary on fd9d764: a refusal from a round the read had left stayed here)
  const isRelease = pay.phase !== "idle" && pay.what.startsWith("Release");
  // a finished action's outcome (done, declined, refused) from a round the read has left is not shown here
  // (or from a state it has left: the last round's payment once the circle has completed)
  const stale = (pay.phase === "done" || pay.phase === "failed") && (pay.round !== c.round || pay.status !== c.status);
  const status = othersInFlight ? `${you ? "Another wallet's" : "A"} transaction is still waiting for its wallet or for devnet. Sending opens again once it settles.` :
    isRelease || stale ? null :
    pay.phase === "wallet"
      ? `${pay.what}: approve it in your wallet.`
      : pay.phase === "confirming"
        ? `${pay.what}: sent. Confirming on devnet…`
        : pay.phase === "failed"
          ? `${pay.what}: ${pay.reason}`
          : null;
  const sig = isRelease || stale ? null : pay.phase === "confirming" || pay.phase === "done" ? pay.sig : pay.phase === "failed" ? (pay.sig ?? null) : null;

  // The anyone-may-send actions (SPEC §5), enabled only when the program's own conditions hold
  // by this read; the program still checks, and a refusal is shown in its own words.
  const keys = {
    circle: new PublicKey(live.accounts.circle),
    usdcMint: new PublicKey(live.accounts.usdcMint),
    stockMint: new PublicKey(live.accounts.stockMint),
    members: [...c.members].sort((a, b) => a.turn - b.turn).map((m) => new PublicKey(m.address)),
  };
  const active = c.status === "Active";
  const owing = c.members.filter((m) => !seatSet(c.paidBitmap, m.turn) && !seatSet(c.defaultedBitmap, m.turn));
  // SPEC §5: a defaulted seat that has not paid is covered from the escrow its stock sale funded.
  const covered = c.members.filter((m) => !seatSet(c.paidBitmap, m.turn) && seatSet(c.defaultedBitmap, m.turn));
  // what the escrow lacks of the defaulted seats' share of this round; release_pot refuses the round until it holds it
  const escrowShortBy = active ? BigInt(Math.max(0, c.contribution * covered.length - c.escrow)) : 0n;
  const recipient = c.members.find((m) => m.turn === c.round);
  const wallClock = Math.floor(Date.now() / 1000);
  // SPEC §5 / I7: strictly after deadline + grace, only a seat that has received and has not paid.
  const defaultable =
    active && wallClock > c.roundDeadline + c.graceSecs
      ? c.members.filter((m) => !seatSet(c.paidBitmap, m.turn) && seatSet(c.receivedBitmap, m.turn) && !seatSet(c.defaultedBitmap, m.turn))
      : [];
  const canSend = !!wallet.publicKey && !busy;

  // Codex T18d r1: every condition this read already knows the program checks. A stale price or a
  // repricing blocks release_pot and update_coverage (price_stale, multiplier_price_mismatch);
  // Paused (next_gate_short_by > 0) blocks release_pot (reserve_overcommitted); a stale price or a
  // pool without the USDC to buy the stock blocks declare_default (price_stale, pool_insufficient).
  const dv = derive(c, wallClock);
  // price and split disagreeing holds payouts while the circle runs and joins while it forms (join_and_lock,
  // release_pot and update_coverage refuse: SPEC.md I13); a finished circle has nothing waiting on the price (adversary
  // on 3f0dc00 and cda5631). Cover figures stay "not countable" whatever the status: the price is still set for the old
  // multiplier.
  const forming = c.status === "Forming";
  const repricing = (active || forming) && dv.repricing;
  // A feed that was never priced reads as fresh after touch_prices but prices at 0, which the
  // program refuses as PriceStale (adversary pass 3's suspicion; admin-only, cheap to state).
  const priceBlock = c.feed.wrapperPrice === 0 || c.feed.sharePrice === 0
    ? "No price has been set for the stock yet, and the program acts only on a set, fresh price."
    : dv.stale
    ? `The price is ${formatDuration(dv.priceAge)} old, and the program acts only on a fresh one.`
    : repricing
      ? "Price and split disagree (repricing): the program waits for a price set for the new multiplier."
      : null;
  // SPEC.md:129: Paused (next_gate_short_by > 0) is only as fresh as the last update_coverage /
  // release_pot / declare_default / top_up_reserve, and "the UI ... never disables Release pot on
  // it: the program refuses with numbers if the gate fails". release_pot recomputes the gate itself
  // (adversary pass 3 proved a Paused circle whose release the program accepts), so Paused only
  // adds a note here, never a disabled button.
  // the shared rule (lib/circle.ts releaseBlock), which the circles list uses too
  const canRelease = releaseBlock(c, wallClock) === null;
  const canCover = active && !priceBlock;
  const defaults = defaultable.map((m) => {
    const needs = defaultRecovered(c, m, live.pool.discountBps);
    return { m, needs, poolShort: live.pool.usdc < needs };
  });
  const releaseText = !active
    ? `The circle is ${c.status}; these open while it is Active.`
    : owing.length > 0
      ? `The pot can be released once every seat has paid or been declared in default. Still to pay: ${owing.map((m) => m.name).join(", ")}.`
      : releaseBlock(c, wallClock) === "escrow-short"
        ? `Every seat is settled, but the escrow holds ${formatUsdc(c.escrow)} ${USDC_WORD} and the defaulted seats' share of this round is ${formatUsdc(c.contribution * covered.length)}: the program refuses the release until the escrow can pay it.`
      : priceBlock
        ? `Every seat is settled, but the pot waits. ${priceBlock}`
        : dv.paused
          ? `Every seat is settled. At the last coverage check (${c.lastCoverageAt ? `${formatDuration(wallClock - c.lastCoverageAt)} ago` : "not yet run"}) payouts were paused, ${formatUsdc(c.nextGateShortBy)} ${USDC_WORD} short. Anyone can still try to release the pot to ${recipient?.name ?? "this round's seat"}: the program re-checks the reserve and refuses, with the numbers, if it is still short.`
          : `${covered.length ? `Every other seat has paid, and ${covered.map((m) => m.name).join(", ")} is covered by the default` : "Every seat has paid"}: anyone can release the pot to ${recipient?.name ?? "this round's seat"}.`;
  const defaultText = defaults
    .map(({ m, needs, poolShort }) =>
      dv.stale || c.feed.wrapperPrice === 0
        ? `${m.name} can be declared in default once the stock has a fresh price.`
        : poolShort
          ? `${m.name} can be declared in default, but the liquidation pool holds ${formatUsdc(live.pool.usdc)} ${USDC_WORD} and buying the stock needs ${formatUsdc(needs)}; it waits until the pool is refilled.`
          : `${m.name} took the pot and has not paid after the grace: anyone can declare the default.`,
    )
    .join(" ");
  const anyone = (
    <div className={s.action} aria-live="polite">
      <span className={s.actionText}>
        <span className={s.bannerTitle}>Anyone can move the circle on</span>
        <p className={s.bannerText}>
          {releaseText} {defaultText ? `${defaultText} ` : ""}
          {active && !canCover && owing.length > 0 && priceBlock ? `${priceBlock} ` : ""}
          {wallet.publicKey
            ? "Your wallet signs and pays the devnet costs (the fee, plus the rent for the recipient's test USDC account if it has none yet); it receives nothing."
            : "Connect any devnet wallet to send these. It pays the fee in devnet SOL (free from faucet.solana.com)."}
        </p>
      </span>
      <span className={s.actionButtons}>
        {defaults.map(({ m, poolShort }) => (
          <button
            key={m.turn}
            type="button"
            className={s.pay}
            disabled={!canSend || dv.stale || c.feed.wrapperPrice === 0 || poolShort}
            onClick={() => void send(`Default on ${m.name}`, (me) => declareDefaultIx(me, keys, m.turn))}
          >
            Declare {m.name} in default
          </button>
        ))}
        <button
          type="button"
          className={`${s.pay} ${s.payQuiet}`}
          disabled={!canSend || !canCover}
          onClick={() => void send("Coverage update", (me) => updateCoverageIx(me, keys))}
        >
          Update coverage
        </button>
      </span>
    </div>
  );

  // T18g: what the connected member can do with their own seat (SPEC §5): lock more stock and top
  // up the reserve while the circle runs (not after a default), withdraw once it has ended. Each is
  // enabled only when those conditions hold by this read; the program checks again and any refusal
  // (InsufficientBalance, NotFinished, ...) is shown in its own words.
  // Adversary pass 5: the read lists every configured seat, joined or not; only a JOINED seat has a
  // Member account, so only a joined seat gets tools (SPEC.md:112, :114).
  const mine = yourTurn !== null && seatSet(c.joinedBitmap, yourTurn) ? c.members.find((m) => m.turn === yourTurn) : undefined;
  const mineDefaulted = yourTurn !== null && seatSet(c.defaultedBitmap, yourTurn);
  const mineWithdrawn = yourTurn !== null && seatSet(c.withdrawnBitmap, yourTurn);
  const ended = c.status === "Completed" || c.status === "Cancelled";
  const lockUnits = parseUnits(lockAmt, 8);
  const topUnits = parseUnits(topAmt, 6);
  const memberTools = mine ? (
    <div className={s.action} aria-live="polite">
      <span className={s.actionText}>
        <span className={s.bannerTitle}>Your seat: {mine.name}</span>
        <p className={s.bannerText}>
          {/* worded from what the seat still holds, as the close-out panel is: a defaulted seat's stock can be sold in full
              (declare_default sells min(stock, debt); adversary on 487fe28) */}
          {ended
            ? mineWithdrawn
              ? "You have withdrawn what your seat held."
              : mine.lockedRaw > 0
                ? "The circle has ended: withdraw your remaining stock and whatever your seat still holds in the reserve."
                : mineDefaulted
                  ? "The circle has ended. Your locked stock went to cover missed payments: withdraw whatever is left for your seat."
                  : "The circle has ended: withdraw whatever your seat still holds in the reserve."
            : mineDefaulted
              ? "This seat has defaulted, so it cannot add stock or top up."
              : "Lock more of the NFLXx devnet mirror to raise your cover (amounts are tokens before the multiplier), or top up the shared reserve in test USDC (it fills any payout shortfall first)."}
        </p>
      </span>
      {!ended && !mineDefaulted && (
        <span className={s.actionButtons}>
          <label className={s.amountRow}>
            <input className={s.amount} inputMode="decimal" value={lockAmt} onChange={(e) => setLockAmt(e.target.value)} aria-label="NFLXx devnet mirror to lock" />
            <button type="button" className={`${s.pay} ${s.payQuiet}`} disabled={!canSend || lockUnits === null || !(active || c.status === "Forming")}
              onClick={() => lockUnits !== null && void send("Lock more stock", (me) => addStockIx(me, keys, lockUnits))}>
              Lock {lockAmt || "0"} NFLXx mirror
            </button>
          </label>
          <label className={s.amountRow}>
            <input className={s.amount} inputMode="decimal" value={topAmt} onChange={(e) => setTopAmt(e.target.value)} aria-label="Test USDC to add to the reserve" />
            <button type="button" className={`${s.pay} ${s.payQuiet}`} disabled={!canSend || topUnits === null || !active}
              onClick={() => topUnits !== null && void send("Top up", (me) => topUpReserveIx(me, keys, topUnits))}>
              Top up {topAmt || "0"} {USDC_WORD}
            </button>
          </label>
        </span>
      )}
    </div>
  ) : null;

  const action = (
    <div className={s.action} aria-live="polite">
      <span className={s.actionText}>
        <span className={s.bannerTitle}>{text}</span>
        {status && <p className={s.bannerText}>{status}</p>}
        {sig && (
          <p className={s.bannerText}>
            {pay.phase === "done" ? `${pay.what}: done. ` : ""}
            <a className={s.link} href={explorer("tx", sig)} target="_blank" rel="noreferrer">
              View the transaction
            </a>
          </p>
        )}
      </span>
      {button && (
        <button type="button" className={s.pay} disabled={!button.enabled} onClick={() => void onPay()}>
          {button.label}
        </button>
      )}
    </div>
  );

  // ---------------------------------------------------------------- the shared circle page, in Solana's words
  const stockUnit = `${c.stockSymbol.replace(/\s*mirror$/i, "")} devnet mirror`;
  const words: ChainWords = { fmt: usdc, txUrl: (h) => explorer("tx", h), chain: "Solana devnet", locked: stockUnit, testNote: "Test USDC only; it has no value.", payer: "program" };
  const listed = solToList(live, you);
  const pot = BigInt(c.contribution) * BigInt(c.n);
  const ring = ringOf(listed, you, now, { fmt: usdc, collateral: stockUnit, covered: COVERED });
  const gateNeeded = dv.remains + c.nextGateShortBy;
  const joinedCount = dv.joined;

  // The release, through the shared payout panel (the same six steps as Robinhood's), followed from this page's own
  // transaction: the wallet, sent (its signature), then the program's answer.
  const releasePhase: ReleasePhase = pay.phase === "idle" || !pay.what.startsWith("Release")
    ? { kind: "idle" }
    : pay.phase === "wallet" ? { kind: "wallet" }
    : pay.phase === "confirming" ? { kind: "sent", hash: pay.sig }
    : pay.phase === "done" && releasing.current ? { kind: "released", hash: pay.sig, round: releasing.current.round, recipientTurn: releasing.current.turn, amount: releasing.current.amount }
    : pay.phase === "failed" ? { kind: "failed", message: pay.reason, error: pay.reason, round: releasing.current?.round ?? c.round, hash: pay.sig }
    : { kind: "idle" };
  // a failure from a round or a circle state the read has already left is not shown (two members releasing at once;
  // the last round's release refused or unconfirmed after the circle completed: adversary on 2781941)
  const shownRelease: ReleasePhase = releasePhase.kind === "failed" && (releasePhase.round !== c.round || (pay.phase === "failed" && pay.status !== c.status)) ? { kind: "idle" } : releasePhase;
  const coverRefused = shownRelease.kind === "failed" && /CoverageTooLow|ReserveOvercommitted/.test(shownRelease.error);
  const steps = payoutSteps({ n: c.n, round: c.round, seats: listed.seats, gateShortBy: BigInt(c.nextGateShortBy), checked: c.lastCoverageAt > 0, finished: c.status === "Completed", escrowShortBy: escrowShortBy }, shownRelease, words,
    { coverRefused, unfunded: shownRelease.kind === "failed" && /RoundNotFunded/.test(shownRelease.error) });
  const releaseLabel = `Release pot${recipient ? ` to ${recipient.name}` : ""}`;
  // drawn while the circle runs, and while a release from this page is in flight or has an outcome in this round:
  // the last round's release can land (status Completed, same round) before its confirmation (adversary on 84686f9)
  const payout = active || shownRelease.kind !== "idle" ? (
    <PayoutPanel
      words={words}
      button={{ label: releaseLabel, enabled: canSend && canRelease, blocker: null, recipientTurn: recipient?.turn ?? c.round, amount: pot }}
      steps={steps}
      phase={shownRelease}
      showSafetyCheck={dv.paused || coverRefused}
      canWrite={canSend && canCover}
      onRelease={() => {
        if (!recipient) return;
        releasing.current = { round: c.round, turn: recipient.turn, amount: pot };
        void send(releaseLabel, (me) => releasePotIx(me, keys, new PublicKey(recipient.address)));
      }}
      onCheckSafety={() => void send("Coverage update", (me) => updateCoverageIx(me, keys))}
      onClose={() => setPay({ phase: "idle" })}
    />
  ) : null;

  // A finished circle: each joined member (every member of a Completed one) withdraws their own seat. The stock is
  // valued at withdraw time, so no amount is named here.
  const completed = c.status === "Completed";
  const owes = (turn: number) => completed || seatSet(c.joinedBitmap, turn);
  const ordered = [...c.members].sort((a, b) => a.turn - b.turn);
  const owedSeats = ordered.filter((m) => owes(m.turn));
  const close: CloseOut | null = ended ? {
    title: completed ? `All ${c.n} rounds are paid out` : "This circle was cancelled",
    body: completed
      ? `Each member now collects whatever ${stockUnit} their seat still has locked, plus any share of what is left in the shared reserve. Only the member's own wallet can collect it, and it does not expire.`
      : `It was cancelled before it started. Each member who joined collects their locked ${stockUnit}, guarantee and any top ups back. Only the member's own wallet can collect it, and it does not expire.`,
    seats: ordered.map((m) => ({ turn: m.turn, label: seatLabel(m.turn), wallet: m.address, you: m.address === you, collected: seatSet(c.withdrawnBitmap, m.turn), owed: owes(m.turn), amount: null })),
    collected: owedSeats.filter((m) => seatSet(c.withdrawnBitmap, m.turn)).length,
    owedCount: owedSeats.length,
    mine: yourTurn !== null ? { turn: yourTurn, collected: mineWithdrawn, owed: owes(yourTurn), locked: null, pooled: null, total: null, // "went to cover missed payments" only for a seat in default whose stock is gone: a seat can join with no stock
    // (join_and_lock takes stock_raw 0 when the guarantee meets min_stock_cover; adversary on 5a46c40)
    lockedLeft: (c.members.find((m) => m.turn === yourTurn)?.lockedRaw ?? 0) > 0 || !seatSet(c.defaultedBitmap, yourTurn) } : null,
  } : null;
  const closeOut = close ? (
    <CloseOutPanel
      words={words}
      close={close}
      completed={completed}
      canWrite={canSend}
      blocker={!wallet.publicKey ? "Connect the devnet wallet of your seat to collect." : busy ? `${othersInFlight ? "Another wallet's" : "A"} transaction is still waiting for its wallet or for devnet.` : null}
      // the button asks for the wallet only while the wallet asks; once sent, the status line follows it on devnet
      busy={pay.phase === "wallet" && pay.what === "Withdraw"}
      onWithdraw={() => void send("Withdraw", (me) => withdrawIx(me, keys))}
    />
  ) : null;

  const banners: PageBanner[] = [];
  if (error) banners.push({ kind: "refusal", mark: "?", title: "Live data unavailable", text: `The last read of devnet failed (${error}). Showing the read from ${formatDuration(wallClock - live.readAt)} ago.` });
  if (repricing) banners.push({ kind: "neutral", mark: "!", title: "Repricing. Price and split disagree.", text: forming ? "Joins wait. The demo admin sets a price for the new multiplier, then seats can join." : "Payouts wait. The demo admin sets a price for the new multiplier, then anyone can update coverage." });
  if (dv.stale) banners.push({ kind: "neutral", mark: "?", title: `Prices are ${formatDuration(dv.priceAge)} old`, text: "Recheck after update." });
  if (dv.paused) banners.push({ kind: "refusal", mark: "!", title: "Payouts paused.", text: `The next payout needs ${formatUsdc(gateNeeded)} ${USDC_WORD} of reserve and ${formatUsdc(dv.remains)} remains. Top up ${formatUsdc(c.nextGateShortBy)} ${USDC_WORD}, returned pro rata at the end, minus any default losses.` });
  // waiting only for the seats that can still pay: a seat in default never pays again (contribute refuses it) and the
  // release pays its share from the escrow (adversary on af399a9)
  if (active && owing.length > 0 && !repricing) banners.push({ kind: "neutral", mark: String(owing.length), title: `${owing.length} ${owing.length === 1 ? "contribution" : "contributions"} still missing`, text: `Once ${owing.length === 1 ? owing[0]!.name : `${owing.length} seats`} ${owing.length === 1 ? "has" : "have"} paid${dv.paused ? " and the reserve covers the next payout" : ""}${dv.stale ? " and the price is fresh" : ""}${escrowShortBy > 0n ? ` and a reserve top-up funds the ${usdc(escrowShortBy)} the escrow lacks of the defaulted seats' share` : ""}, anyone can release the pot${dv.recipient ? ` to ${dv.recipient.name}` : ""}. Paying late still counts.` });

  // the clock: what is due now, by the chain's last read
  const defaultableNow = active && dv.toGraceEnd < 0 ? c.members.filter((m) => !seatSet(c.paidBitmap, m.turn) && seatSet(c.receivedBitmap, m.turn) && !seatSet(c.defaultedBitmap, m.turn)) : [];
  // no round runs outside Active: a forming circle's pot is what each round will pay, a completed one's what each paid,
  // and a cancelled one never ran a round (cancel_circle runs only while Forming; adversary on 401fac3)
  const clock = c.status === "Cancelled"
    ? [{ label: "Seats joined", value: `${joinedCount} of ${c.n}` }, { label: "Rounds run", value: "None" }]
    : c.status === "Completed"
      ? [{ label: "Rounds paid out", value: `${c.n} of ${c.n}` }, { label: "Pot each round", value: usdc(pot) }]
    : !active
    ? [{ label: "Seats joined", value: `${joinedCount} of ${c.n}` }, { label: "Round length", value: formatDuration(c.roundSecs) }, { label: "Pot each round", value: usdc(pot) }]
    : dv.toDeadline <= 0
      ? [{ label: "Paid this round", value: `${c.n - dv.missing} of ${c.n}` },
          defaultableNow.length > 0 ? { label: "Can be declared in default", value: defaultableNow.map((m) => m.name).join(", "), over: true } : { label: dv.toGraceEnd > 0 ? "Grace ends in" : "Deadline passed", value: dv.toGraceEnd > 0 ? formatDuration(dv.toGraceEnd) : "Late still counts", over: dv.toGraceEnd <= 0 },
          { label: "Pot this round", value: usdc(pot) }]
      : [{ label: "Round", value: `${c.round + 1} of ${c.n}` }, { label: "Round closes in", value: formatDuration(dv.toDeadline) }, { label: "Pot this round", value: usdc(pot) }];

  const m0 = ordered.find((m) => seatSet(c.joinedBitmap, m.turn));
  const cards: MemberCard[] = ordered.map((m) => {
    const joined = seatSet(c.joinedBitmap, m.turn);
    const paid = seatSet(c.paidBitmap, m.turn);
    const received = seatSet(c.receivedBitmap, m.turn);
    const defaulted = seatSet(c.defaultedBitmap, m.turn);
    const withdrawn = seatSet(c.withdrawnBitmap, m.turn);
    const isNow = active && m.turn === c.round;
    return {
      turn: m.turn,
      you: yourTurn === m.turn,
      wallet: m.address,
      creator: m.address === c.creator,
      explorer: explorer("address", m.address),
      stake: joined
        ? <span className={s.stake}><span className={s.lockedLine}><span className={s.lockedLabel}>Locked:</span><b className={`${s.display} ${s.lockedAmt}`}>{formatRaw(m.lockedRaw)}</b><span className={s.lockedUnit}>{stockUnit}</span></span><span className={s.coverLine}>{dv.repricing ? "Cover not countable while price and split disagree" : <>Counts as <b>{formatUsdc(stockCover(m, c))} {USDC_WORD}</b> of cover</>}</span></span>
        : <span className={s.coverLine}>Not joined yet: nothing locked.</span>,
      chips: [
        { label: "This round", value: defaulted ? "Defaulted" : !joined ? "Not joined" : !active ? (withdrawn ? "Withdrawn" : ended ? "To withdraw" : "Joined") : paid ? "Paid" : "Due", tone: defaulted ? "clay" : !joined || !active ? "" : paid ? "teal" : "acid" },
        { label: "Pot", value: received ? "Received" : isNow ? "Receiving" : c.status === "Cancelled" ? "None (cancelled)" : "Waiting", tone: received ? "teal" : isNow ? "cobalt" : "" },
        // a defaulted seat's remaining payments are prepaid (SPEC.md Member.last_coverage_bps), whatever rounds_paid says
        { label: "Owed", value: !joined ? "—" : seatSet(c.defaultedBitmap, m.turn) ? "Prepaid" : `${formatUsdc(obligations(c, m))} ${USDC_WORD}`, tone: "" },
        { label: "Coverage", value: !joined ? "—" : dv.repricing ? "Not countable" : coverageLabel(c, m), tone: "" },
      ],
    };
  });

  // a seat page: that seat's card first
  const fm = seat !== undefined ? ordered.find((m) => m.turn === seat - 1) : undefined;
  const fmJoined = fm ? seatSet(c.joinedBitmap, fm.turn) : false;
  const focus = fm ? (
    <ActionRow
      title={`Seat ${fm.turn + 1}: ${fm.name}${fm.address === you ? " (you)" : ""}`}
      text={kind === "join" && !fmJoined
        ? c.status === "Forming"
          ? `This seat has not joined yet. Joining locks the ${stockUnit} as cover and adds the ${formatUsdc(c.guaranteePerMember)} ${USDC_WORD} guarantee. Joining from this page opens in the next update; until then the seat joins from the Othello devnet tools.${repricing ? " Joining waits until the price is set for the new multiplier." : priceBlock ? " Joining waits for a set, fresh price." : ""}`
          : `This seat never joined, and the circle is ${c.status}: it can no longer be joined.`
        : !fmJoined
          ? "This seat has not joined yet: nothing is locked."
          : `Locked ${formatRaw(fm.lockedRaw)} ${stockUnit}, counting as ${dv.repricing ? "no cover while price and split disagree" : `${formatUsdc(stockCover(fm, c))} ${USDC_WORD} of cover`}. ${seatSet(c.defaultedBitmap, fm.turn) ? "Defaulted: its remaining payments are prepaid." : `Owes ${formatUsdc(obligations(c, fm))} ${USDC_WORD}.`} ${seatSet(c.receivedBitmap, fm.turn) ? "Has received the pot." : c.status === "Cancelled" ? "The circle was cancelled before any round ran." : `Receives the pot in round ${fm.turn + 1}.`}`}
    />
  ) : null;

  return (
    <CirclePage
      side="solana"
      topLine={<>Live from devnet: <a className={s.link} href={explorer("address", address)} target="_blank" rel="noreferrer">circle {shortAddress(address)}</a>, read {formatDuration(wallClock - live.readAt)} ago. Collateral is the {LABELS.nflxxMirror}; money is {USDC_WORD}.{live.split.effectiveAt > wallClock && live.split.newMultiplier !== live.split.multiplier ? ` Split scheduled: x${live.split.multiplier} to x${live.split.newMultiplier} in ${formatDuration(live.split.effectiveAt - wallClock)}.` : ""}</>}
      banners={banners}
      ring={ring}
      pot={pot}
      round={c.round}
      fmt={usdc}
      collateral={stockUnit}
      covered={COVERED}
      status={repricing ? "Repricing" : dv.paused ? "Paused" : c.status}
      moneyPill={`Test USDC on Solana devnet · ${stockUnit} as cover`}
      heading={`A savings circle of ${c.n}`}
      sub={<>{usdc(BigInt(c.contribution))} per member each round. One person receives {usdc(pot)} each round, in the agreed order. Every seat locks the {stockUnit} as cover and adds a {usdc(BigInt(c.guaranteePerMember))} reserve guarantee.</>}
      clock={clock}
      closeOut={closeOut}
      payout={payout}
      act={
        <NextStep>
          {focus}
          <CopyLink path={address === DEMO_CIRCLE ? "/circle/demo" : `/circle/sol:${address}`} title="Share this circle" text="Copy the permanent circle link to share its live state. A joinable invite is available only while a circle is forming." label="Copy circle link" />
          {action}
          {memberTools}
          {anyone}
        </NextStep>
      }
      turns={{
        forming: c.status === "Forming" ? { title: `Waiting for ${c.n - joinedCount} members to join`, text: `${joinedCount} of ${c.n} have locked their stock and put ${formatUsdc(c.guaranteePerMember)} ${USDC_WORD} into the shared reserve. The creator activates the circle when everyone has joined.` } : null,
        label: "Turn order",
        note: `${formatDuration(c.roundSecs)} rounds, ${formatDuration(c.graceSecs)} grace`,
        rounds: ordered.map((m) => {
          const done = seatSet(c.receivedBitmap, m.turn);
          const nowRound = active && m.turn === c.round;
          return { turn: m.turn, name: m.name, note: done ? "Pot paid" : nowRound ? "Receiving now" : c.status === "Cancelled" ? "Did not run" : "Upcoming", state: nowRound ? "now" : done ? "done" : "" };
        }),
      }}
      reserve={{
        heading: "Shared reserve, free",
        amount: formatUsdc(dv.free),
        unit: USDC_WORD,
        coins: ordered.filter((m) => seatSet(c.joinedBitmap, m.turn)).map((m) => m.turn),
        coinNote: `${joinedCount} deposits of ${formatUsdc(c.guaranteePerMember)}, one per seat`,
        lines: ([["+", "Deposited", c.reserveTotal], ["−", "Spent on defaults", c.reserveLosses], ["−", "Allocated to cover", c.reserveAllocated], ["=", "Remains, the gate's figure", dv.remains]] as const)
          .map(([sign, label, amount]): readonly [string, string, string] => [sign, label, `${formatUsdc(amount)} ${USDC_WORD}`])
          // the stored result of the last payout-gate check, as Robinhood's ledger shows it, and only while a payout is
          // still to come: "remains + short by" is what the gate needs only when it was short (adversary on 5a46c40)
          .concat(!active ? [] : [["→", "Short of the payout gate, last check", c.lastCoverageAt > 0 ? usdc(BigInt(c.nextGateShortBy)) : "Not checked yet"] as const]),
      }}
      locks={{
        label: "Cover per member",
        kicker: "What each seat locks",
        intro: m0 ? <>How {m0.name}&apos;s locked {stockUnit} becomes cover.</> : "Nobody has locked stock yet.",
        steps: m0 ? [
          [formatRaw(m0.lockedRaw), `${stockUnit} locked`],
          [formatUsdc(Math.min(fundValue(m0, c), execValue(m0, c))), `${USDC_WORD}, lower of market and share price`],
          [`−${c.haircutBps / 100}%`, "safety margin"],
          [dv.repricing ? "Not countable" : formatUsdc(stockCover(m0, c), 0), dv.repricing ? "price and split disagree" : `${USDC_WORD} of cover`],
        ] : [],
        chips: [["Minimum to join", `${formatUsdc(c.minStockCover)} ${USDC_WORD} of cover`], ["Coverage target", `${c.coverageBps / 100}%`], ["Held this round", `${formatUsdc(c.heldContributions)} ${USDC_WORD}`]],
      }}
      members={{
        head: `Members (${joinedCount} of ${c.n} joined)`,
        note: <><b>Each stake is still its owner&apos;s.</b> Returned when the circle ends, unless they default after taking the pot.</>,
        cards,
      }}
      extras={<SolanaPanel c={c} now={wallClock} split={live.split} pool={live.pool} stockUnit={stockUnit} mirror={{ multiplierNow: mirrorNow, label: LABELS.nflxxMirror }} />}
      footer={<p className={s.helper}>{c.lastCoverageAt === 0 ? "Coverage has not been computed yet: it is first computed when a pot is released or coverage is updated." : `Coverage uses prices from ${formatDuration(dv.coverageAge)} ago.`} Counted at the lower of its market price and its share price, minus a {c.haircutBps / 100}% safety margin. Testnet only: test USDC and the devnet mirror have no value.</p>}
    />
  );
}
