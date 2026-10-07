"use client";

/**
 * Robinhood circles the connected wallet created or joined (newest first, a page at a time), and the way to start one,
 * on the shared circles page (components/circles/CirclesHome.tsx; Joshua 2026-10-06, one frontend for both chains).
 * Each listed circle is read in full with the same readCircle as its page, then shown as a ListCircle (rhToList).
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import CirclesHome, { type CirclesSource } from "@/components/circles/CirclesHome";
import Shell from "@/components/othello/Shell";
import { checkFactory, listMyCircles, readCircleInTurn, type RhCircleView, type TrustResult } from "@/lib/robinhood/adapter";
import { EMPTY, hasMore, myCircles, nextBefore } from "@/lib/robinhood/my-circles";
import { rhToList } from "@/lib/robinhood/to-list";
import { robinhoodPublicClient, useEvmWallet } from "@/lib/robinhood/wallet";
import { useWalletUi } from "@/lib/wallet";

import s from "./Robinhood.module.css";

const NETWORK = { chip: "Robinhood Chain testnet", note: "Test USDG only. It has no value." };

export function useRobinhoodCircles(): CirclesSource {
  const w = useEvmWallet();
  const connectUi = useWalletUi();
  const [factory, setFactory] = useState<TrustResult | null>(null);
  const [list, dispatch] = useReducer(myCircles, EMPTY);
  // Each request carries the wallet it was for; a reply for an earlier wallet (or an unmounted page) is dropped.
  const req = useRef(0);
  // the wallet the list below was started for: after a switch, nothing read for the last wallet is shown, not even for
  // the one render before the reset effect runs (adversary on 3e5d468)
  const [listedFor, setListedFor] = useState<string | null>(null);

  // a refused or failed factory check: only "not-deployed" (no factory configured) means circles are not open; any
  // other refusal is a read that failed, shown as an error with a retry (adversary suspicion on ac343d8, as the
  // portfolio decides it)
  const [factoryTry, setFactoryTry] = useState(0);
  useEffect(() => {
    let live = true;
    setFactory(null);
    void checkFactory(robinhoodPublicClient)
      .then((f) => live && setFactory(f))
      .catch(() => live && setFactory({ ok: false, reason: "factory-code" }));
    return () => { live = false; };
  }, [factoryTry]);
  const closed = factory && !factory.ok && factory.reason === "not-deployed";
  const factoryFailed = Boolean(factory && !factory.ok && !closed);

  // Each listing call is its own attempt: a later one (Try again, Show more) makes an earlier one stale, so a failed
  // attempt's calls still in flight stop between rounds instead of running beside the retry (adversary on ac23c88).
  // `req` still marks the wallet and the page; the circle reads keep using it alone.
  const listReq = useRef(0);
  const load = useCallback((address: `0x${string}`, before: number | undefined) => {
    const id = req.current;
    const attempt = ++listReq.current;
    const current = () => id === req.current && attempt === listReq.current;
    dispatch({ type: "start" });
    listMyCircles(robinhoodPublicClient, address, before, () => !current())
      .then((page) => current() && dispatch({ type: "page", page }))
      // a fixed sentence: viem's own message carries the RPC URL and the request body (adversary on b1cb461)
      .catch(() => current() && dispatch({ type: "fail", message: "Robinhood Chain testnet did not answer. Try again in a moment." }));
  }, []);

  useEffect(() => {
    req.current += 1;
    dispatch({ type: "reset" });
    setListedFor(w.address ?? null);
    if (!w.address || !factory?.ok) return;
    load(w.address, undefined);
    return () => {
      req.current += 1;
    };
  }, [w.address, factory?.ok, load]);

  const fresh = listedFor === (w.address ?? null);
  const circles = fresh && list.started ? list.circles : null;

  // Each listed circle's full read, by address: a view, or "failed" (that card links to the page instead).
  const [views, setViews] = useState<Record<string, RhCircleView | "failed">>({});
  const asked = useRef(new Set<string>());
  useEffect(() => {
    setViews({});
    asked.current = new Set();
  }, [w.address]);
  // the list's Try again for circles whose read failed: forget them, then read them again (adversary suspicion on
  // afa5aaa: a failed row offered only "Open it")
  const [readTry, setReadTry] = useState(0);
  const retryFailed = useCallback(() => {
    setViews((m) => {
      const kept: Record<string, RhCircleView | "failed"> = {};
      for (const [k, v] of Object.entries(m)) {
        if (v === "failed") asked.current.delete(k);
        else kept[k] = v;
      }
      return kept;
    });
    setReadTry((n) => n + 1);
  }, []);
  useEffect(() => {
    if (!circles) return;
    const id = req.current;
    for (const c of circles) {
      const key = c.address.toLowerCase();
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      readCircleInTurn(robinhoodPublicClient, c.address, () => id !== req.current)
        .then((v) => id === req.current && setViews((m) => ({ ...m, [key]: v })))
        .catch(() => id === req.current && setViews((m) => ({ ...m, [key]: "failed" })));
    }
  }, [circles, readTry]);
  const me = w.address ?? null;

  return {
    side: "robinhood",
    chainName: "Robinhood Chain",
    wallet: {
      installed: w.hasWallet,
      address: me,
      connect: connectUi.openConnect,
      connectLabel: "Connect an EVM wallet (MetaMask)",
      installHint: "Install MetaMask or another EVM wallet to see your circles.",
    },
    blocked: closed ? (
      <section className={`${s.banner} ${s.refusal}`} role="alert">
        <h2 className={s.bannerTitle}>Robinhood circles aren&apos;t open yet</h2>
        <p className={s.bannerText}>Othello&apos;s contracts on Robinhood Chain testnet are waiting for their final review.</p>
      </section>
    ) : null,
    found: circles ? circles.length : null,
    circles: (circles ?? []).flatMap((c) => {
      const v = views[c.address.toLowerCase()];
      return v && v !== "failed" ? [rhToList(v, me)] : [];
    }),
    reading: (circles ?? []).filter((c) => !views[c.address.toLowerCase()]).length,
    failed: (circles ?? [])
      .filter((c) => views[c.address.toLowerCase()] === "failed")
      .map((c) => ({ address: c.address, href: `/circle/rh:${c.address}` })),
    // older circles behind Show more are not read: counted, so the board claims nothing exact about them (adversary
    // on 774ca7d). `before` is where the next older page ends in the factory's index: the count of older entries.
    notShown: circles && list.before !== null ? list.before : 0,
    shownFirst: "the newest first; Show more reads older ones",
    retryFailed: fresh ? retryFailed : null,
    error: factoryFailed ? "Othello's factory on Robinhood Chain testnet could not be verified just now." : fresh ? list.error : null,
    // both page from the list read for this wallet only: before the reset runs, `list` is still the last wallet's
    // (adversary on b37ba45: its "Show more" was drawn for one render after a switch)
    retry: factoryFailed ? () => setFactoryTry((n) => n + 1) : w.address && fresh ? () => w.address && load(w.address, nextBefore(list)) : null,
    more: w.address && fresh && hasMore(list) ? { loading: list.loading, load: () => w.address && load(w.address, nextBefore(list)) } : null,
  };
}

export default function RobinhoodHome() {
  const source = useRobinhoodCircles();
  return (
    <Shell active="Circles" side="robinhood" network={NETWORK}>
      <CirclesHome source={source} />
    </Shell>
  );
}
