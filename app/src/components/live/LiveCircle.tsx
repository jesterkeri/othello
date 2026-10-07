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
import { coverageLabel, defaultRecovered, derive, execValue, formatDuration, formatRaw, formatUsdc, fundValue, obligations, releaseBlock, seatSet, shortAddress, stockCover } from "@/lib/circle";
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
/** Solana's money in its own words: base units of test USDC (6 decimals). */
const usdc = (base: bigint) => `${formatUsdc(Number(base))} ${USDC_WORD}`;

/**
 * One transaction at a time, whichever button sent it; `what` names it in the status line, `round` is the round the
 * read showed when it was sent: its outcome belongs to that round and is not shown once the read has moved on
 * (adversary on a76dfd8: round 1's "Payment: done." showed under round 2's payment due).
 */
type Pay =
  | { phase: "idle" }
  | { phase: "wallet"; what: string; round: number }
  | { phase: "confirming"; what: string; sig: string; round: number }
  | { phase: "done"; what: string; sig: string; round: number }
  | { phase: "failed"; what: string; reason: string; sig?: string; round: number };

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
  const [pay, setPay] = useState<Pay>({ phase: "idle" });
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
  const yourTurn = live && you ? (live.view.members.find((m) => m.address === you)?.turn ?? null) : null;

  const send = useCallback(
    async (what: string, build: (me: PublicKey) => Promise<TransactionInstruction>) => {
      if (!live || !wallet.publicKey) return;
      const round = live.view.round;
      setPay({ phase: "wallet", what, round });
      // Once the wallet returns a signature the transaction was sent, and the fee is spent, even
      // if the chain then refuses it: the screen must never say "not sent" after that point.
      let sent: string | null = null;
      try {
        const ix = await build(wallet.publicKey);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(ix);
        const sig = await wallet.sendTransaction(tx, connection);
        sent = sig;
        setPay({ phase: "confirming", what, sig, round });
        const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        if (res.value.err) {
          const t = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          throw Object.assign(new Error(JSON.stringify(res.value.err)), { logs: t?.meta?.logMessages ?? [], onChain: true });
        }
        setPay({ phase: "done", what, sig, round });
        await refresh();
      } catch (e) {
        const reason = !sent
          ? isRejection(e)
            ? "you declined in your wallet. Nothing was sent."
            : `not sent. ${explainFailure(e)}`
          : (e as { onChain?: boolean }).onChain
            ? `sent, and the program refused it. ${explainFailure(e)}`
            : `sent, but not confirmed: ${explainFailure(e)}. Check the transaction below.`;
        setPay(sent ? { phase: "failed", what, reason, sig: sent, round } : { phase: "failed", what, reason, round });
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

  if (!live) {
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
    text = "This seat has defaulted. Its remaining payments were covered from its stock.";
  } else if (seatSet(c.paidBitmap, yourTurn)) {
    text = `You have paid round ${c.round + 1}.`;
    button = { label: "Paid", enabled: false };
  } else {
    text = `Seat ${yourTurn + 1}: your ${formatUsdc(c.contribution, 0)} ${USDC_WORD} for round ${c.round + 1} is due.`;
    button = { label: `Pay ${formatUsdc(c.contribution, 0)} ${USDC_WORD}`, enabled: pay.phase === "idle" || pay.phase === "failed" || pay.phase === "done" };
  }

  const busy = pay.phase === "wallet" || pay.phase === "confirming";
  // a release's progress, refusal and transaction link are the shared payout panel's, which shows a refusal only in
  // the round it was sent for (adversary on fd9d764: a refusal from a round the read had left stayed here)
  const isRelease = pay.phase !== "idle" && pay.what.startsWith("Release");
  // a finished action's outcome (done, declined, refused) from a round the read has left is not shown here
  const stale = (pay.phase === "done" || pay.phase === "failed") && pay.round !== c.round;
  const status = isRelease || stale ? null :
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
  // A feed that was never priced reads as fresh after touch_prices but prices at 0, which the
  // program refuses as PriceStale (adversary pass 3's suspicion; admin-only, cheap to state).
  const priceBlock = c.feed.wrapperPrice === 0 || c.feed.sharePrice === 0
    ? "No price has been set for the stock yet, and the program acts only on a set, fresh price."
    : dv.stale
    ? `The price is ${formatDuration(dv.priceAge)} old, and the program acts only on a fresh one.`
    : dv.repricing
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
          {ended
            ? mineWithdrawn
              ? "You have withdrawn your stock and what was left of your guarantee."
              : "The circle has ended: withdraw your stock, unused guarantee and top-ups."
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
  const ring = ringOf(listed, you, now, { fmt: usdc, collateral: stockUnit });
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
  // a failure from a round the read has already left is not shown (two members releasing at once)
  const shownRelease: ReleasePhase = releasePhase.kind === "failed" && releasePhase.round !== c.round ? { kind: "idle" } : releasePhase;
  const coverRefused = shownRelease.kind === "failed" && /CoverageTooLow|ReserveOvercommitted/.test(shownRelease.error);
  const steps = payoutSteps({ n: c.n, round: c.round, seats: listed.seats, gateShortBy: BigInt(c.nextGateShortBy), checked: c.lastCoverageAt > 0 }, shownRelease, words,
    { coverRefused, unfunded: shownRelease.kind === "failed" && /RoundNotFunded/.test(shownRelease.error) });
  const releaseLabel = `Release pot${recipient ? ` to ${recipient.name}` : ""}`;
  const payout = active || shownRelease.kind === "released" ? (
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
      ? `Each member now collects their own locked ${stockUnit} plus a share of what is left in the shared reserve. Only the member's own wallet can collect it, and it does not expire.`
      : `It was cancelled before it started. Each member who joined collects their locked ${stockUnit}, guarantee and any top ups back. Only the member's own wallet can collect it, and it does not expire.`,
    seats: ordered.map((m) => ({ turn: m.turn, label: seatLabel(m.turn), wallet: m.address, you: m.address === you, collected: seatSet(c.withdrawnBitmap, m.turn), owed: owes(m.turn), amount: null })),
    collected: owedSeats.filter((m) => seatSet(c.withdrawnBitmap, m.turn)).length,
    owedCount: owedSeats.length,
    mine: yourTurn !== null ? { turn: yourTurn, collected: mineWithdrawn, owed: owes(yourTurn), locked: null, pooled: null, total: null, lockedLeft: (c.members.find((m) => m.turn === yourTurn)?.lockedRaw ?? 0) > 0 } : null,
  } : null;
  const closeOut = close ? (
    <CloseOutPanel
      words={words}
      close={close}
      completed={completed}
      canWrite={canSend}
      blocker={!wallet.publicKey ? "Connect the devnet wallet of your seat to collect." : busy ? "A transaction is already waiting for your wallet or for devnet." : null}
      busy={(pay.phase === "wallet" || pay.phase === "confirming") && pay.what === "Withdraw"}
      onWithdraw={() => void send("Withdraw", (me) => withdrawIx(me, keys))}
    />
  ) : null;

  const banners: PageBanner[] = [];
  if (error) banners.push({ kind: "refusal", mark: "?", title: "Live data unavailable", text: `The last read of devnet failed (${error}). Showing the read from ${formatDuration(wallClock - live.readAt)} ago.` });
  if (dv.repricing) banners.push({ kind: "neutral", mark: "!", title: "Repricing. Price and split disagree.", text: "Payouts wait. The demo admin sets a price for the new multiplier, then anyone can update coverage." });
  if (dv.stale) banners.push({ kind: "neutral", mark: "?", title: `Prices are ${formatDuration(dv.priceAge)} old`, text: "Recheck after update." });
  if (dv.paused) banners.push({ kind: "refusal", mark: "!", title: "Payouts paused.", text: `The next payout needs ${formatUsdc(gateNeeded)} ${USDC_WORD} of reserve and ${formatUsdc(dv.remains)} remains. Top up ${formatUsdc(c.nextGateShortBy)} ${USDC_WORD}, returned pro rata at the end, minus any default losses.` });
  if (active && !dv.funded && !dv.repricing) banners.push({ kind: "neutral", mark: String(dv.missing), title: `${dv.missing} contributions still missing`, text: `Once everyone has paid${dv.paused ? " and the reserve covers the next payout" : ""}${dv.stale ? " and the price is fresh" : ""}, anyone can release the pot${dv.recipient ? ` to ${dv.recipient.name}` : ""}. Paying late still counts.` });

  // the clock: what is due now, by the chain's last read
  const defaultableNow = active && dv.toGraceEnd < 0 ? c.members.filter((m) => !seatSet(c.paidBitmap, m.turn) && seatSet(c.receivedBitmap, m.turn) && !seatSet(c.defaultedBitmap, m.turn)) : [];
  const clock = !active
    ? [{ label: "Seats joined", value: `${joinedCount} of ${c.n}` }, { label: "Round length", value: formatDuration(c.roundSecs) }, { label: "Pot this round", value: usdc(pot) }]
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
        { label: "Pot", value: received ? "Received" : isNow ? "Receiving" : "Waiting", tone: received ? "teal" : isNow ? "cobalt" : "" },
        { label: "Owed", value: joined ? `${formatUsdc(obligations(c, m))} ${USDC_WORD}` : "—", tone: "" },
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
          ? `This seat has not joined yet. Joining locks the ${stockUnit} as cover and adds the ${formatUsdc(c.guaranteePerMember)} ${USDC_WORD} guarantee. Joining from this page opens in the next update; until then the seat joins from the Othello devnet tools.`
          : `This seat never joined, and the circle is ${c.status}: it can no longer be joined.`
        : !fmJoined
          ? "This seat has not joined yet: nothing is locked."
          : `Locked ${formatRaw(fm.lockedRaw)} ${stockUnit}, counting as ${dv.repricing ? "no cover while price and split disagree" : `${formatUsdc(stockCover(fm, c))} ${USDC_WORD} of cover`}. Owes ${formatUsdc(obligations(c, fm))} ${USDC_WORD}. ${seatSet(c.receivedBitmap, fm.turn) ? "Has received the pot." : `Receives the pot in round ${fm.turn + 1}.`}`}
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
      status={dv.repricing ? "Repricing" : dv.paused ? "Paused" : c.status}
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
          return { turn: m.turn, name: m.name, note: done ? "Pot paid" : nowRound ? "Receiving now" : "Upcoming", state: nowRound ? "now" : done ? "done" : "" };
        }),
      }}
      reserve={{
        heading: "Shared reserve, free",
        amount: formatUsdc(dv.free),
        unit: USDC_WORD,
        coins: ordered.filter((m) => seatSet(c.joinedBitmap, m.turn)).map((m) => m.turn),
        coinNote: `${joinedCount} deposits of ${formatUsdc(c.guaranteePerMember)}, one per seat`,
        lines: ([["+", "Deposited", c.reserveTotal], ["−", "Spent on defaults", c.reserveLosses], ["−", "Allocated to cover", c.reserveAllocated], ["=", "Remains, the gate's figure", dv.remains], ["→", "Next payout needs", gateNeeded]] as const)
          .map(([sign, label, amount]) => [sign, label, `${formatUsdc(amount)} ${USDC_WORD}`] as const),
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
