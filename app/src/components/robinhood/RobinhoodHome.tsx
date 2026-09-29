"use client";

/** Robinhood circles the connected wallet created or joined (newest first, a page at a time), and the way to start one. */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import Shell from "@/components/othello/Shell";
import { checkFactory, listMyCircles, type TrustResult } from "@/lib/robinhood/adapter";
import { fmtUsdg } from "@/lib/robinhood/copy";
import { EMPTY, hasMore, myCircles, nextBefore } from "@/lib/robinhood/my-circles";
import { robinhoodPublicClient, useEvmWallet } from "@/lib/robinhood/wallet";

import EvmWalletPill from "./EvmWalletPill";
import s from "./Robinhood.module.css";

const NETWORK = { chip: "Robinhood Chain testnet", note: "Test USDG only. It has no value." };
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function RobinhoodHome() {
  const w = useEvmWallet();
  const [factory, setFactory] = useState<TrustResult | null>(null);
  const [list, dispatch] = useReducer(myCircles, EMPTY);
  // Each request carries the wallet it was for; a reply for an earlier wallet (or an unmounted page) is dropped.
  const req = useRef(0);

  useEffect(() => {
    void checkFactory(robinhoodPublicClient).then(setFactory).catch(() => setFactory({ ok: false, reason: "factory-code" }));
  }, []);

  const load = useCallback((address: `0x${string}`, before: number | undefined) => {
    const id = req.current;
    dispatch({ type: "start" });
    listMyCircles(robinhoodPublicClient, address, before)
      .then((page) => id === req.current && dispatch({ type: "page", page }))
      .catch((e) => id === req.current && dispatch({ type: "fail", message: e instanceof Error ? e.message : String(e) }));
  }, []);

  useEffect(() => {
    req.current += 1;
    dispatch({ type: "reset" });
    if (!w.address || !factory?.ok) return;
    load(w.address, undefined);
    return () => {
      req.current += 1;
    };
  }, [w.address, factory?.ok, load]);

  const circles = list.started ? list.circles : null;

  return (
    <Shell active="Circles" network={NETWORK} wallet={<EvmWalletPill w={w} />}>
      <main className={s.page}>
        <header className={s.head}>
          <div className={s.pills}><span className={s.pill}>USDG on Robinhood Chain</span></div>
          <h1 className={s.title}>Your Robinhood circles</h1>
          <p className={s.sub}>
            Save in USDG with people you know. Each round everyone pays the same amount and one member takes the whole
            pot. Locked USDG and a shared reserve cover anyone who stops paying after their turn.
          </p>
          <a className={s.btn} href="/robinhood/new">Start a circle</a>
        </header>

        {factory && !factory.ok && (
          <section className={`${s.banner} ${s.refusal}`} role="alert">
            <h2 className={s.bannerTitle}>Robinhood circles aren&apos;t open yet</h2>
            <p className={s.bannerText}>Othello&apos;s contracts on Robinhood Chain testnet are waiting for their final review.</p>
          </section>
        )}

        <section className={s.section} aria-live="polite">
          {!w.hasWallet && <p className={s.muted}>Install MetaMask or another EVM wallet to see your circles.</p>}
          {w.hasWallet && !w.address && (
            <button type="button" className={s.btn} onClick={() => void w.connect()}>Connect an EVM wallet (MetaMask)</button>
          )}
          {w.address && factory?.ok && circles === null && list.loading && <p className={s.muted}>Looking for your circles…</p>}
          {circles && circles.length === 0 && (
            <p className={s.muted}>This wallet hasn&apos;t started or joined a circle yet. Start one, or open the link someone sent you.</p>
          )}
          {circles && circles.length > 0 && (
            <ol className={s.members}>
              {circles.map((c) => (
                <li key={c.address} className={s.member}>
                  <span className={s.turn}>{c.turn + 1}</span>
                  <div className={s.memberBody}>
                    <a className={s.addr} href={`/circle/rh:${c.address}`}>Circle {short(c.address)}</a>
                    <span className={s.tags}>
                      <span className={s.tag}>{c.status}</span>
                      <span className={s.tag}>{c.n} members</span>
                      <span className={s.tag}>{fmtUsdg(c.c)} a round</span>
                      <span className={s.tag}>You receive in round {c.turn + 1}</span>
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {list.error && (
            <p className={s.error} role="alert">
              Couldn&apos;t read your circles: {list.error}{" "}
              {w.address && (
                <button type="button" className={s.btnQuiet} onClick={() => w.address && load(w.address, nextBefore(list))}>
                  Try again
                </button>
              )}
            </p>
          )}
          {w.address && hasMore(list) && !list.error && (
            <button type="button" className={s.btnQuiet} disabled={list.loading} onClick={() => w.address && load(w.address, nextBefore(list))}>
              {list.loading ? "Loading…" : "Show more"}
            </button>
          )}
        </section>
      </main>
    </Shell>
  );
}
