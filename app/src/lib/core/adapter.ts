/**
 * Chain adapters, split by rule profile (ARB-DESIGN r9 section A, r8).
 *
 * ChainAdapter      the common-v1 surface. It has NO top-up method.
 * EvmUsdgAdapter    adds topUpReserve({amount, expectedFill}); consent-bound (EVM-I24).
 * SolanaAdapter     adds topUpReserve({amount}); the split can change before it runs (AL11).
 *
 * A top-up screen is typed on EvmUsdgAdapter | SolanaAdapter, narrowed by `profile`, never on
 * ChainAdapter. Every action checks its argument keys (profiles.ts) before touching a wallet.
 */
import { ACTION_ARGS, type Profile } from "./profiles";

export type ActionResult =
  | { ok: true; txHash: string }
  | { ok: false; error: string; args: readonly unknown[]; message: string };

export type Capabilities = {
  oracleCollateral: boolean;
  delinquencyMark: boolean;
  topUpConsentBound: boolean;
};

type NoArgs = Record<string, never>;

export interface ChainAdapter<View = unknown> {
  readonly id: string;
  readonly chainId: number;
  readonly profile: Profile;
  readonly units: { decimals: number; symbol: string };
  readonly capabilities: Capabilities;
  readCircle(id: string): Promise<View>;
  joinAndLock(a: { amount: bigint }): Promise<ActionResult>;
  leaveForming(a: NoArgs): Promise<ActionResult>;
  cancelCircle(a: NoArgs): Promise<ActionResult>;
  activate(a: NoArgs): Promise<ActionResult>;
  contribute(a: NoArgs): Promise<ActionResult>;
  releasePot(a: NoArgs): Promise<ActionResult>;
  updateCoverage(a: NoArgs): Promise<ActionResult>;
  markDelinquent(a: { round: number; turn: number }): Promise<ActionResult>;
  declareDefault(a: { turn: number }): Promise<ActionResult>;
  addStock(a: { amount: bigint }): Promise<ActionResult>;
  withdraw(a: NoArgs): Promise<ActionResult>;
}

export interface EvmUsdgAdapter<View = unknown> extends ChainAdapter<View> {
  readonly profile: "evm-usdg-v1";
  readonly capabilities: Capabilities & { topUpConsentBound: true };
  topUpReserve(a: { amount: bigint; expectedFill: bigint }): Promise<ActionResult>;
}

export interface SolanaAdapter<View = unknown> extends ChainAdapter<View> {
  readonly profile: "solana-pyth-v2";
  readonly capabilities: Capabilities & { topUpConsentBound: false };
  topUpReserve(a: { amount: bigint }): Promise<ActionResult>;
}

export type TopUpAdapter<View = unknown> = EvmUsdgAdapter<View> | SolanaAdapter<View>;

/** The common-v1 surface of any adapter: exactly the common actions, so no top-up can be reached through it. */
export function toCommon<V>(a: ChainAdapter<V>): ChainAdapter<V> {
  const out: Record<string, unknown> = {
    id: a.id,
    chainId: a.chainId,
    profile: "common-v1" satisfies Profile,
    units: a.units,
    capabilities: a.capabilities,
    readCircle: a.readCircle.bind(a),
  };
  for (const k of Object.keys(ACTION_ARGS["common-v1"])) {
    if (k === "quote") continue; // a view, read through readCircle
    const fn = (a as unknown as Record<string, unknown>)[k];
    if (typeof fn === "function") out[k] = fn;
  }
  return Object.freeze(out) as unknown as ChainAdapter<V>;
}
