/**
 * The Robinhood Chain adapter (evm-usdg-v1), ARB-DESIGN r9 section A: the implementation, with the factory
 * injected. App code never imports this module: it imports ./adapter, whose functions bind the factory to
 * TRUSTED_FACTORY from ./config and take no factory argument (CI job trust-config enforces the boundary).
 * Tests import it to run against local deployments.
 *
 * Before rendering a join, asking for any approval or sending any write, a circle must pass the trust
 * check, in order: it has code; the pinned factory's runtime code hash matches; the factory's own registry
 * lists it (`isCircle`); and it names that factory (`factory()`). There is no per-circle code hash:
 * immutables make every circle's bytecode differ. Chain ids must be 46630 on both the read client and the
 * wallet. Approvals are for the exact amount of the action, never unlimited.
 */
import {
  erc20Abi,
  getAddress,
  isAddressEqual,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

import type { ActionResult, EvmUsdgAdapter } from "../core/adapter";
import { checked } from "../core/profiles";
import { othelloCircleAbi, othelloFactoryAbi } from "./abi.generated";
import { ROBINHOOD_TESTNET_ID, USDG, USDG_DECIMALS } from "./chain";
import { explainRefusal } from "./copy";
import type { TrustedFactory } from "./config";

export const STATUS = ["Forming", "Active", "Completed", "Cancelled"] as const;
export type Status = (typeof STATUS)[number];

export type RhSeat = {
  turn: number;
  wallet: Address;
  collateral: bigint;
  g: bigint;
  topUps: bigint;
  forfeited: bigint;
  allocated: bigint;
  lastCoverageBps: number;
  delinquentMarks: number;
  roundsPaid: number;
  joined: boolean;
  paid: boolean;
  received: boolean;
  defaulted: boolean;
  marked: boolean;
  withdrawn: boolean;
};

export type RhCircleView = {
  address: Address;
  factory: Address;
  creator: Address;
  n: number;
  c: bigint;
  g: bigint;
  minStockCover: bigint;
  haircutBps: number;
  coverageBps: number;
  warnBps: number;
  roundSecs: number;
  graceSecs: number;
  status: Status;
  round: number;
  deadline: number;
  reserveTotal: bigint;
  reserveLosses: bigint;
  reserveAllocated: bigint;
  escrow: bigint;
  escrowDeficit: bigint;
  withdrawnFromReserve: bigint;
  collateralReturned: bigint;
  depositsTotal: bigint;
  forfeitedTotal: bigint;
  nextGateShortBy: bigint;
  heldContributions: bigint;
  lastCoverageAt: number;
  /** USDG the circle holds, and the part no function counts (sent directly; locked forever, AL9). */
  balance: bigint;
  surplus: bigint;
  seats: RhSeat[];
  readAt: number;
};

export type TrustResult =
  | { ok: true }
  | { ok: false; reason: "not-deployed" | "no-code" | "factory-code" | "not-registered" | "wrong-factory" };

/** The four ordered checks. Pure reads; safe to run on every render and before every write. */
export async function checkTrustedAgainst(
  client: Pick<PublicClient, "getCode" | "readContract">,
  circle: Address,
  factory: TrustedFactory | null,
): Promise<TrustResult> {
  if (!factory) return { ok: false, reason: "not-deployed" };
  const code = await client.getCode({ address: circle });
  if (!code || code === "0x") return { ok: false, reason: "no-code" };
  const fcode = await client.getCode({ address: factory.address });
  if (!fcode || fcode === "0x" || keccak256(fcode) !== factory.codeHash.toLowerCase()) {
    return { ok: false, reason: "factory-code" };
  }
  const listed = await client.readContract({
    address: factory.address,
    abi: othelloFactoryAbi,
    functionName: "isCircle",
    args: [circle],
  });
  if (!listed) return { ok: false, reason: "not-registered" };
  const named = await client.readContract({ address: circle, abi: othelloCircleAbi, functionName: "factory" });
  if (!isAddressEqual(named, factory.address)) return { ok: false, reason: "wrong-factory" };
  return { ok: true };
}

const bit = (map: number, t: number) => ((map >> t) & 1) === 1;

export async function readCircle(
  client: Pick<PublicClient, "readContract">,
  circle: Address,
  usdg: Address = USDG,
): Promise<RhCircleView> {
  const r = <T,>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: circle, abi: othelloCircleAbi, functionName, args } as never) as Promise<T>;
  const [
    factory, creator, n, c, g, minStockCover, haircutBps, coverageBps, warnBps, roundSecs, graceSecs,
    status, round, deadline, paid, joined, withdrawn, received, defaulted, marked,
    reserveTotal, reserveLosses, reserveAllocated, escrow, escrowDeficit, withdrawnFromReserve,
    collateralReturned, depositsTotal, forfeitedTotal, nextGateShortBy, heldContributions, lastCoverageAt, accounted,
  ] = await Promise.all([
    r<Address>("factory"), r<Address>("creator"), r<bigint>("n"), r<bigint>("c"), r<bigint>("g"),
    r<bigint>("minStockCover"), r<bigint>("haircutBps"), r<bigint>("coverageBps"), r<bigint>("warnBps"),
    r<bigint>("roundSecs"), r<bigint>("graceSecs"),
    r<number>("status"), r<number>("round"), r<bigint>("deadline"), r<number>("paidBitmap"), r<number>("joinedBitmap"),
    r<number>("withdrawnBitmap"), r<number>("receivedBitmap"), r<number>("defaultedBitmap"), r<number>("delinquentBitmap"),
    r<bigint>("reserveTotal"), r<bigint>("reserveLosses"), r<bigint>("reserveAllocated"), r<bigint>("escrow"),
    r<bigint>("escrowDeficit"), r<bigint>("withdrawnFromReserve"), r<bigint>("collateralReturned"),
    r<bigint>("depositsTotal"), r<bigint>("forfeitedTotal"), r<bigint>("nextGateShortBy"),
    r<bigint>("heldContributions"), r<bigint>("lastCoverageAt"), r<bigint>("accounted"),
  ]);
  const count = Number(n);
  const [members, seats, balance] = await Promise.all([
    Promise.all(Array.from({ length: count }, (_, t) => r<Address>("members", [BigInt(t)]))),
    Promise.all(
      Array.from({ length: count }, (_, t) =>
        r<{
          collateral: bigint; g: bigint; topUps: bigint; forfeited: bigint; allocated: bigint;
          lastCoverageBps: number; delinquentMarks: number; roundsPaid: number;
        }>("seat", [BigInt(t)]),
      ),
    ),
    client.readContract({ address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [circle] }),
  ]);
  return {
    address: getAddress(circle),
    factory, creator, n: count, c, g, minStockCover,
    haircutBps: Number(haircutBps), coverageBps: Number(coverageBps), warnBps: Number(warnBps),
    roundSecs: Number(roundSecs), graceSecs: Number(graceSecs),
    status: STATUS[status] ?? "Forming",
    round, deadline: Number(deadline),
    reserveTotal, reserveLosses, reserveAllocated, escrow, escrowDeficit, withdrawnFromReserve,
    collateralReturned, depositsTotal, forfeitedTotal, nextGateShortBy, heldContributions,
    lastCoverageAt: Number(lastCoverageAt),
    balance,
    surplus: balance > accounted ? balance - accounted : 0n,
    seats: seats.map((s, t) => ({
      turn: t,
      wallet: members[t]!,
      ...s,
      joined: bit(joined, t),
      paid: bit(paid, t),
      received: bit(received, t),
      defaulted: bit(defaulted, t),
      marked: bit(marked, t),
      withdrawn: bit(withdrawn, t),
    })),
    readAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Gas limit with headroom over the node's estimate. Estimates can come in just under what a call needs
 * (seen as an out-of-gas releasePot, 1 run in 6, on anvil), and Arbitrum-based chains add L1 costs; an
 * unused limit costs nothing. 20% plus 10,000.
 */
export const withHeadroom = (estimate: bigint) => (estimate * 12n) / 10n + 10_000n;

/** min(escrowDeficit, amount): the part of a top-up that pays other members' missed payments (EVM-I24). */
export const topUpFill = (escrowDeficit: bigint, amount: bigint) => (escrowDeficit < amount ? escrowDeficit : amount);

type ViemLike = Error & { shortMessage?: string; walk?: (fn: (e: unknown) => boolean) => unknown };
type RevertLike = { name: string; data?: { errorName?: string; args?: readonly unknown[] } };

/**
 * Decodes a failed call into the contract's own error and arguments. Matches viem errors by `name`, not
 * `instanceof`, so a second copy of viem (tests, bundler duplication) cannot hide a refusal.
 */
export function decodeFailure(e: unknown): Extract<ActionResult, { ok: false }> {
  const err = e as ViemLike;
  if (err && typeof err.walk === "function") {
    if (err.walk((x) => (x as Error)?.name === "UserRejectedRequestError")) {
      return { ok: false, error: "UserRejected", args: [], message: explainRefusal("UserRejected", []) };
    }
    const revert = err.walk((x) => (x as Error)?.name === "ContractFunctionRevertedError") as RevertLike | null;
    const name = revert?.data?.errorName;
    if (name) {
      const args = revert.data?.args ?? [];
      return { ok: false, error: name, args, message: explainRefusal(name, args) };
    }
    return { ok: false, error: "Failed", args: [], message: err.shortMessage ?? err.message };
  }
  return { ok: false, error: "Failed", args: [], message: e instanceof Error ? e.message : String(e) };
}

export type RobinhoodDeps = {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Address;
  circle: Address;
  factory: TrustedFactory | null;
  /** Test hook: USDG address (defaults to the Robinhood testnet USDG). */
  usdg?: Address;
};

export type RobinhoodAdapter = EvmUsdgAdapter<RhCircleView> & { trust(): Promise<TrustResult> };

export function createRobinhoodAdapterWith(d: RobinhoodDeps): RobinhoodAdapter {
  const usdg = d.usdg ?? USDG;
  const P = "evm-usdg-v1" as const;

  async function guard(): Promise<Extract<ActionResult, { ok: false }> | null> {
    const [readChain, walletChain] = await Promise.all([d.publicClient.getChainId(), d.walletClient.getChainId()]);
    if (readChain !== ROBINHOOD_TESTNET_ID || walletChain !== ROBINHOOD_TESTNET_ID) {
      return { ok: false, error: "WrongNetwork", args: [walletChain], message: explainRefusal("WrongNetwork", []) };
    }
    const t = await checkTrustedAgainst(d.publicClient, d.circle, d.factory);
    if (!t.ok) return { ok: false, error: "NotTrusted", args: [t.reason], message: explainRefusal("NotTrusted", []) };
    return null;
  }

  async function setAllowance(amount: bigint): Promise<void> {
    const { request } = await d.publicClient.simulateContract({
      address: usdg, abi: erc20Abi, functionName: "approve", args: [d.circle, amount], account: d.account,
    });
    const gas = withHeadroom(await d.publicClient.estimateContractGas({
      address: usdg, abi: erc20Abi, functionName: "approve", args: [d.circle, amount], account: d.account,
    }));
    const hash = await d.walletClient.writeContract({ ...request, gas, chain: d.walletClient.chain ?? null });
    const receipt = await d.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error("The approval transaction failed.");
  }

  /**
   * Sets the circle's allowance to exactly `amount` (never unlimited) unless it already is exactly that.
   * Returns the allowance it replaced, or null when nothing changed, so a failed action can put it back.
   */
  async function approveExact(amount: bigint): Promise<bigint | null> {
    const current = await d.publicClient.readContract({
      address: usdg, abi: erc20Abi, functionName: "allowance", args: [d.account, d.circle],
    });
    if (current === amount) return null;
    await setAllowance(amount);
    return current;
  }

  /** After a failed action, put the allowance back so no approval is left for USDG that never moved. */
  async function restore(
    failure: Extract<ActionResult, { ok: false }>,
    previous: bigint | null,
  ): Promise<Extract<ActionResult, { ok: false }>> {
    if (previous === null) return failure;
    try {
      await setAllowance(previous);
      return { ...failure, message: `${failure.message} Your USDG approval was set back, so nothing is left approved.` };
    } catch {
      return {
        ...failure,
        message: `${failure.message} An approval for this circle is still open in your wallet; approving 0 USDG for it clears it.`,
      };
    }
  }

  /** `pull` is how much USDG the action takes; it is read only after the trust check passes. */
  async function send(
    functionName: string,
    args: readonly unknown[],
    pullOf?: () => Promise<bigint> | bigint,
  ): Promise<ActionResult> {
    let previous: bigint | null = null;
    try {
      const refused = await guard();
      if (refused) return refused;
      const pull = pullOf ? await pullOf() : undefined;
      if (pull !== undefined) {
        // The contract checks the allowance last, so InsufficientAllowance here means every other check
        // passed; any other refusal stops before the wallet is asked to approve anything.
        await d.publicClient.simulateContract({
          address: d.circle, abi: othelloCircleAbi, functionName, args, account: d.account,
        } as never).catch((e: unknown) => {
          if (decodeFailure(e).error !== "InsufficientAllowance") throw e;
        });
        previous = await approveExact(pull);
      }
      const { request } = await d.publicClient.simulateContract({
        address: d.circle, abi: othelloCircleAbi, functionName, args, account: d.account,
      } as never);
      const gas = withHeadroom(await d.publicClient.estimateContractGas({
        address: d.circle, abi: othelloCircleAbi, functionName, args, account: d.account,
      } as never));
      const hash = await d.walletClient.writeContract({ ...(request as object), gas, chain: d.walletClient.chain ?? null } as never);
      const receipt = await d.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") {
        return restore({ ok: false, error: "Failed", args: [hash], message: "The transaction failed on chain." }, previous);
      }
      return { ok: true, txHash: hash };
    } catch (e) {
      return restore(decodeFailure(e), previous);
    }
  }

  const view = () => readCircle(d.publicClient, d.circle, usdg);

  return {
    id: `rh:${getAddress(d.circle)}`,
    chainId: ROBINHOOD_TESTNET_ID,
    profile: P,
    units: { decimals: USDG_DECIMALS, symbol: "USDG" },
    capabilities: { oracleCollateral: false, delinquencyMark: true, topUpConsentBound: true },
    trust: () => checkTrustedAgainst(d.publicClient, d.circle, d.factory),
    readCircle: () => view(),
    joinAndLock: checked(P, "joinAndLock", async ({ amount }: { amount: bigint }) =>
      send("joinAndLock", [amount], async () => amount + (await view()).g)),
    leaveForming: checked(P, "leaveForming", async () => send("leaveForming", [])),
    cancelCircle: checked(P, "cancelCircle", async () => send("cancelCircle", [])),
    activate: checked(P, "activate", async () => send("activate", [])),
    contribute: checked(P, "contribute", async () => send("contribute", [], async () => (await view()).c)),
    releasePot: checked(P, "releasePot", async () => send("releasePot", [])),
    updateCoverage: checked(P, "updateCoverage", async () => send("updateCoverage", [])),
    markDelinquent: checked(P, "markDelinquent", async ({ round, turn }: { round: number; turn: number }) =>
      send("markDelinquent", [round, turn])),
    declareDefault: checked(P, "declareDefault", async ({ turn }: { turn: number }) => send("declareDefault", [turn])),
    addStock: checked(P, "addStock", async ({ amount }: { amount: bigint }) => send("addStock", [amount], () => amount)),
    topUpReserve: checked(P, "topUpReserve", async ({ amount, expectedFill }: { amount: bigint; expectedFill: bigint }) =>
      send("topUpReserve", [amount, expectedFill], () => amount)),
    withdraw: checked(P, "withdraw", async () => send("withdraw", [])),
  };
}

export type { Hex };
