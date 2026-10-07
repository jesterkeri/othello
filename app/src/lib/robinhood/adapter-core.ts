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
  decodeEventLog,
  erc20Abi,
  getAddress,
  isAddressEqual,
  keccak256,
  type Address,
  type Hex,
  parseEventLogs,
  type PublicClient,
  type TransactionReceipt,
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
  /** The block every field was read at (its number); the page never replaces a view with one from an earlier block. */
  block: number;
  /** The chain's latest block time at this read. Time-based buttons follow the chain, not the device clock. */
  chainTime: number;
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
  client: Pick<PublicClient, "readContract" | "getBlock">,
  circle: Address,
  usdg: Address = USDG,
): Promise<RhCircleView> {
  // One block for everything: its timestamp is the page's chain time, and every read is pinned to its HASH (EIP-1898,
  // requireCanonical), so a deadline and a paid bitmap are never paired with another block's time or state. Adversary
  // passes on 885ecc6 (state and time read at different blocks), c5d7863 (a reorg between getBlock and reads pinned by
  // number) and 0908465 (a reorg undone mid-read). A failed read starts over one block further back, then two: a
  // reorged block is left behind, and a load-balanced RPC whose call node has not yet seen the newest block ("header
  // not found", adversary on 9343ef9) still answers. Robinhood Chain makes several blocks a second.
  let last: unknown;
  for (let back = 0n; back < 3n; back++) {
    // a retry waits first: the public RPC answers a burst with 429 or a short batch, and an instant retry meets the
    // same limit (Joshua's preview, 2026-10-07)
    if (back > 0n) await new Promise((r) => setTimeout(r, 400 * Number(back)));
    try {
      const head = await client.getBlock({ blockTag: "latest" });
      if (head.number === null) throw new Error("Robinhood Chain returned a block without a number.");
      const block = back === 0n ? head : await client.getBlock({ blockNumber: head.number - back });
      if (block.hash === null) throw new Error("Robinhood Chain returned a block without a hash.");
      return await readCircleAt(client, circle, usdg, block.hash, Number(block.timestamp), Number(block.number));
    } catch (e) {
      last = e;
    }
  }
  throw new Error("Robinhood Chain did not answer the circle read.", { cause: last });
}

/**
 * readCircle, one at a time across the page. Each read is about 40 calls in one batch, and the public Robinhood
 * testnet RPC rate-limits: two circles read together (about 66 calls) came back 429 "Too Many Requests" or with a
 * short batch, so every circle on the list failed (Joshua's preview, 2026-10-07: "Couldn't read circle ..." for both
 * of a wallet's circles, each of which reads fine alone). Lists read their circles through this queue.
 */
let readQueue: Promise<unknown> = Promise.resolve();
export function readCircleInTurn(
  client: Pick<PublicClient, "readContract" | "getBlock">,
  circle: Address,
  usdg: Address = USDG,
): Promise<RhCircleView> {
  const next = () => readCircle(client, circle, usdg);
  const run = readQueue.then(next, next);
  readQueue = run.catch(() => undefined);
  return run;
}

async function readCircleAt(
  client: Pick<PublicClient, "readContract">,
  circle: Address,
  usdg: Address,
  blockHash: `0x${string}`,
  chainTime: number,
  block: number,
): Promise<RhCircleView> {
  const at = { blockHash, requireCanonical: true };
  const r = <T,>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: circle, abi: othelloCircleAbi, functionName, args, ...at } as never) as Promise<T>;
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
    client.readContract({ address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [circle], ...at }),
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
    chainTime,
    block,
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

/**
 * Waits for `hash`. A wallet can replace a pending transaction; viem then returns the replacement's receipt and says
 * why: "repriced" (a speed-up: same destination, data and value, only the fee changed, so it IS this action),
 * "cancelled" or "replaced" (a different transaction: this action did not run). Returns the receipt and whether it is
 * this action.
 */
export async function waitForOwnReceipt(client: Pick<PublicClient, "waitForTransactionReceipt">, hash: Hex) {
  let reason: "repriced" | "cancelled" | "replaced" | undefined;
  const receipt = await client.waitForTransactionReceipt({ hash, onReplaced: (r) => { reason = r.reason; } });
  const sameAction = receipt.transactionHash === hash || reason === "repriced";
  return { receipt, sameAction };
}

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
    if (err.walk((x) => (x as Error)?.name === "WaitForTransactionReceiptTimeoutError") ||
        /Timed out while waiting for transaction/.test(err.message)) {
      return { ok: false, error: "Timeout", args: [], message: "Robinhood Chain did not confirm in time. The transaction may still go through: check the explorer before trying again, so you don't pay twice." };
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
  /**
   * Told the hash once the wallet has sent an action's transaction, before its receipt: lets a screen show "waiting for
   * the wallet" and "pending on chain" apart. A view callback only; a throw in it is ignored and changes nothing.
   */
  onSent?: (hash: `0x${string}`) => void;
};

/** What a release paid, from the PotReleased event in its own receipt: the round and seat that receipt names. */
export type Released = { round: number; recipient: Address; pot: bigint };
/**
 * releasePot's result. The contract pays whichever round is current when the transaction lands (releasePot takes no
 * round), so after a race with another member it may be the next one; `released` says which, from the receipt the
 * adapter waited for, never from a second lookup (Codex r2 on PR #22). Absent only if the receipt has no such event.
 */
export type ReleaseResult = Extract<ActionResult, { ok: false }> | (Extract<ActionResult, { ok: true }> & { released?: Released });

export type RobinhoodAdapter = Omit<EvmUsdgAdapter<RhCircleView>, "releasePot"> & {
  trust(): Promise<TrustResult>;
  releasePot(a: Record<string, never>): Promise<ReleaseResult>;
};

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

  async function setAllowance(amount: bigint, memo?: { pending: boolean }): Promise<void> {
    const { request } = await d.publicClient.simulateContract({
      address: usdg, abi: erc20Abi, functionName: "approve", args: [d.circle, amount], account: d.account,
    });
    const gas = withHeadroom(await d.publicClient.estimateContractGas({
      address: usdg, abi: erc20Abi, functionName: "approve", args: [d.circle, amount], account: d.account,
    }));
    const hash = await d.walletClient.writeContract({ ...request, gas, chain: d.walletClient.chain ?? null });
    if (memo) memo.pending = true; // sent: from here its outcome is unknown until the receipt says otherwise
    const { receipt, sameAction } = await waitForOwnReceipt(d.publicClient, hash);
    if (memo) memo.pending = false;
    // A wallet "cancel" replaces the approval with something else; a "speed up" (repriced) is still this approval.
    if (!sameAction) throw new Error("The approval was replaced or cancelled in your wallet.");
    if (receipt.status !== "success") throw new Error("The approval transaction failed.");
  }

  const readAllowance = () =>
    d.publicClient.readContract({ address: usdg, abi: erc20Abi, functionName: "allowance", args: [d.account, d.circle] });

  /**
   * Sets the circle's allowance to exactly `amount` (never unlimited) unless it already is exactly that.
   * `memo.previous` is recorded BEFORE the approval is sent, so a failure at any later point (a timeout while it
   * confirms, a replaced transaction) can still put the allowance back.
   */
  async function approveExact(amount: bigint, memo: { previous: bigint | null; pending: boolean }): Promise<void> {
    const current = await readAllowance();
    if (current === amount) return;
    memo.previous = current;
    await setAllowance(amount, memo);
  }

  /** After a failed action, put the allowance back so no approval is left for USDG that never moved. */
  async function restore(
    failure: Extract<ActionResult, { ok: false }>,
    memo: { previous: bigint | null; pending: boolean },
  ): Promise<Extract<ActionResult, { ok: false }>> {
    const previous = memo.previous;
    if (previous === null) return failure;
    try {
      // Nothing to put back if the approval never took effect. But an approval that was SENT and not yet
      // confirmed may still land: then the reset is sent anyway, and the account's nonce order puts it after.
      if (!memo.pending && (await readAllowance()) === previous) return failure;
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
    onReceipt?: (receipt: TransactionReceipt) => void,
  ): Promise<ActionResult> {
    const memo: { previous: bigint | null; pending: boolean } = { previous: null, pending: false };
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
        await approveExact(pull, memo);
      }
      const { request } = await d.publicClient.simulateContract({
        address: d.circle, abi: othelloCircleAbi, functionName, args, account: d.account,
      } as never);
      const gas = withHeadroom(await d.publicClient.estimateContractGas({
        address: d.circle, abi: othelloCircleAbi, functionName, args, account: d.account,
      } as never));
      const hash = await d.walletClient.writeContract({ ...(request as object), gas, chain: d.walletClient.chain ?? null } as never);
      try { d.onSent?.(hash); } catch { /* a view callback cannot affect the action */ }
      const { receipt, sameAction } = await waitForOwnReceipt(d.publicClient, hash);
      if (!sameAction) {
        // Cancelled or replaced in the wallet: the action did not run, whatever the replacement's status.
        return restore({ ok: false, error: "Replaced", args: [hash, receipt.transactionHash],
          message: "The transaction was cancelled or replaced in your wallet, so it did not run." }, memo);
      }
      if (receipt.status !== "success") {
        return restore({ ok: false, error: "Failed", args: [hash], message: "The transaction failed on chain." }, memo);
      }
      // reading the receipt can only add detail: a throw here must not turn a confirmed success into a failure
      try { onReceipt?.(receipt); } catch { /* the result stands without the detail */ }
      return { ok: true, txHash: receipt.transactionHash };
    } catch (e) {
      return restore(decodeFailure(e), memo);
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
    releasePot: checked(P, "releasePot", async (): Promise<ReleaseResult> => {
      let released: Released | undefined;
      const result = await send("releasePot", [], undefined, (receipt) => {
        const ev = parseEventLogs({
          abi: othelloCircleAbi, eventName: "PotReleased", logs: receipt.logs.filter((l) => isAddressEqual(l.address, d.circle)),
        })[0];
        if (ev) released = { round: Number(ev.args.round), recipient: getAddress(ev.args.recipient), pot: ev.args.pot };
      });
      return result.ok && released ? { ...result, released } : result;
    }),
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

// ---------------------------------------------------------------------------------------------------------------
// Creating and finding circles (factory side). Same rules as the circle actions: chain 46630 on both clients, the
// factory's runtime code hash must equal the pinned one, a simulation first (refusals come back decoded), gas
// headroom, and a receipt only counts if it is the transaction sent.

export type CircleParams = {
  n: bigint;
  c: bigint;
  g: bigint;
  minStockCover: bigint;
  haircutBps: bigint;
  coverageBps: bigint;
  warnBps: bigint;
  roundSecs: bigint;
  graceSecs: bigint;
};

/** The factory's own peak-guarantee rule (CircleMath.peakNeed): max over k of k x max(0, ceil(c(n-k)cov/1e4) - min). */
export function peakNeed(p: Pick<CircleParams, "n" | "c" | "coverageBps" | "minStockCover">): bigint {
  let best = 0n;
  for (let k = 1n; k < p.n; k++) {
    const o = p.c * (p.n - k) * p.coverageBps;
    const required = o === 0n ? 0n : (o - 1n) / 10_000n + 1n;
    const per = required > p.minStockCover ? required - p.minStockCover : 0n;
    if (k * per > best) best = k * per;
  }
  return best;
}

/** The least guarantee per member the factory accepts for these parameters: ceil(peak / n), at least 1 base unit. */
export const leastGuarantee = (p: Pick<CircleParams, "n" | "c" | "coverageBps" | "minStockCover">) => {
  const peak = peakNeed(p);
  const g = peak === 0n ? 1n : (peak - 1n) / p.n + 1n;
  return g < 1n ? 1n : g;
};

export async function checkTrustedFactory(
  client: Pick<PublicClient, "getCode">,
  factory: TrustedFactory | null,
): Promise<TrustResult> {
  if (!factory) return { ok: false, reason: "not-deployed" };
  const fcode = await client.getCode({ address: factory.address });
  if (!fcode || fcode === "0x" || keccak256(fcode) !== factory.codeHash.toLowerCase()) return { ok: false, reason: "factory-code" };
  return { ok: true };
}

export type CreateResult = { ok: true; txHash: string; circle: Address } | Extract<ActionResult, { ok: false }>;

export async function createCircleWith(
  d: { publicClient: PublicClient; walletClient: WalletClient; account: Address; factory: TrustedFactory | null },
  params: CircleParams,
  members: readonly Address[],
): Promise<CreateResult> {
  try {
    const [readChain, walletChain] = await Promise.all([d.publicClient.getChainId(), d.walletClient.getChainId()]);
    if (readChain !== ROBINHOOD_TESTNET_ID || walletChain !== ROBINHOOD_TESTNET_ID) {
      return { ok: false, error: "WrongNetwork", args: [walletChain], message: explainRefusal("WrongNetwork", []) };
    }
    const t = await checkTrustedFactory(d.publicClient, d.factory);
    if (!t.ok || !d.factory) return { ok: false, error: "NotTrusted", args: [t.ok ? "not-deployed" : t.reason], message: "Robinhood circles aren't open yet." };
    const call = {
      address: d.factory.address, abi: othelloFactoryAbi, functionName: "createCircle", args: [params, members], account: d.account,
    } as const;
    const { request } = await d.publicClient.simulateContract(call as never);
    const gas = withHeadroom(await d.publicClient.estimateContractGas(call as never));
    const hash = await d.walletClient.writeContract({ ...(request as object), gas, chain: d.walletClient.chain ?? null } as never);
    const { receipt, sameAction } = await waitForOwnReceipt(d.publicClient, hash);
    if (!sameAction) {
      return { ok: false, error: "Replaced", args: [hash], message: "The transaction was cancelled or replaced in your wallet, so no circle was created." };
    }
    if (receipt.status !== "success") return { ok: false, error: "Failed", args: [hash], message: "The transaction failed on chain." };
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== d.factory.address.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: othelloFactoryAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "CircleCreated") return { ok: true, txHash: receipt.transactionHash, circle: getAddress(ev.args.circle) };
      } catch {
        // not this event
      }
    }
    return { ok: false, error: "Failed", args: [hash], message: "The circle was created but its address was not in the receipt; find it under My circles." };
  } catch (e) {
    return decodeFailure(e);
  }
}

export type CircleSummary = { address: Address; n: number; c: bigint; status: Status; round: number; creator: Address; turn: number };
/** One page of a wallet's circles. `before` is where the next (older) page ends, or null when there is none. */
export type CirclePage = { circles: CircleSummary[]; total: number; before: number | null };
export const MY_CIRCLES_PAGE = 10;

async function summarize(client: Pick<PublicClient, "readContract">, addr: Address, account: Address): Promise<CircleSummary | null> {
  const r = <T,>(functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: addr, abi: othelloCircleAbi, functionName, args } as never) as Promise<T>;
  const [n, c, status, round, creator] = await Promise.all([
    r<bigint>("n"), r<bigint>("c"), r<number>("status"), r<number>("round"), r<Address>("creator"),
  ]);
  const members = await Promise.all(Array.from({ length: Number(n) }, (_, k) => r<Address>("members", [BigInt(k)])));
  const turn = members.findIndex((m) => isAddressEqual(m, account));
  return turn >= 0 ? { address: getAddress(addr), n: Number(n), c, status: STATUS[status] ?? "Forming", round, creator, turn } : null;
}

/**
 * One page of the circles `account` created or joined, newest first, from the trusted factory's own index
 * (ARB r10: only the account's own createCircle or joinAndLock adds to it, so nobody else can bury its circles).
 * `before` is the previous page's `before` (an absolute index into the append-only index, so a join between pages
 * neither repeats nor skips an entry). The reads are bounded by `pageSize`, never by how many circles the chain has.
 */
export async function listCirclesPageWith(
  client: Pick<PublicClient, "readContract" | "getCode">,
  factory: TrustedFactory | null,
  account: Address,
  before?: number,
  pageSize = MY_CIRCLES_PAGE,
): Promise<CirclePage> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new RangeError("pageSize must be 1 to 50");
  if (before !== undefined && (!Number.isInteger(before) || before < 0)) throw new RangeError("before must be a whole number");
  // no factory yet: nothing to list. A factory whose code no longer matches its pin is a failed read, never an
  // empty list (adversary on c2b6549: the portfolio told a wallet with circles it had none)
  if (!factory) return { circles: [], total: 0, before: null };
  const t = await checkTrustedFactory(client, factory);
  if (!t.ok) throw new Error("Othello's factory on Robinhood Chain testnet could not be verified.");
  const total = Number(await client.readContract({
    address: factory.address, abi: othelloFactoryAbi, functionName: "circlesOfCount", args: [account],
  }));
  const end = before === undefined ? total : Math.min(before, total);
  const start = Math.max(0, end - pageSize);
  if (end <= start) return { circles: [], total, before: null };
  const addrs = (await client.readContract({
    address: factory.address, abi: othelloFactoryAbi, functionName: "circlesOfPage", args: [account, BigInt(start), BigInt(end - start)],
  })) as readonly Address[];
  const out: CircleSummary[] = [];
  for (const x of await Promise.all([...addrs].reverse().map((a) => summarize(client, a, account)))) if (x) out.push(x);
  return { circles: out, total, before: start > 0 ? start : null };
}
