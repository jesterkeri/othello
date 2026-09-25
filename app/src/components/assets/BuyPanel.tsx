"use client";

/**
 * Buy (Joshua, 2026-09-25: "people will buy the stocks from our platform"; T18g: "the entire
 * transaction in our site"). A live Jupiter quote for USDC into this xStock; then, in place: the
 * server has Jupiter build the swap for this wallet and checks it (/api/swap), the buyer signs it in
 * their own wallet, and the server relays the signed bytes to mainnet and waits for it (/api/swap/send).
 * Real funds, mainnet, the buyer's own wallet; Othello never holds a key or the funds. Jupiter's own
 * page stays as a fallback link.
 */
import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { VersionedTransaction } from "@solana/web3.js";

import type { SwapBuild } from "@/app/api/swap/route";
import type { SwapSent } from "@/app/api/swap/send/route";
import { exactTokens, shownTokens } from "@/lib/format";
import { useWalletUi } from "@/lib/wallet";

import { useWalletFunds } from "./useWalletFunds";
import WalletFunds from "./WalletFunds";

/** Enough SOL for the fee, priority fee and a new token account (~0.002 SOL rent) with margin. */
const MIN_FEE_LAMPORTS = 5_000_000n;

import type { Quote } from "@/app/api/quote/route";
import s from "@/components/circle/Circle.module.css";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Checked in a browser 2026-09-25: jup.ag/swap/<in>-<out> redirects to buying SOL; the query form
// ?sell=<in>&buy=<out> opens the right pair.

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));

type Buy =
  | { phase: "idle" }
  | { phase: "building" }
  | { phase: "wallet" }
  | { phase: "sending" }
  | { phase: "done"; sig: string; outRaw: string; usdc: number }
  | { phase: "failed"; reason: string; sig?: string };

/** The wallet-connect prompt, when the page has the wallet UI provider (tests render without it). */
function useConnectPrompt(): (() => void) | null {
  try {
    return useWalletUi().openConnect;
  } catch {
    return null;
  }
}

export default function BuyPanel({ symbol, address, decimals, multiplier, accepted, embedded = false }: { symbol: string; address: string; decimals: number; multiplier: number; accepted: boolean; /** Inside the stock page's Buy card: no box or title of its own. */ embedded?: boolean }) {
  const [amount, setAmount] = useState("1");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wallet = useWallet();
  const connect = useConnectPrompt();
  const [buy, setBuy] = useState<Buy>({ phase: "idle" });
  // Joshua: show what the wallet can spend (mainnet USDC for the swap, SOL for the fee).
  const { funds, error: fundsError, reload: reloadFunds } = useWalletFunds(wallet.publicKey?.toBase58() ?? null);
  const [popup, setPopup] = useState(false);

  useEffect(() => {
    const usdc = Number(amount);
    setQuote(null);
    setError(null);
    if (!Number.isFinite(usdc) || usdc <= 0) return;
    let alive = true;
    const id = window.setTimeout(() => {
      fetch(`/api/quote?symbol=${encodeURIComponent(symbol)}&usdc=${usdc}`, { cache: "no-store" })
        .then((r) => r.json() as Promise<Quote | { error: string }>)
        .then((b) => {
          if (!alive) return;
          if ("error" in b) throw new Error(b.error);
          setQuote(b);
        })
        .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    }, 400);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [amount, symbol]);

  const busy = buy.phase === "building" || buy.phase === "wallet" || buy.phase === "sending";
  const highImpact = !!quote && quote.priceImpactPct >= 5;

  const onBuy = async () => {
    if (!wallet.publicKey || !quote) return;
    if (!wallet.signTransaction) {
      setBuy({ phase: "failed", reason: "This wallet cannot sign a transaction here. Use the Jupiter link below." });
      return;
    }
    const user = wallet.publicKey.toBase58();
    let sig: string | undefined;
    try {
      setBuy({ phase: "building" });
      const b = (await fetch("/api/swap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol, usdc: amount.trim(), user }) }).then((r) => r.json())) as SwapBuild | { error: string };
      if ("error" in b) throw new Error(b.error);
      setBuy({ phase: "wallet" });
      const signed = await wallet.signTransaction(VersionedTransaction.deserialize(fromB64(b.tx)));
      setBuy({ phase: "sending" });
      const r = (await fetch("/api/swap/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: toB64(signed.serialize()), user, lastValidBlockHeight: b.lastValidBlockHeight, symbol }) }).then((x) => x.json())) as SwapSent | { error: string };
      if ("error" in r && !("signature" in r)) throw new Error(r.error);
      const sent = r as SwapSent;
      sig = sent.signature;
      if (sent.status !== "confirmed") throw new Error(sent.status === "failed" ? `the swap failed on chain (${sent.error})` : (sent.error ?? "not confirmed"));
      // Codex T18d r5: the pop-up describes what was bought, not whatever the amount box says later.
      setBuy({ phase: "done", sig: sent.signature, outRaw: b.outRaw, usdc: b.usdc });
      setPopup(true);
      reloadFunds();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const declined = /reject|declin|denied|cancel/i.test(msg);
      setBuy({ phase: "failed", reason: declined ? "You declined in your wallet. Nothing was sent." : msg, sig });
      // Joshua: a purchase attempt ends in a pop-up either way; a decline needs none.
      if (!declined) setPopup(true);
    }
  };
  // Refuse up front what the chain would refuse: a buyer with too little USDC or SOL never signs a
  // transaction bound to fail (Joshua: judges may test with empty wallets).
  // Codex T18d final: compare the TYPED amount (exact), never a quote that may be for an older amount.
  const typedMatch = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  const typedMicro = typedMatch ? BigInt(typedMatch[1]!) * 1_000_000n + BigInt((typedMatch[2] ?? "").padEnd(6, "0") || "0") : null;
  const shortUsdc = !!funds && typedMicro !== null && BigInt(funds.usdcRaw) < typedMicro;
  const shortSol = !!funds && BigInt(funds.lamports) < MIN_FEE_LAMPORTS;
  const label = !wallet.publicKey
    ? "Connect a wallet"
    : !quote
      ? "Enter an amount"
      : buy.phase === "idle" && shortUsdc
        ? "Not enough USDC"
        : buy.phase === "idle" && shortSol
          ? "Add SOL for fees"
      : buy.phase === "building"
        ? "Building the swap…"
        : buy.phase === "wallet"
          ? "Approve in your wallet"
          : buy.phase === "sending"
            ? "Confirming on mainnet…"
            : buy.phase === "done"
              ? "Bought"
              : highImpact
                ? `Buy ${symbol} anyway`
                : `Buy ${symbol}`;
  const txLink = (sig: string) => `https://explorer.solana.com/tx/${sig}`;

  return (
    <div className={embedded ? s.chartBare : s.chartBox}>
      {!embedded && <span className={s.bannerTitle}>Buy {symbol}</span>}
      {/* Joshua: say it up front, so a judge knows what to expect before pressing anything. */}
      <p className={s.panelNote} data-upfront>
        <b>A real purchase on Solana mainnet.</b> Any mainnet wallet with 0.10 USDC or more and a little SOL for fees can
        try it. The savings circle runs on free devnet funds.
      </p>
      <label className={s.panelNote}>
        Pay{" "}
        <input className={s.search} style={{ width: 140, display: "inline-block", padding: "8px 12px" }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, "").replace(/^(\d*\.\d{0,6}).*$/, "$1"))} aria-label="USDC to pay" />{" "}
        USDC
      </label>
      {error ? (
        <p className={s.panelNote}>No quote: {error}</p>
      ) : !quote ? (
        <p className={s.panelNote}>Asking Jupiter for a quote…</p>
      ) : (
        <div className={s.rows}>
          <span className={s.row}>
            <span className={s.rowLabel}>You receive, as your wallet shows it</span>
            <span className={s.rowValue}>
              about {shownTokens(quote.outRaw, decimals, multiplier)} {symbol}
            </span>
          </span>
          <span className={s.row}>
            {/* Codex T18d r3: Jupiter's integer, every digit, as tokens before the multiplier (not "raw" base units). */}
            <span className={s.rowLabel}>Before the multiplier</span>
            <span className={s.rowValue}>{exactTokens(quote.outRaw, decimals)}</span>
          </span>
          <span className={s.row}>
            <span className={s.rowLabel}>Price impact</span>
            <span className={s.rowValue}>
              {quote.priceImpactPct.toFixed(2)}%{quote.priceImpactPct >= 1 ? " (thin pool: consider a smaller amount)" : ""}
            </span>
          </span>
          <span className={s.row}>
            <span className={s.rowLabel}>Route</span>
            <span className={s.rowValue}>{quote.route.join(" → ") || "direct"}</span>
          </span>
        </div>
      )}
      {wallet.publicKey && (
        <WalletFunds funds={funds} error={fundsError} compact />
      )}
      <button
        type="button"
        className={s.pay}
        data-buy
        disabled={busy || buy.phase === "done" || (!!wallet.publicKey && (!quote || (buy.phase === "idle" && (shortUsdc || shortSol))))}
        onClick={() => (!wallet.publicKey ? connect?.() : void onBuy())}
      >
        {label}
      </button>
      {highImpact && buy.phase === "idle" && <p className={s.panelNote}>Price impact is {quote!.priceImpactPct.toFixed(2)}%: a thin pool. Consider a smaller amount.</p>}
      {buy.phase === "done" && (
        <p className={s.panelNote}>
          Bought. <a className={s.link} href={txLink(buy.sig)} target="_blank" rel="noreferrer">View the transaction</a>. It shows in your{" "}
          <a className={s.link} href="/portfolio">portfolio</a> on the next read.
        </p>
      )}
      {popup && buy.phase === "done" && (
        <div className={s.buyScrim} onClick={() => setPopup(false)}>
          <div role="dialog" aria-modal="true" aria-label="Purchase complete" className={s.buyDialog} onClick={(e) => e.stopPropagation()}>
            <span className={s.buyDialogKicker}>Bought on Solana mainnet</span>
            <b className={s.buyDialogBig}>about {shownTokens(buy.outRaw, decimals, multiplier)} {symbol}</b>
            <span>for {buy.usdc} USDC, swapped through Jupiter and signed in your own wallet.</span>
            <a className={s.buyDialogLink} href={txLink(buy.sig)} target="_blank" rel="noreferrer">View the transaction ↗</a>
            <span className={s.buyDialogBtns}>
              <a className={s.buyDialogPrimary} href="/portfolio">See it in your portfolio →</a>
              {accepted && <a className={s.buyDialogGhost} href="/how-it-works">How a circle locks it →</a>}
              <button type="button" className={s.buyDialogGhost} onClick={() => setPopup(false)}>Close</button>
            </span>
          </div>
        </div>
      )}
      {popup && buy.phase === "failed" && (
        <div className={s.buyScrim} onClick={() => setPopup(false)}>
          <div role="dialog" aria-modal="true" aria-label="Purchase not completed" className={`${s.buyDialog} ${s.buyDialogFail}`} onClick={(e) => e.stopPropagation()}>
            <span className={s.buyDialogKicker}>Not bought</span>
            <b className={s.buyDialogBig}>{symbol} was not bought</b>
            <span>{buy.reason}</span>
            {buy.sig && <a className={s.buyDialogLink} href={txLink(buy.sig)} target="_blank" rel="noreferrer">View the transaction ↗</a>}
            <span className={s.buyDialogBtns}>
              <button type="button" className={s.buyDialogPrimary} onClick={() => { setPopup(false); setBuy({ phase: "idle" }); }}>Try again</button>
              <button type="button" className={s.buyDialogGhost} onClick={() => setPopup(false)}>Close</button>
            </span>
          </div>
        </div>
      )}
      {buy.phase === "failed" && (
        <p className={s.panelNote}>
          Not bought: {buy.reason}
          {buy.sig && (
            <>
              {" "}
              <a className={s.link} href={txLink(buy.sig)} target="_blank" rel="noreferrer">View the transaction</a>.
            </>
          )}
        </p>
      )}
      <a className={s.link} style={{ alignSelf: "flex-start", fontSize: 12.5, fontWeight: 800 }} href={`https://jup.ag/swap?sell=${USDC}&buy=${address}`} target="_blank" rel="noreferrer">
        Or open this pair on Jupiter ↗
      </a>
      <p className={s.panelNote}>
        Mainnet, real money: your wallet must be on Solana mainnet and hold USDC. Jupiter routes the swap, you sign it in your
        own wallet, and Othello never holds your keys or funds. Quote with 1% slippage; the final amount is set when you sign.{" "}
        {accepted
          ? "A circle can lock it as cover once Othello is on mainnet; today's demo circle runs on devnet with a labelled mirror."
          : "Circles do not accept it as cover yet."}
      </p>
    </div>
  );
}
