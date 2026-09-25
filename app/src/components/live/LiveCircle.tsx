"use client";

/**
 * T18: the demo circle, live from devnet. Reads through /api/circle (the
 * server reads devnet once and shares it) every REFRESH_MS, renders the ordinary Circle screen in live mode, and gives a
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

import Circle from "@/components/circle/Circle";
import s from "@/components/circle/Circle.module.css";
import Shell from "@/components/othello/Shell";
import { defaultRecovered, derive, formatDuration, formatUsdc, seatSet } from "@/lib/circle";
import { addStockIx, declareDefaultIx, parseUnits, releasePotIx, topUpReserveIx, updateCoverageIx, withdrawIx } from "@/lib/actions";
import { contributeIx, explainFailure } from "@/lib/contribute";
import { DEMO_CIRCLE, LABELS, explorer } from "@/lib/devnet";
import type { LiveCircle as Live } from "@/lib/live";
import { multiplierAt } from "@/lib/scaledUi";

import XStocksPanel from "./XStocksPanel";

const REFRESH_MS = 5_000;
const USDC_WORD = "test USDC";

/** One transaction at a time, whichever button sent it; `what` names it in the status line. */
type Pay =
  | { phase: "idle" }
  | { phase: "wallet"; what: string }
  | { phase: "confirming"; what: string; sig: string }
  | { phase: "done"; what: string; sig: string }
  | { phase: "failed"; what: string; reason: string; sig?: string };

function isRejection(e: unknown): boolean {
  const inner = (e as { error?: { code?: number; message?: string } }).error;
  if (inner?.code === 4001) return true;
  return /reject|declin|denied|cancel/i.test(`${e instanceof Error ? e.message : String(e)} ${inner?.message ?? ""}`);
}

export default function LiveCircle() {
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

  const refresh = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const res = await fetch("/api/circle", { cache: "no-store" });
      const body = (await res.json()) as Live | { error: string };
      if (mine !== latest.current) return;
      if ("error" in body) throw new Error(body.error);
      setLive(body);
      setError(null);
    } catch (e) {
      if (mine === latest.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

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
      setPay({ phase: "wallet", what });
      // Once the wallet returns a signature the transaction was sent, and the fee is spent, even
      // if the chain then refuses it: the screen must never say "not sent" after that point.
      let sent: string | null = null;
      try {
        const ix = await build(wallet.publicKey);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(ix);
        const sig = await wallet.sendTransaction(tx, connection);
        sent = sig;
        setPay({ phase: "confirming", what, sig });
        const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        if (res.value.err) {
          const t = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          throw Object.assign(new Error(JSON.stringify(res.value.err)), { logs: t?.meta?.logMessages ?? [], onChain: true });
        }
        setPay({ phase: "done", what, sig });
        await refresh();
      } catch (e) {
        const reason = !sent
          ? isRejection(e)
            ? "you declined in your wallet. Nothing was sent."
            : `not sent. ${explainFailure(e)}`
          : (e as { onChain?: boolean }).onChain
            ? `sent, and the program refused it. ${explainFailure(e)}`
            : `sent, but not confirmed: ${explainFailure(e)}. Check the transaction below.`;
        setPay(sent ? { phase: "failed", what, reason, sig: sent } : { phase: "failed", what, reason });
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
      <Shell active="Circles">
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
              <p className={s.panelNote}>Reading the demo circle from devnet…</p>
            )}
          </div>
        </div>
      </Shell>
    );
  }

  const c = live.view;
  const now = live.readAt;
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
  const status =
    pay.phase === "wallet"
      ? `${pay.what}: approve it in your wallet.`
      : pay.phase === "confirming"
        ? `${pay.what}: sent. Confirming on devnet…`
        : pay.phase === "failed"
          ? `${pay.what}: ${pay.reason}`
          : null;
  const sig = pay.phase === "confirming" || pay.phase === "done" ? pay.sig : pay.phase === "failed" ? (pay.sig ?? null) : null;

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
  const canRelease = active && owing.length === 0 && !priceBlock && !!recipient;
  const canCover = active && !priceBlock;
  const defaults = defaultable.map((m) => {
    const needs = defaultRecovered(c, m, live.pool.discountBps);
    return { m, needs, poolShort: live.pool.usdc < needs };
  });
  const releaseText = !active
    ? `The circle is ${c.status}; these open while it is Active.`
    : owing.length > 0
      ? `The pot can be released once every seat has paid or been declared in default. Still to pay: ${owing.map((m) => m.name).join(", ")}.`
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
        <button
          type="button"
          className={s.pay}
          disabled={!canSend || !canRelease}
          onClick={() => recipient && void send("Release", (me) => releasePotIx(me, keys, new PublicKey(recipient.address)))}
        >
          Release pot{recipient ? ` to ${recipient.name}` : ""}
        </button>
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
  const mine = yourTurn !== null ? c.members.find((m) => m.turn === yourTurn) : undefined;
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
              : "Lock more of the NFLXx devnet mirror to raise your cover, or top up the shared reserve in test USDC (it fills any payout shortfall first)."}
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
      {ended && !mineWithdrawn && (
        <button type="button" className={s.pay} disabled={!canSend} onClick={() => void send("Withdraw", (me) => withdrawIx(me, keys))}>
          Withdraw
        </button>
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

  return (
    <Circle
      circle={c}
      startNow={now}
      stateKey="demo"
      live={{
        circleAddress: DEMO_CIRCLE,
        readAt: live.readAt,
        error,
        mirrorLabel: LABELS.nflxxMirror,
        usdcWord: USDC_WORD,
        yourTurn,
        split: live.split,
        action: (
          <>
            {action}
            {memberTools}
            {anyone}
          </>
        ),
        below: <XStocksPanel mirror={{ multiplierNow: mirrorNow, label: LABELS.nflxxMirror }} />,
      }}
    />
  );
}
