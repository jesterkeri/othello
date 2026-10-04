"use client";

/**
 * Robinhood Chain's circle creator deliberately shares the Solana creator's
 * visual grammar. The two chains have different assets and contracts, but a
 * person should learn one clear Othello creation flow.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { getAddress, isAddress, parseUnits, type Address } from "viem";

import NeedChart, { type NeedDatum } from "@/components/othello/NeedChart";
import Shell from "@/components/othello/Shell";
import s from "@/components/othello/Create.module.css";
import { checkFactory, createCircle, type CircleParams, type TrustResult } from "@/lib/robinhood/adapter";
import { fmtUsdg } from "@/lib/robinhood/copy";
import { robinhoodPublicClient, useEvmWallet } from "@/lib/robinhood/wallet";
import { useWalletUi } from "@/lib/wallet";

const NETWORK = { chip: "Robinhood Chain testnet", note: "Test USDG only. It has no value." };
const MIN_MEMBERS = 3;
const MAX_MEMBERS = 8;
const BASE = 1_000_000n;
const SLOTS = ["acid", "sky", "teal", "clay", "cobalt"] as const;

const usdg = (text: string): bigint | null =>
  /^\d+(\.\d{1,6})?$/.test(text.trim()) ? parseUnits(text.trim(), 6) : null;
const whole = (text: string): bigint | null => (/^\d+$/.test(text.trim()) ? BigInt(text.trim()) : null);
const withoutUnit = (amount: bigint) => fmtUsdg(amount).replace(" USDG", "");
const ceilDiv = (a: bigint, b: bigint) => (a === 0n ? 0n : (a - 1n) / b + 1n);

type Schedule = { needs: bigint[]; peak: bigint; least: bigint };

function scheduleFor(n: bigint, contribution: bigint, coverageBps: bigint, minCover: bigint): Schedule {
  const needs: bigint[] = [];
  let peak = 0n;
  for (let turn = 1n; turn < n; turn += 1n) {
    const required = ceilDiv(contribution * (n - turn) * coverageBps, 10_000n);
    const perMember = required > minCover ? required - minCover : 0n;
    const need = turn * perMember;
    needs.push(need);
    if (need > peak) peak = need;
  }
  const least = peak === 0n ? 1n : ceilDiv(peak, n);
  return { needs, peak, least };
}

export default function RobinhoodCreate() {
  const wallet = useEvmWallet();
  const walletUi = useWalletUi();
  const router = useRouter();
  const id = useId();
  const [factory, setFactory] = useState<TrustResult | null>(null);
  const [members, setMembers] = useState<string[]>(["", "", ""]);
  const [contribution, setContribution] = useState("1");
  const [minCover, setMinCover] = useState("1.2");
  const [guarantee, setGuarantee] = useState("");
  const [followSuggestion, setFollowSuggestion] = useState(true);
  const [roundMinutes, setRoundMinutes] = useState("2");
  const [graceSeconds, setGraceSeconds] = useState("60");
  const [haircut, setHaircut] = useState("20");
  const [coverage, setCoverage] = useState("130");
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void checkFactory(robinhoodPublicClient)
      .then(setFactory)
      .catch(() => setFactory({ ok: false, reason: "factory-code" }));
  }, []);

  // The creator must be a member. Fill the first unused seat without changing a written address.
  useEffect(() => {
    if (!wallet.address) return;
    setMembers((current) => {
      if (current.some((member) => member.trim().toLowerCase() === wallet.address!.toLowerCase())) return current;
      const empty = current.findIndex((member) => member.trim() === "");
      return empty < 0 ? current : current.map((member, index) => (index === empty ? wallet.address! : member));
    });
  }, [wallet.address]);

  const model = useMemo(() => {
    const problems: string[] = [];
    const n = BigInt(members.length);
    const addresses = members.map((member) => member.trim());
    addresses.forEach((address, index) => {
      if (!isAddress(address)) problems.push(`Member ${index + 1} needs a valid EVM wallet address.`);
    });
    const lower = addresses.map((address) => address.toLowerCase());
    if (new Set(lower).size !== lower.length) problems.push("Each member must use a different wallet address.");
    if (wallet.address && !lower.includes(wallet.address.toLowerCase())) problems.push("Your connected wallet must be one of the members.");

    const c = usdg(contribution);
    const min = usdg(minCover);
    const hair = whole(haircut);
    const cov = whole(coverage);
    const round = whole(roundMinutes);
    const grace = whole(graceSeconds);
    if (c === null || c < 1n || c > 1_000_000_000_000n) problems.push("Payment per round must be from 0.000001 to 1,000,000 USDG.");
    if (min === null || min < 1n || min > 10_000_000_000_000n) problems.push("Minimum locked cover must be from 0.000001 to 10,000,000 USDG.");
    if (hair === null || hair >= 100n) problems.push("Haircut must be a whole percentage below 100.");
    if (cov === null || cov < 101n || cov > 300n) problems.push("Coverage target must be a whole percentage from 101 to 300.");
    if (round === null || round < 1n || round > 525_600n) problems.push("Round length must be from 1 minute to 1 year.");
    if (grace === null || grace < 30n || grace > 2_592_000n) problems.push("Grace must be from 30 seconds to 30 days.");

    const schedule = c !== null && min !== null && cov !== null && cov >= 101n && cov <= 300n
      ? scheduleFor(n, c, cov * 100n, min)
      : null;
    // Round to a cent for a readable suggestion, while preserving the factory's minimum guarantee rule.
    const suggested = schedule ? ceilDiv(schedule.least, 10_000n) * 10_000n : 0n;
    const guaranteeText = followSuggestion ? withoutUnit(suggested) : guarantee;
    const g = usdg(guaranteeText);
    if (g === null || g < 1n || g > 1_000_000_000_000n) problems.push("Guarantee must be a USDG amount above zero.");
    else if (schedule && n * g < schedule.peak) problems.push(`The guarantee is too small. Each member needs at least ${fmtUsdg(schedule.least)}.`);

    const params =
      problems.length === 0 && c !== null && min !== null && hair !== null && cov !== null && round !== null && grace !== null && g !== null
        ? ({
            n,
            c,
            g,
            minStockCover: min,
            haircutBps: hair * 100n,
            coverageBps: cov * 100n,
            // The Robinhood contract's warning threshold is intentionally fixed at 100%.
            warnBps: 10_000n,
            roundSecs: round * 60n,
            graceSecs: grace,
          } satisfies CircleParams)
        : null;
    return { problems, params, schedule, suggested, guarantee: g };
  }, [members, contribution, minCover, guarantee, followSuggestion, roundMinutes, graceSeconds, haircut, coverage, wallet.address]);

  const shownGuarantee = followSuggestion ? withoutUnit(model.suggested) : guarantee;
  const reserve = model.guarantee === null ? 0n : BigInt(members.length) * model.guarantee;
  const chartData: NeedDatum[] = (model.schedule?.needs ?? []).map((need, index) => ({
    r: `R${index + 1}`,
    need: Number(need) / Number(BASE),
    label: withoutUnit(need),
    over: need > reserve,
    peak: need === model.schedule?.peak && need > 0n,
  }));
  const chartTop = Math.max(1, ...chartData.map((point) => point.need), Number(reserve) / Number(BASE)) * 1.18;
  const keep = model.params ? 10_000n - model.params.haircutBps : 0n;
  const leastLock = model.params && keep > 0n ? ceilDiv(model.params.minStockCover * 10_000n, keep) : null;
  const notOpen = factory !== null && !factory.ok;
  const canCreate = !!model.params && !notOpen && !busy && !!wallet.walletClient && !!wallet.address && wallet.onRobinhood;

  function moveMember(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= members.length) return;
    setMembers((current) => {
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex]!, next[index]!];
      return next;
    });
  }

  function changeGuarantee(delta: -1 | 1) {
    const current = model.guarantee ?? model.suggested;
    const next = current + BigInt(delta) * 5n * BASE;
    setFollowSuggestion(false);
    setGuarantee(withoutUnit(next > 0n ? next : 1n));
  }

  async function submit() {
    if (!wallet.hasWallet) {
      walletUi.openConnect();
      return;
    }
    if (!wallet.address || !wallet.onRobinhood || !wallet.walletClient) return;
    setAttempted(true);
    if (!model.params || notOpen || busy) return;
    setBusy(true);
    setError(null);
    const result = await createCircle(
      { publicClient: robinhoodPublicClient, walletClient: wallet.walletClient, account: wallet.address },
      model.params,
      members.map((member) => getAddress(member.trim().toLowerCase())) as Address[],
    );
    setBusy(false);
    if (result.ok) router.push(`/circle/rh:${result.circle}`);
    else setError(result.message);
  }

  const primaryAction = !wallet.hasWallet ? "Connect EVM wallet" : !wallet.address ? "Connect EVM wallet" : !wallet.onRobinhood ? "Switch to Robinhood Chain" : busy ? "Confirm in your wallet" : "Create circle";

  return (
    <Shell active="Circles" side="robinhood" network={NETWORK}>
      <header className={s.head}>
        <div className={s.headText}>
          <h1 className={s.title}>New circle</h1>
          <p className={s.lede}>Set the payout order, then share the circle link. Every member joins and locks test USDG in their own wallet.</p>
        </div>
        <div className={s.headActions}>
          <div className={s.btnRow}>
            <button type="button" className={s.ghost} onClick={() => router.push("/robinhood")}>My circles</button>
            <button type="button" className={s.primary} aria-busy={busy} disabled={busy || !!notOpen} onClick={() => void submit()}>{primaryAction}</button>
          </div>
        </div>
      </header>

      {notOpen && (
        <div role="alert" className={s.fail}>
          <span>Robinhood circles are unavailable because the trusted factory could not be verified.</span>
        </div>
      )}

      <main className={s.grid}>
        <section className={s.folder} aria-labelledby={`${id}-members`}>
          <div className={s.tabRow}>
            <div className={s.tab}>
              <span className={s.tabText}>
                <span className={s.kicker}>3 to 8 seats</span>
                <h2 id={`${id}-members`} className={s.statement}>Members and turn order</h2>
              </span>
              <span className={s.seatDots} aria-label={`${members.length} of ${MAX_MEMBERS} seats`}>
                {Array.from({ length: MAX_MEMBERS }).map((_, index) => <span key={index} className={index < members.length ? (index === 0 ? s.seatYou : s.seatOn) : undefined} />)}
              </span>
            </div>
            <span className={s.fillet} aria-hidden />
          </div>
          <div className={s.folderBody}>
            <ol className={s.rows}>
              {members.map((member, index) => {
                const slot = SLOTS[index % SLOTS.length];
                const isYou = !!wallet.address && member.trim().toLowerCase() === wallet.address.toLowerCase();
                const invalid = attempted && !isAddress(member.trim());
                return (
              <li key={index} className={s.rowItem}>
                    <div className={`${s.row} ${invalid ? s.rowBad : ""}`} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)` }}>
                      <span className={s.turn} aria-hidden>{index + 1}</span>
                      <input
                        className={s.addr}
                        aria-label={`Member ${index + 1}${index === 0 ? ", receives first" : ""}`}
                        value={member}
                        placeholder={index === 0 ? "Your EVM wallet address" : "EVM wallet address"}
                        spellCheck={false}
                        autoComplete="off"
                        onChange={(event) => setMembers((current) => current.map((value, memberIndex) => (memberIndex === index ? event.target.value : value)))}
                      />
                      {isYou && <span className={s.you}><b>You</b></span>}
                      <span className={s.ctl}>
                        <span className={s.updown}>
                          <button type="button" aria-label={`Move member ${index + 1} up`} disabled={index === 0} onClick={() => moveMember(index, -1)}>↑</button>
                          <button type="button" aria-label={`Move member ${index + 1} down`} disabled={index === members.length - 1} onClick={() => moveMember(index, 1)}>↓</button>
                        </span>
                        {members.length > MIN_MEMBERS ? <button type="button" className={s.remove} aria-label={`Remove member ${index + 1}`} onClick={() => setMembers((current) => current.filter((_, memberIndex) => memberIndex !== index))}>×</button> : <span className={s.ctlSpacer} />}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
            {members.length < MAX_MEMBERS && <button type="button" className={s.add} onClick={() => setMembers((current) => [...current, ""])}><span>{members.length + 1}</span>+ Add member</button>}
          </div>
        </section>

        <section className={s.promise} aria-labelledby={`${id}-guarantee`}>
          <div className={s.promiseTop}>
            <div className={s.gBlock}>
              <label htmlFor={`${id}-guarantee`} className={s.kickerDark}>Guarantee per member</label>
              <div className={s.gRow}>
                <span className={s.gValue}>
                  <input id={`${id}-guarantee`} className={s.gInput} style={{ width: `${Math.max(1, shownGuarantee.length * 0.56 + 0.05)}em` }} value={shownGuarantee} inputMode="decimal" autoComplete="off" onChange={(event) => { setFollowSuggestion(false); setGuarantee(event.target.value); }} />
                  <span>USDG</span>
                </span>
                <span className={s.stepper}>
                  <button type="button" aria-label="Lower guarantee by 5 USDG" onClick={() => changeGuarantee(-1)}>−</button>
                  <button type="button" aria-label="Raise guarantee by 5 USDG" onClick={() => changeGuarantee(1)}>+</button>
                </span>
              </div>
            </div>
            <div className={s.verdictCol}>
              <span className={`${s.verdict} ${model.schedule && reserve < model.schedule.peak ? s.verdictBad : ""}`}>
                <span aria-hidden>{model.schedule && reserve >= model.schedule.peak ? "✓" : "!"}</span>
                {model.guarantee ? `${members.length} × ${fmtUsdg(model.guarantee)} = ${fmtUsdg(reserve)}` : "Enter a guarantee"}
              </span>
              {model.schedule && (followSuggestion ? <span className={s.proposed}>suggested from schedule</span> : <button type="button" className={s.propose} onClick={() => setFollowSuggestion(true)}>Use suggested {fmtUsdg(model.suggested)}</button>)}
            </div>
          </div>
          <div className={s.chart} role="img" aria-label={model.schedule ? `The highest reserve need is ${fmtUsdg(model.schedule.peak)}.` : "Enter circle settings to see the reserve schedule."}>
            {model.schedule && <NeedChart data={chartData} reserve={Number(reserve) / Number(BASE)} reserveLabel={withoutUnit(reserve)} top={chartTop} refusal={reserve < model.schedule.peak} unit="USDG" />}
          </div>
          {model.schedule && reserve < model.schedule.peak && <div role="alert" className={s.refusal}><p>The shared reserve must cover the busiest round. Use at least {fmtUsdg(model.schedule.least)} per member.</p><button type="button" onClick={() => setFollowSuggestion(true)}>Use suggestion</button></div>}
        </section>

        <section className={s.sheet} aria-label="Circle settings">
          <div className={s.group}>
            <div className={s.band}><span className={s.bandIcon}>1</span><span className={s.bandRange}>PAYOUT</span></div>
            <Setting id={`${id}-payment`} label="Payment per round" unit="USDG" value={contribution} onChange={setContribution} />
            <Setting id={`${id}-round`} label="Round length" unit="MIN" value={roundMinutes} onChange={setRoundMinutes} />
            <Setting id={`${id}-grace`} label="Grace after deadline" unit="SEC" value={graceSeconds} onChange={setGraceSeconds} />
          </div>
          <div className={s.group}>
            <div className={s.band}><span className={s.bandIcon}>2</span><span className={s.bandRange}>COVER</span></div>
            <Setting id={`${id}-cover`} label="Minimum locked cover" unit="USDG" value={minCover} onChange={setMinCover} />
            <Setting id={`${id}-haircut`} label="Haircut" unit="%" value={haircut} onChange={setHaircut} />
            <Setting id={`${id}-coverage`} label="Coverage target" unit="%" value={coverage} onChange={setCoverage} />
            <div className={s.field}><div className={`${s.fieldRow} ${s.fieldRowNumbered}`}><span className={s.no}>07</span><span className={s.fieldLabel}><span>Payment warning</span><small>fixed by contract</small></span><span className={s.valuePill}><input value="100" readOnly aria-label="Payment warning fixed at 100 percent" /><span>%</span></span></div></div>
          </div>
        </section>
      </main>

      <section className={s.phoneBar} aria-live="polite">
        <button type="button" className={s.ghost} onClick={() => router.push("/robinhood")}>My circles</button>
        <button type="button" className={s.primary} aria-busy={busy} disabled={busy || !!notOpen || (!!wallet.address && wallet.onRobinhood && !canCreate)} onClick={() => void submit()}>{primaryAction}</button>
      </section>

      <section aria-live="polite">
        {attempted && model.problems.map((problem) => <p key={problem} className={s.fieldErr}>{problem}</p>)}
        {leastLock !== null && model.params && <p className={s.lede}>Each member locks at least {fmtUsdg(leastLock)} after the {haircut}% haircut, then joins from the circle link in their own wallet.</p>}
        {error && <p role="alert" className={s.fail}>{error}</p>}
      </section>
    </Shell>
  );
}

function Setting({ id, label, unit, value, onChange }: { id: string; label: string; unit: string; value: string; onChange: (value: string) => void }) {
  return (
    <div className={s.field}>
      <div className={s.fieldRow}>
        <label htmlFor={id} className={s.fieldLabel}>{label}</label>
        <span className={s.valuePill}><input id={id} value={value} inputMode="decimal" autoComplete="off" onChange={(event) => onChange(event.target.value)} /><span>{unit}</span></span>
      </div>
    </div>
  );
}
