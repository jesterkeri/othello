'use client';

// S4 Create, v2. Layout: header row; members folder card (left, full height); guarantee card + settings sheet (right).
// Product strings follow design/FLOWS.md. Peak-guarantee rule: SPEC.md create_circle / guarantee_below_peak_need.
import { useId, useRef, useState, type DragEvent } from 'react';
import Shell from './Shell';
import NeedChart, { type NeedDatum } from './NeedChart';
import s from './Create.module.css';

export const USDC = 1_000_000;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX = 8, MIN = 3, STEP = 5 * USDC;

export type FieldKey = 'contribution' | 'roundLength' | 'grace' | 'haircut' | 'coverage' | 'warn' | 'minStockCover' | 'guarantee';
export type CreateParams = {
  members: string[]; contributionUnits: number; guaranteePerMemberUnits: number; minStockCoverUnits: number;
  roundSecs: number; graceSecs: number; haircutBps: number; coverageBps: number; warnBps: number;
};
export type Invite = { turn: number; wallet: string; url: string };
export type TxPhase = 'idle' | 'awaitingWallet' | 'submitted' | 'confirmed' | 'failed';
export type CreateError = { kind: 'rejected' | 'expired' | 'program'; field?: FieldKey; reason?: string };
export type CreateProps = {
  walletAddress?: string | null;
  onConnectWallet?: () => void;
  onCreate?: (p: CreateParams, progress: (phase: 'awaitingWallet' | 'submitted') => void) => Promise<{ invites: Invite[] }>;
  onCancel?: () => void;
  onViewCircle?: () => void;
  onNavigate?: (label: string) => void;
};

type Nums = Record<FieldKey, number>;
const SPEC: Record<FieldKey, { label: string; unit: string; rule: string; ok: (v: number, f: Nums) => boolean }> = {
  contribution: { label: 'Contribution', unit: 'USDC', rule: 'more than 0 USDC', ok: (v) => v > 0 },
  roundLength: { label: 'Round length', unit: 'SEC', rule: 'a whole number of seconds, at least 60', ok: (v) => Number.isInteger(v) && v >= 60 },
  grace: { label: 'Grace', unit: 'SEC', rule: 'a whole number of seconds, at least 30', ok: (v) => Number.isInteger(v) && v >= 30 },
  haircut: { label: 'Haircut', unit: '%', rule: 'from 0% to 99.99%', ok: (v) => v >= 0 && v <= 99.99 },
  coverage: { label: 'Coverage target', unit: '%', rule: 'at least 100%', ok: (v) => v >= 100 },
  warn: { label: 'Warn', unit: '%', rule: 'at least 100% and below the coverage target', ok: (v, f) => v >= 100 && (!Number.isFinite(f.coverage) || v < f.coverage) },
  minStockCover: { label: 'Minimum stock cover', unit: 'USDC', rule: 'more than 0 USDC', ok: (v) => v > 0 },
  guarantee: { label: 'Guarantee per member', unit: 'USDC', rule: 'more than 0 USDC', ok: (v) => v > 0 },
};
const KEYS = Object.keys(SPEC) as FieldKey[];
const GROUPS: { range: string; icon: string; lit: number; slot: 'teal' | 'sky'; keys: FieldKey[] }[] = [
  { range: '01–03', icon: 'M12 7.5v5l3 2M9.5 2.8h5M12 5.5a7.5 7.5 0 1 1 0 15a7.5 7.5 0 1 1 0-15', lit: 3, slot: 'teal', keys: ['contribution', 'roundLength', 'grace'] },
  { range: '04–07', icon: 'M12 3.2 19.5 6v5.6c0 4.5-3.1 8-7.5 9.3-4.4-1.3-7.5-4.8-7.5-9.3V6zM8.6 12.2l2.4 2.4 4.4-4.6', lit: 7, slot: 'sky', keys: ['haircut', 'coverage', 'warn', 'minStockCover'] },
];
const ROW_SLOTS = ['sky', 'teal', 'clay', 'cobalt'] as const;
const DEMO = { contribution: '50', roundLength: '120', grace: '60', haircut: '20', coverage: '130', warn: '110', minStockCover: '120', guarantee: '35' };

const num = (v: string) => { const t = v.replace(/[\s,_]/g, ''); return t === '' ? NaN : Number(t); };
const toU = (v: number) => Math.round(v * USDC);
export const fmt = (u: number) => (u / USDC).toLocaleString('en-US', { maximumFractionDigits: 6 });

/** need_k = k × max(0, ceil(c × (n−k) × coverage / 10000) − min_stock_cover), k = 1 … n−1. */
export function schedule(n: number, cU: number, bps: number, minU: number) {
  const needs: number[] = [];
  for (let k = 1; k < n; k++) needs.push(k * Math.max(0, Math.ceil((cU * (n - k) * bps) / 10000) - minU));
  const peak = needs.length ? Math.max(...needs) : 0;
  return { needs, peak, busiest: needs.indexOf(peak) + 1 };
}
function derive(v: Record<FieldKey, string>, n: number) {
  const f = Object.fromEntries(KEYS.map((k) => [k, num(v[k])])) as Nums;
  const errs: Partial<Record<FieldKey, string>> = {};
  KEYS.forEach((k) => { if (!(Number.isFinite(f[k]) && SPEC[k].ok(f[k], f))) errs[k] = `${SPEC[k].label} must be ${SPEC[k].rule}`; });
  const sched = !errs.contribution && !errs.coverage && !errs.minStockCover && n >= 2 ? schedule(n, toU(f.contribution), Math.round(f.coverage * 100), toU(f.minStockCover)) : null;
  const min = sched ? Math.ceil(sched.peak / n) : null;
  const proposal = min !== null ? (Math.floor(min / STEP) + 1) * STEP : null;
  return { f, errs, sched, min, proposal };
}

type Row = { key: string; address: string; creator?: boolean };

export default function Create({ walletAddress = null, onConnectWallet, onCreate, onCancel, onViewCircle, onNavigate }: CreateProps) {
  const uid = useId();
  const [values, setValues] = useState<Record<FieldKey, string>>(DEMO);
  const [follow, setFollow] = useState(true);
  const [rows, setRows] = useState<Row[]>([{ key: 'me', address: '', creator: true }, ...[1, 2, 3, 4].map((i) => ({ key: `m${i}`, address: '' }))]);
  const nextKey = useRef(5);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = useState(false);
  const [tx, setTx] = useState<{ phase: TxPhase; reason?: string; invites?: Invite[] }>({ phase: 'idle' });
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const n = rows.length;
  const d0 = derive(values, n);
  const gStr = follow && d0.proposal !== null ? String(d0.proposal / USDC) : values.guarantee;
  const d = derive({ ...values, guarantee: gStr }, n);
  const gU = Number.isFinite(d.f.guarantee) && !d.errs.guarantee ? toU(d.f.guarantee) : 0;
  const reserve = n * gU;
  const sched = d.sched;
  const refusal = !!sched && gU > 0 && reserve < sched.peak;
  const safe = !!sched && gU > 0 && !refusal;
  const shown = (k: FieldKey) => (attempted || touched[k] ? d.errs[k] : undefined);

  const addrs = rows.map((r) => (r.creator ? walletAddress ?? '' : r.address.replace(/\s+/g, '')));
  const probs = rows.map((r, i) => {
    if (r.creator) return null;
    if (!addrs[i] || !B58.test(addrs[i])) return `Member ${i + 1} must be a wallet address`;
    if (addrs.indexOf(addrs[i]) !== i) return `Member ${i + 1} must be unique`;
    return null;
  });
  const rowErr = (i: number) => (probs[i] && (attempted || (addrs[i] && (touched[rows[i]!.key] || probs[i]!.endsWith('unique')))) ? probs[i] : null);
  const valid = !!walletAddress && n >= MIN && n <= MAX && probs.every((p) => !p) && Object.keys(d.errs).length === 0 && !refusal;
  const busy = tx.phase === 'awaitingWallet' || tx.phase === 'submitted';

  const setField = (k: FieldKey, v: string) => { setValues((p) => ({ ...p, [k]: v })); if (k === 'guarantee') setFollow(false); };
  const bump = (dir: 1 | -1) => { setFollow(false); setValues((p) => ({ ...p, guarantee: String(Math.max(0, (gU / USDC || 0) + dir * 5)) })); };
  const move = (i: number, dir: -1 | 1) => { const j = i + dir; if (j < 0 || j >= n) return; const next = [...rows]; [next[i], next[j]] = [next[j]!, next[i]!]; setRows(next); };
  const onDrop = (e: DragEvent, i: number) => {
    e.preventDefault();
    const from = rows.findIndex((r) => r.key === drag);
    if (from > -1 && from !== i) { const next = [...rows]; const [m] = next.splice(from, 1); next.splice(i, 0, m!); setRows(next); }
    setDrag(null); setOver(null);
  };

  async function submit() {
    if (!walletAddress) { onConnectWallet?.(); return; }
    setAttempted(true);
    if (!valid || busy) return;
    const params: CreateParams = {
      members: addrs, contributionUnits: toU(d.f.contribution), guaranteePerMemberUnits: gU, minStockCoverUnits: toU(d.f.minStockCover),
      roundSecs: d.f.roundLength, graceSecs: d.f.grace, haircutBps: Math.round(d.f.haircut * 100), coverageBps: Math.round(d.f.coverage * 100), warnBps: Math.round(d.f.warn * 100),
    };
    setTx({ phase: 'awaitingWallet' });
    try {
      const res = onCreate ? await onCreate(params, (phase) => setTx({ phase })) : { invites: [] };
      setTx({ phase: 'confirmed', invites: res.invites });
    } catch (err) {
      const x = (err ?? {}) as CreateError;
      setTx({ phase: 'failed', reason: x.kind === 'rejected' ? 'You cancelled in your wallet. Nothing was sent.' : x.kind === 'expired' ? "That transaction didn't land. Nothing changed." : x.reason });
    }
  }

  const chartData: NeedDatum[] = sched ? sched.needs.map((u, i) => ({ r: `R${i + 1}`, need: u / USDC, label: fmt(u), over: gU > 0 && u > reserve, peak: i + 1 === sched.busiest && u > 0 })) : [];
  const chartTop = sched ? (Math.max(sched.peak, reserve) / USDC) * 1.18 : 1;
  const eq = gU > 0 ? `${n} × ${fmt(gU)} = ${fmt(reserve)} USDC` : '';
  const stepIdx = tx.phase === 'awaitingWallet' ? 0 : tx.phase === 'submitted' ? 1 : -1;

  return (
    <Shell walletAddress={walletAddress} onConnectWallet={onConnectWallet} onNavigate={onNavigate}>
      <header className={s.head}>
        <div className={s.headText}>
          <h1 className={s.title}>New circle</h1>
          <p className={s.lede}>{tx.phase === 'confirmed' ? "Circle created. Share each member's invite link." : "You'll name every member and the order they get paid. Each member confirms when they join."}</p>
        </div>
        {tx.phase !== 'confirmed' && (
          <div className={s.headActions}>
            <div className={s.btnRow}>
              <button type="button" className={s.ghost} onClick={onCancel}>Cancel</button>
              <button type="button" className={s.primary} aria-busy={busy} onClick={submit}>
                {walletAddress ? 'Create circle' : 'Connect wallet'}
                <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={3.1} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6.5 17.5 17.5 6.5M9 6.5h8.5V15" /></svg>
              </button>
            </div>
            {stepIdx > -1 && (
              <ol className={s.status} aria-live="polite">
                {['Awaiting wallet', 'Submitted', 'Confirmed'].map((label, i) => <li key={label} className={i < stepIdx ? s.stepDone : i === stepIdx ? s.stepOn : ''}><span />{label}</li>)}
              </ol>
            )}
            {tx.phase === 'failed' && (
              <div role="alert" className={s.fail}><span>{tx.reason}</span><button type="button" onClick={submit}>Try again</button></div>
            )}
          </div>
        )}
      </header>

      {tx.phase === 'confirmed' ? (
        <div className={s.done}>
          <ol className={s.invites}>
            {(tx.invites ?? []).map((v) => (
              <li key={v.wallet}><b>{v.turn}</b><span title={v.wallet}>{v.wallet.slice(0, 4)}…{v.wallet.slice(-4)}</span><a href={v.url}>{v.url}</a></li>
            ))}
          </ol>
          <button type="button" className={s.primary} onClick={onViewCircle}>View circle</button>
        </div>
      ) : (
        <div className={s.grid}>
          {/* Members: folder card */}
          <section className={s.folder} aria-labelledby={`${uid}-members`}>
            <div className={s.tabRow}>
              <span className={s.tab}>
                <span className={s.tabText}>
                  <span className={s.kicker}>3 to 8 seats</span>
                  <h2 id={`${uid}-members`} className={s.statement}>Members and turn order</h2>
                </span>
                <span className={s.seatDots} role="img" aria-label={`${n} / ${MAX}`}>
                  {Array.from({ length: MAX }).map((_, i) => <span key={i} className={i === 0 ? s.seatYou : i < n ? s.seatOn : ''} />)}
                </span>
              </span>
              <span className={s.fillet} aria-hidden />
            </div>
            <div className={s.folderBody}>
              <ol className={s.rows}>
                {rows.map((r, i) => {
                  const err = rowErr(i);
                  const slot = r.creator ? 'acid' : ROW_SLOTS[(i - 1 + ROW_SLOTS.length) % ROW_SLOTS.length];
                  return (
                    <li key={r.key} draggable onDragStart={(e) => { if ((e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); return; } setDrag(r.key); }}
                      onDragOver={(e) => { e.preventDefault(); setOver(r.key); }} onDrop={(e) => onDrop(e, i)} onDragEnd={() => { setDrag(null); setOver(null); }}
                      className={`${s.rowItem} ${drag === r.key ? s.dragging : ''} ${over === r.key && drag && drag !== r.key ? s.dropTarget : ''}`}>
                      <div className={`${s.row} ${err ? s.rowBad : ''}`} style={{ background: `var(--${slot})`, color: `var(--${slot}Ink)` }}>
                        <span className={s.turn} aria-hidden>{i + 1}</span>
                        {r.creator ? (
                          walletAddress
                            ? <span className={s.you}><span title={walletAddress}>{walletAddress}</span><b>You</b></span>
                            : <span className={s.you}><button type="button" className={s.connectInline} onClick={onConnectWallet}>Connect wallet</button></span>
                        ) : (
                          <input className={s.addr} aria-label={`Member ${i + 1}`} value={r.address} placeholder="Wallet address" spellCheck={false} autoComplete="off"
                            aria-invalid={!!err} aria-describedby={err ? `${uid}-${r.key}-err` : undefined}
                            onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, address: e.target.value } : x)))}
                            onBlur={() => setTouched((t) => ({ ...t, [r.key]: true }))} />
                        )}
                        <span className={s.ctl}>
                          <span className={s.updown}>
                            <button type="button" aria-label={`Move member ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={3.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 15l6-6 6 6" /></svg></button>
                            <button type="button" aria-label={`Move member ${i + 1} down`} disabled={i === n - 1} onClick={() => move(i, 1)}><svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={3.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg></button>
                          </span>
                          {r.creator ? <span className={s.ctlSpacer} /> : (
                            <button type="button" className={s.remove} aria-label={`Remove member ${i + 1}`} onClick={() => setRows(rows.filter((x) => x.key !== r.key))}><svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={3.6} strokeLinecap="round" aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg></button>
                          )}
                        </span>
                      </div>
                      {err && <span id={`${uid}-${r.key}-err`} role="alert" className={s.rowErr}>{err}</span>}
                    </li>
                  );
                })}
              </ol>
              {n < MIN && <span role="status" className={s.minNote}>Add at least 3 members</span>}
              {n < MAX && (
                <button type="button" className={s.add} onClick={() => { const key = `m${nextKey.current++}`; setRows([...rows, { key, address: '' }]); }}>
                  <span>{n + 1}</span>+ Add member
                </button>
              )}
            </div>
          </section>

          {/* Guarantee + peak need */}
          <section className={s.promise}>
            <div className={s.promiseTop}>
              <div className={s.gBlock}>
                <label htmlFor={`${uid}-g`} className={s.kickerDark}>Guarantee per member</label>
                <div className={s.gRow}>
                  <span className={s.gValue}>
                    <input id={`${uid}-g`} className={s.gInput} style={{ width: `${Math.max(1, gStr.length * 0.56 + 0.05)}em` }} value={gStr} inputMode="decimal" autoComplete="off"
                      aria-invalid={!!(shown('guarantee') || refusal)} onChange={(e) => setField('guarantee', e.target.value)} onBlur={() => setTouched((t) => ({ ...t, guarantee: true }))} />
                    <span>USDC</span>
                  </span>
                  <span className={s.stepper}>
                    <button type="button" aria-label="Lower the guarantee by 5" onClick={() => bump(-1)}>−</button>
                    <button type="button" aria-label="Raise the guarantee by 5" onClick={() => bump(1)}>+</button>
                  </span>
                </div>
              </div>
              <div className={s.verdictCol}>
                <span className={`${s.verdict} ${refusal ? s.verdictBad : ''}`}>
                  <span role="img" aria-label={safe ? 'covered' : 'not covered'}>
                    {safe
                      ? <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={3.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                      : <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={3.8} strokeLinecap="round" aria-hidden><path d="M7 7l10 10M17 7 7 17" /></svg>}
                  </span>
                  {eq}
                </span>
                {d.proposal !== null && (follow
                  ? <span className={s.proposed}>proposed from schedule</span>
                  : d.proposal !== gU && <button type="button" className={s.propose} onClick={() => setFollow(true)}>proposed from schedule <b>{fmt(d.proposal)} USDC</b></button>)}
              </div>
            </div>
            <div className={s.chart} role="img" aria-label={sched ? `peak need ${fmt(sched.peak)} USDC. ${eq}` : undefined}>
              {sched && <NeedChart data={chartData} reserve={reserve / USDC} reserveLabel={fmt(reserve)} top={chartTop} refusal={refusal} />}
            </div>
            {refusal && (
              <div role="alert" className={s.refusal}>
                <p>Each member&apos;s guarantee must be at least {fmt(d.min ?? 0)} USDC so the reserve covers the busiest round</p>
                <button type="button" onClick={() => setFollow(true)}>Raise the guarantee</button>
              </div>
            )}
            {shown('guarantee') && <span role="alert" className={s.fieldErr}>{shown('guarantee')}</span>}
          </section>

          {/* Settings sheet */}
          <section className={s.sheet}>
            {GROUPS.map((g) => (
              <div key={g.range} className={s.group}>
                <div className={s.band} style={{ background: `var(--${g.slot})`, color: `var(--${g.slot}Ink)` }}>
                  <span className={s.bandIcon}><svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={g.icon} /></svg></span>
                  <span className={s.bandRange}>{g.range}</span>
                  <span className={s.matrix} aria-hidden>{Array.from({ length: 9 }).map((_, k) => <span key={k} className={k < g.lit ? s.lit : ''} />)}</span>
                </div>
                {g.keys.map((k) => {
                  const err = shown(k);
                  const hint = ['haircut', 'coverage', 'warn'].includes(k) && Number.isFinite(d.f[k]) && !d.errs[k] ? `${Math.round(d.f[k] * 100)} bps` : '';
                  return (
                    <div key={k} className={s.field}>
                      <div className={s.fieldRow}>
                        <span className={s.no}>{String(KEYS.indexOf(k) + 1).padStart(2, '0')}</span>
                        <label htmlFor={`${uid}-${k}`} className={s.fieldLabel}><span>{SPEC[k].label}</span>{hint && <small>{hint}</small>}</label>
                        <span className={`${s.valuePill} ${err ? s.valueBad : ''}`}>
                          <input id={`${uid}-${k}`} value={values[k]} inputMode="decimal" autoComplete="off" aria-invalid={!!err} aria-describedby={err ? `${uid}-${k}-err` : undefined}
                            onChange={(e) => setField(k, e.target.value)} onBlur={() => setTouched((t) => ({ ...t, [k]: true }))} />
                          <span>{SPEC[k].unit}</span>
                        </span>
                      </div>
                      {err && <span id={`${uid}-${k}-err`} role="alert" className={s.fieldErr}>{err}</span>}
                    </div>
                  );
                })}
              </div>
            ))}
          </section>
        </div>
      )}

      {tx.phase !== 'confirmed' && (
        <div className={s.phoneBar}>
          <button type="button" className={s.ghost} onClick={onCancel}>Cancel</button>
          <button type="button" className={s.primary} aria-busy={busy} onClick={submit}>{walletAddress ? 'Create circle' : 'Connect wallet'}</button>
        </div>
      )}
    </Shell>
  );
}
