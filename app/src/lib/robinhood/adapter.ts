/**
 * The Robinhood adapter as the app uses it. The trusted factory is bound here to TRUSTED_FACTORY from ./config;
 * nothing the app calls takes a factory argument, so no page can trust another factory by passing one.
 * Only this module may import ./config or ./adapter-core (CI job trust-config, ops/trust-config.ts).
 */
import type { Address, PublicClient, WalletClient } from "viem";

import {
  checkTrustedAgainst,
  checkTrustedFactory,
  createCircleWith,
  createRobinhoodAdapterWith,
  listCirclesPageWith,
  type CircleParams,
  type CirclePage,
  type CircleSummary,
  type CreateResult,
  type RobinhoodAdapter,
  type RobinhoodDeps,
  type TrustResult,
} from "./adapter-core";
import { TRUSTED_FACTORY } from "./config";

export {
  MY_CIRCLES_PAGE,
  STATUS,
  decodeFailure,
  leastGuarantee,
  peakNeed,
  type CircleParams,
  type CirclePage,
  type CircleSummary,
  type CreateResult,
  readCircle,
  topUpFill,
  withHeadroom,
  type RhCircleView,
  type RhSeat,
  type RobinhoodAdapter,
  type Status,
  type TrustResult,
} from "./adapter-core";

/** The factory the app trusts (null until the reviewed deployment), for display only. */
export const trustedFactory = TRUSTED_FACTORY;

/** The four ordered trust checks against the one trusted factory. */
export function checkTrusted(client: Pick<PublicClient, "getCode" | "readContract">, circle: `0x${string}`): Promise<TrustResult> {
  return checkTrustedAgainst(client, circle, TRUSTED_FACTORY);
}

/** An evm-usdg-v1 adapter bound to the one trusted factory and the real USDG. */
export function createRobinhoodAdapter(d: Omit<RobinhoodDeps, "factory" | "usdg">): RobinhoodAdapter {
  // Fields picked one by one: an object with extra `factory` or `usdg` properties (allowed by TypeScript when it
  // is not a literal) cannot override the trusted factory or the real USDG.
  return createRobinhoodAdapterWith({
    publicClient: d.publicClient,
    walletClient: d.walletClient,
    account: d.account,
    circle: d.circle,
    onSent: d.onSent,
    factory: TRUSTED_FACTORY,
  });
}

/** Whether the one trusted factory is deployed with its pinned code (null config: not deployed). */
export function checkFactory(client: Pick<PublicClient, "getCode">): Promise<TrustResult> {
  return checkTrustedFactory(client, TRUSTED_FACTORY);
}

/** Creates a circle on the one trusted factory; the caller becomes its creator and must be one of `members`. */
export function createCircle(
  d: { publicClient: PublicClient; walletClient: WalletClient; account: Address },
  params: CircleParams,
  members: readonly Address[],
): Promise<CreateResult> {
  return createCircleWith(
    { publicClient: d.publicClient, walletClient: d.walletClient, account: d.account, factory: TRUSTED_FACTORY },
    params,
    members,
  );
}

/** One page (newest first) of the circles of the one trusted factory that `account` created or joined. */
export function listMyCircles(
  client: Pick<PublicClient, "readContract" | "getCode">,
  account: Address,
  before?: number,
): Promise<CirclePage> {
  return listCirclesPageWith(client, TRUSTED_FACTORY, account, before);
}
