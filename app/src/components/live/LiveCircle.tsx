"use client";

/**
 * T18: the demo circle, live from devnet. Reads through /api/circle (the
 * server reads devnet once and shares it) every REFRESH_MS, renders the ordinary Circle screen in live mode, and gives a
 * connected member one action: pay this round (`contribute`), signed in their
 * own wallet.
 *
 * A failed refresh keeps the last good read on screen with the failure shown
 * over it; a first read that fails shows the failure and a retry. Nothing is
 * ever filled in.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";

import Circle from "@/components/circle/Circle";
import s from "@/components/circle/Circle.module.css";
import { ThemeRoot } from "@/components/theme/ThemeRoot";
import { formatUsdc, seatSet } from "@/lib/circle";
import { contributeIx, explainFailure } from "@/lib/contribute";
import { DEMO_CIRCLE, LABELS, explorer } from "@/lib/devnet";
import type { LiveCircle as Live } from "@/lib/live";
import { multiplierAt } from "@/lib/scaledUi";

import XStocksPanel from "./XStocksPanel";

const REFRESH_MS = 5_000;
const USDC_WORD = "test USDC";

type Pay =
  | { phase: "idle" }
  | { phase: "wallet" }
  | { phase: "confirming"; sig: string }
  | { phase: "done"; sig: string }
  | { phase: "failed"; reason: string };

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

  const onPay = useCallback(async () => {
    if (!live || !wallet.publicKey) return;
    setPay({ phase: "wallet" });
    try {
      const ix = await contributeIx(wallet.publicKey, new PublicKey(live.accounts.circle), new PublicKey(live.accounts.usdcMint));
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      const tx = new Transaction({ feePayer: wallet.publicKey, blockhash, lastValidBlockHeight }).add(ix);
      const sig = await wallet.sendTransaction(tx, connection);
      setPay({ phase: "confirming", sig });
      const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (res.value.err) {
        const t = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        throw Object.assign(new Error(JSON.stringify(res.value.err)), { logs: t?.meta?.logMessages ?? [] });
      }
      setPay({ phase: "done", sig });
      await refresh();
    } catch (e) {
      setPay({ phase: "failed", reason: isRejection(e) ? "You declined in your wallet. Nothing was sent." : explainFailure(e) });
    }
  }, [live, wallet, connection, refresh]);

  if (!live) {
    return (
      <ThemeRoot className={s.root}>
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
      </ThemeRoot>
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

  const status =
    pay.phase === "wallet"
      ? "Approve it in your wallet."
      : pay.phase === "confirming"
        ? "Sent. Confirming on devnet…"
        : pay.phase === "failed"
          ? `Not paid. ${pay.reason}`
          : null;
  const sig = pay.phase === "confirming" || pay.phase === "done" ? pay.sig : null;

  const action = (
    <div className={s.action} aria-live="polite">
      <span className={s.actionText}>
        <span className={s.bannerTitle}>{text}</span>
        {status && <p className={s.bannerText}>{status}</p>}
        {sig && (
          <p className={s.bannerText}>
            {pay.phase === "done" ? "Paid. " : ""}
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
        action,
        below: <XStocksPanel mirror={{ multiplierNow: mirrorNow, label: LABELS.nflxxMirror }} />,
      }}
    />
  );
}
