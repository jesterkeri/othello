/**
 * The Robinhood adapter as the app uses it. The trusted factory is bound here to TRUSTED_FACTORY from ./config;
 * nothing the app calls takes a factory argument, so no page can trust another factory by passing one.
 * Only this module may import ./config or ./adapter-core (CI job trust-config, ops/trust-config.ts).
 */
import type { PublicClient } from "viem";

import {
  checkTrustedAgainst,
  createRobinhoodAdapterWith,
  type RobinhoodAdapter,
  type RobinhoodDeps,
  type TrustResult,
} from "./adapter-core";
import { TRUSTED_FACTORY } from "./config";

export {
  STATUS,
  decodeFailure,
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
  return createRobinhoodAdapterWith({ ...d, factory: TRUSTED_FACTORY });
}
