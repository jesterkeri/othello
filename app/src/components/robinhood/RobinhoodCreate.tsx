"use client";

/**
 * Create a savings circle on Robinhood Chain testnet. The creator lists every member's wallet (their own included),
 * sets the amounts and timing, and signs `createCircle` on the one trusted factory. The factory re-checks every rule;
 * this form only explains them first. On success it opens the new circle's page, whose link the creator shares.
 */
import { useEffect, useMemo, useState } from "react";
import { getAddress, isAddress, parseUnits, type Address } from "viem";
import { useRouter } from "next/navigation";

import Shell from "@/components/othello/Shell";
import { checkFactory, createCircle, leastGuarantee, peakNeed, type CircleParams, type TrustResult } from "@/lib/robinhood/adapter";
import { fmtUsdg } from "@/lib/robinhood/copy";
import { robinhoodPublicClient, useEvmWallet } from "@/lib/robinhood/wallet";

import { useWalletUi } from "@/lib/wallet";
import s from "./Robinhood.module.css";

const NETWORK = { chip: "Robinhood Chain testnet", note: "Test USDG only. It has no value." };

const usdg = (t: string): bigint | null => (/^\d+(\.\d{1,6})?$/.test(t.trim()) ? parseUnits(t.trim(), 6) : null);
const whole = (t: string): bigint | null => (/^\d+$/.test(t.trim()) ? BigInt(t.trim()) : null);

export default function RobinhoodCreate() {
  const w = useEvmWallet();
  const connectUi = useWalletUi();
  const router = useRouter();
  const [factory, setFactory] = useState<TrustResult | null>(null);
  const [members, setMembers] = useState<string[]>(["", "", ""]);
  const [c, setC] = useState("1");
  const [minCover, setMinCover] = useState("1.2");
  const [g, setG] = useState("");
  const [roundMin, setRoundMin] = useState("2");
  const [graceSec, setGraceSec] = useState("60");
  const [haircutPct, setHaircutPct] = useState("20");
  const [coveragePct, setCoveragePct] = useState("130");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void checkFactory(robinhoodPublicClient).then(setFactory).catch(() => setFactory({ ok: false, reason: "factory-code" }));
  }, []);

  // The connected wallet is the creator and must be a member: put it in the first EMPTY seat, never over an entry.
  useEffect(() => {
    if (!w.address) return;
    const me = w.address;
    setMembers((m) => {
      if (m.some((x) => x.trim().toLowerCase() === me.toLowerCase())) return m;
      const empty = m.findIndex((x) => x.trim() === "");
      return empty < 0 ? m : m.map((x, i) => (i === empty ? me : x));
    });
  }, [w.address]);

  const parsed = useMemo(() => {
    const problems: string[] = [];
    const n = BigInt(members.length);
    const addrs = members.map((m) => m.trim());
    addrs.forEach((a, i) => {
      if (!isAddress(a)) problems.push(`Member ${i + 1} isn't a valid wallet address.`);
    });
    const lower = addrs.map((a) => a.toLowerCase());
    if (new Set(lower).size !== lower.length) problems.push("Each member must be a different wallet.");
    if (w.address && !lower.includes(w.address.toLowerCase())) problems.push("Your connected wallet must be one of the members.");
    const cU = usdg(c);
    const minU = usdg(minCover);
    const hair = whole(haircutPct);
    const cov = whole(coveragePct);
    const round = whole(roundMin);
    const grace = whole(graceSec);
    if (cU === null || cU < 1n || cU > 1_000_000_000_000n) problems.push("The payment per round must be between 0.000001 and 1,000,000 USDG.");
    if (minU === null || minU > 10_000_000_000_000n) problems.push("The least cover must be a USDG amount up to 10,000,000.");
    if (hair === null || hair >= 100n) problems.push("The haircut must be a whole percent below 100.");
    if (cov === null || cov < 101n || cov > 300n) problems.push("Coverage must be a whole percent from 101 to 300.");
    if (round === null || round < 1n || round > 525_600n) problems.push("A round must last from 1 minute to 1 year.");
    if (grace === null || grace < 30n || grace > 2_592_000n) problems.push("Grace must be from 30 seconds to 30 days.");
    if (problems.length || cU === null || minU === null || hair === null || cov === null || round === null || grace === null) {
      return { problems, params: null, peak: 0n, least: 0n };
    }
    const base = { n, c: cU, coverageBps: cov * 100n, minStockCover: minU };
    const least = leastGuarantee(base);
    // the suggestion is the least allowed, rounded up to the next cent so the numbers read cleanly
    const suggested = ((least + 9_999n) / 10_000n) * 10_000n;
    const gU = g.trim() === "" ? suggested : usdg(g);
    if (gU === null || gU < 1n || gU > 1_000_000_000_000n) problems.push("The guarantee must be a USDG amount above 0.");
    else if (n * gU < peakNeed(base)) problems.push(`The guarantee is too small: at least ${fmtUsdg(least)} each for these numbers.`);
    const params: CircleParams = {
      n,
      c: cU,
      g: gU ?? suggested,
      minStockCover: minU,
      haircutBps: hair * 100n,
      coverageBps: cov * 100n,
      warnBps: 10_000n,
      roundSecs: round * 60n,
      graceSecs: grace,
    };
    return { problems, params, peak: peakNeed(base), least: suggested };
  }, [members, c, minCover, g, roundMin, graceSec, haircutPct, coveragePct, w.address]);

  // least collateral whose haircut value reaches the minimum cover
  const leastLock = useMemo(() => {
    const p = parsed.params;
    if (!p) return null;
    const keep = 10_000n - p.haircutBps;
    return keep === 0n ? null : (p.minStockCover * 10_000n + keep - 1n) / keep;
  }, [parsed.params]);

  async function submit() {
    if (!parsed.params || parsed.problems.length || !w.walletClient || !w.address) return;
    setBusy(true);
    setError(null);
    const r = await createCircle(
      { publicClient: robinhoodPublicClient, walletClient: w.walletClient, account: w.address },
      parsed.params,
      members.map((m) => getAddress(m.trim().toLowerCase())) as Address[],
    );
    setBusy(false);
    if (r.ok) router.push(`/circle/rh:${r.circle}`);
    else setError(r.message);
  }

  const p = parsed.params;
  const notOpen = factory && !factory.ok;

  return (
    <Shell active="Circles" network={NETWORK}>
      <main className={s.page}>
        <header className={s.head}>
          <div className={s.pills}>
            <span className={s.pill}>USDG on Robinhood Chain</span>
            <a className={s.pill} href="/robinhood">My circles</a>
          </div>
          <h1 className={s.title}>Start a savings circle</h1>
          <p className={s.sub}>
            List everyone in payout order, starting with the first person to receive the pot. Each member then opens
            the circle&apos;s link in their own wallet, locks their promise and joins. You start the circle once all
            have joined.
          </p>
        </header>

        {notOpen && (
          <section className={`${s.banner} ${s.refusal}`} role="alert">
            <h2 className={s.bannerTitle}>Robinhood circles aren&apos;t open yet</h2>
            <p className={s.bannerText}>Othello&apos;s contracts on Robinhood Chain testnet are waiting for their final review.</p>
          </section>
        )}

        <section className={`${s.section} ${s.card}`}>
          <h2 className={s.cardTitle}>Members, in payout order (3 to 8)</h2>
          {members.map((m, i) => (
            <label key={i} className={s.field}>
              <span>Member {i + 1}{i === 0 ? " (receives first)" : ""}{w.address && m.toLowerCase() === w.address.toLowerCase() ? " (you)" : ""}</span>
              <input
                value={m}
                placeholder="0x…"
                spellCheck={false}
                onChange={(e) => setMembers((ms) => ms.map((x, k) => (k === i ? e.target.value : x)))}
              />
            </label>
          ))}
          <div className={s.buttons}>
            <button type="button" className={s.btnQuiet} disabled={members.length >= 8}
              onClick={() => setMembers((ms) => [...ms, ""])}>Add a member</button>
            <button type="button" className={s.btnQuiet} disabled={members.length <= 3}
              onClick={() => setMembers((ms) => ms.slice(0, -1))}>Remove the last</button>
          </div>
        </section>

        <section className={`${s.section} ${s.card}`}>
          <h2 className={s.cardTitle}>Money</h2>
          <label className={s.field}><span>Payment per round (USDG)</span>
            <input inputMode="decimal" value={c} onChange={(e) => setC(e.target.value)} /></label>
          <label className={s.field}><span>Least cover each member locks (USDG, after the haircut)</span>
            <input inputMode="decimal" value={minCover} onChange={(e) => setMinCover(e.target.value)} /></label>
          <label className={s.field}><span>Guarantee per member into the shared reserve (USDG)</span>
            <input inputMode="decimal" value={g} placeholder={parsed.least ? `${fmtUsdg(parsed.least).replace(" USDG", "")} (suggested)` : ""}
              onChange={(e) => setG(e.target.value)} /></label>
          <p className={s.helper}>Leave the guarantee empty to use the suggested amount: the least these numbers allow, rounded up to the cent.</p>
        </section>

        <section className={`${s.section} ${s.card}`}>
          <h2 className={s.cardTitle}>Timing and safety</h2>
          <label className={s.field}><span>Round length (minutes)</span>
            <input inputMode="numeric" value={roundMin} onChange={(e) => setRoundMin(e.target.value)} /></label>
          <label className={s.field}><span>Grace after the deadline (seconds)</span>
            <input inputMode="numeric" value={graceSec} onChange={(e) => setGraceSec(e.target.value)} /></label>
          <label className={s.field}><span>Haircut on locked USDG (%)</span>
            <input inputMode="numeric" value={haircutPct} onChange={(e) => setHaircutPct(e.target.value)} /></label>
          <label className={s.field}><span>Coverage required (%)</span>
            <input inputMode="numeric" value={coveragePct} onChange={(e) => setCoveragePct(e.target.value)} /></label>
        </section>

        {p && (
          <section className={`${s.section} ${s.card}`}>
            <h2 className={s.cardTitle}>What this circle means</h2>
            <dl className={s.facts}>
              <div><dt>Each payout</dt><dd>{fmtUsdg(p.n * p.c)}</dd></div>
              <div><dt>Shared reserve at the start</dt><dd>{fmtUsdg(p.n * p.g)}</dd></div>
              <div><dt>Most the reserve may need to cover</dt><dd>{fmtUsdg(parsed.peak)}</dd></div>
              <div><dt>Each member locks at least</dt><dd>{leastLock !== null ? fmtUsdg(leastLock) : "…"}</dd></div>
              <div><dt>Each member needs in USDG</dt><dd>{leastLock !== null ? fmtUsdg(leastLock + p.g + p.n * p.c) : "…"} over the circle</dd></div>
              <div><dt>Fee</dt><dd>None on testnet</dd></div>
            </dl>
          </section>
        )}

        <section className={`${s.section} ${s.act}`} aria-live="polite">
          {parsed.problems.map((x) => <p key={x} className={s.error}>{x}</p>)}
          {!w.hasWallet && <p className={s.muted}>Install MetaMask or another EVM wallet to create a circle.</p>}
          {w.hasWallet && !w.address && (
            <button type="button" className={s.btn} onClick={connectUi.openConnect}>Connect an EVM wallet (MetaMask)</button>
          )}
          {w.address && !w.onRobinhood && (
            <button type="button" className={s.btn} onClick={() => void w.switchToRobinhood()}>Switch to Robinhood Chain testnet</button>
          )}
          {w.address && w.onRobinhood && (
            <button type="button" className={s.btn} disabled={busy || !!notOpen || !p || parsed.problems.length > 0} onClick={() => void submit()}>
              {busy ? "Confirm in your wallet…" : "Create the circle"}
            </button>
          )}
          {error && <p className={s.error} role="status">{error}</p>}
        </section>
      </main>
    </Shell>
  );
}
