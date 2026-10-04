/**
 * The official factory the app trusts (ARB-DESIGN r9 section A and 9.1). Empty until Joshua deploys the
 * reviewed commit; then a config-only commit fills it in, CI job `trust-config` checks it against the
 * broadcast receipt and the chain, and Codex review 3 approves it. While empty, every Robinhood circle
 * page shows "not deployed yet" and offers no action.
 *
 * Fixed shape, checked by CI (ops/trust-config.ts): this file may hold only the type import, the type below and
 * this one export, whose value is either `null` or `Object.freeze({ address: "0x…", codeHash: "0x…" })` with two
 * plain string literals. Only ./adapter imports it.
 */
import type { Address, Hex } from "viem";

export type TrustedFactory = { address: Address; codeHash: Hex };

export const TRUSTED_FACTORY: TrustedFactory | null = Object.freeze({
  address: "0x7Fc4f743a620F282EE02D83c5bDc0186c7d935D5",
  codeHash: "0xd1c2e7bdc2288ded409ca2c870b6aab888dcea607bc8f573b928f38bb6a472f1",
});
