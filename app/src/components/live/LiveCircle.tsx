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
import { formatUsdc, seatSet } from "@/lib/circle";
import { declareDefaultIx, releasePotIx, updateCoverageIx } from "@/lib/actions";
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
  | { phase: "failed"; what: string; reason: string };

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
      try {
        const ix = await build(wallet.publicKey);
        const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
        const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(ix);
        const sig = await wallet.sendTransaction(tx, connection);
        setPay({ phase: "confirming", what, sig });
        const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        if (res.value.err) {
          const t = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
          throw Object.assign(new Error(JSON.stringify(res.value.err)), { logs: t?.meta?.logMessages ?? [] });
        }
        setPay({ phase: "done", what, sig });
        await refresh();
      } catch (e) {
        setPay({ phase: "failed", what, reason: isRejection(e) ? "You declined in your wallet. Nothing was sent." : explainFailure(e) });
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
          ? `${pay.what}: not sent. ${pay.reason}`
          : null;
  const sig = pay.phase === "confirming" || pay.phase === "done" ? pay.sig : null;

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
  const recipient = c.members.find((m) => m.turn === c.round);
  const wallClock = Math.floor(Date.now() / 1000);
  // SPEC §5 / I7: strictly after deadline + grace, only a seat that has received and has not paid.
  const defaultable =
    active && wallClock > c.roundDeadline + c.graceSecs
      ? c.members.filter((m) => !seatSet(c.paidBitmap, m.turn) && seatSet(c.receivedBitmap, m.turn) && !seatSet(c.defaultedBitmap, m.turn))
      : [];
  const canSend = !!wallet.publicKey && !busy;
  const anyone = (
    <div className={s.action} aria-live="polite">
      <span className={s.actionText}>
        <span className={s.bannerTitle}>Anyone can move the circle on</span>
        <p className={s.bannerText}>
          {!active
            ? `The circle is ${c.status}; these open while it is Active.`
            : owing.length > 0
              ? `The pot is released once every seat has paid. Still to pay: ${owing.map((m) => m.name).join(", ")}.`
              : `Every seat has paid: anyone can release the pot to ${recipient?.name ?? "this round's seat"}.`}{" "}
          {wallet.publicKey
            ? "Your wallet signs and pays the devnet fee; it gets nothing and risks nothing."
            : "Connect any devnet wallet to send these. It pays the fee in devnet SOL (free from faucet.solana.com)."}
        </p>
      </span>
      <span className={s.actionButtons}>
        <button
          type="button"
          className={s.pay}
          disabled={!canSend || !active || owing.length > 0 || !recipient}
          onClick={() => recipient && void send("Release", (me) => releasePotIx(me, keys, new PublicKey(recipient.address)))}
        >
          Release pot{recipient ? ` to ${recipient.name}` : ""}
        </button>
        {defaultable.map((m) => (
          <button
            key={m.turn}
            type="button"
            className={s.pay}
            disabled={!canSend}
            onClick={() => void send(`Default on ${m.name}`, (me) => declareDefaultIx(me, keys, m.turn))}
          >
            Declare {m.name} in default
          </button>
        ))}
        <button
          type="button"
          className={`${s.pay} ${s.payQuiet}`}
          disabled={!canSend || !active}
          onClick={() => void send("Coverage update", (me) => updateCoverageIx(me, keys))}
        >
          Update coverage
        </button>
      </span>
    </div>
  );

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
            {anyone}
          </>
        ),
        below: <XStocksPanel mirror={{ multiplierNow: mirrorNow, label: LABELS.nflxxMirror }} />,
      }}
    />
  );
}
