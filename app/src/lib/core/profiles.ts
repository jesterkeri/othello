/**
 * Rule profiles and their exact action argument lists (ARB-DESIGN r9 section A). The Python source of
 * truth is core/actions.py; tests/core-profiles.spec.ts checks these equal core/actions/<profile>.json.
 * Import-free on purpose: the app, the Robinhood adapter and the root tests all use it.
 */
export type Profile = "common-v1" | "evm-usdg-v1" | "solana-pyth-v2";

const COMMON = {
  activate: [],
  addStock: ["amount"],
  cancelCircle: [],
  contribute: [],
  declareDefault: ["turn"],
  joinAndLock: ["amount"],
  leaveForming: [],
  markDelinquent: ["round", "turn"],
  quote: ["amount"],
  releasePot: [],
  updateCoverage: [],
  withdraw: [],
} as const satisfies Record<string, readonly string[]>;

export const ACTION_ARGS = {
  "common-v1": COMMON,
  "evm-usdg-v1": { ...COMMON, topUpReserve: ["amount", "expectedFill"] },
  "solana-pyth-v2": { ...COMMON, topUpReserve: ["amount"] },
} as const satisfies Record<Profile, Record<string, readonly string[]>>;

export type CommonAction = keyof typeof COMMON;

/** Thrown before any wallet prompt when an action gets other arguments than its profile lists. */
export class InvalidArguments extends Error {
  constructor(
    readonly profile: Profile,
    readonly action: string,
    readonly got: readonly string[],
  ) {
    super(`${action} on ${profile} takes {${listed(profile, action).join(", ")}}, got {${got.join(", ")}}`);
    this.name = "InvalidArguments";
  }
}

function listed(profile: Profile, action: string): readonly string[] {
  return (ACTION_ARGS[profile] as Record<string, readonly string[]>)[action] ?? [];
}

/** Exact keys, no more and no fewer: a caller cannot pass `expectedFill` to Solana and have it dropped. */
export function checkArgs(profile: Profile, action: string, args: object): void {
  const want = (ACTION_ARGS[profile] as Record<string, readonly string[] | undefined>)[action];
  const got = Object.keys(args).sort();
  if (!want || got.length !== want.length || [...want].sort().some((k, i) => k !== got[i])) {
    throw new InvalidArguments(profile, action, got);
  }
}

/** Wraps one profile method so its arguments are checked before `fn` (and so before any wallet prompt). */
export function checked<A extends object, R>(profile: Profile, action: string, fn: (args: A) => Promise<R>) {
  return (args: A): Promise<R> => {
    checkArgs(profile, action, args);
    return fn(args);
  };
}
