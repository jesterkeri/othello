/**
 * ARB-DESIGN r9 section 7.1 "adapter split (r8)", type level. Checked by `tsc --noEmit` (root tsconfig).
 * Each @ts-expect-error must stay an error: if a change makes one of these calls type-check, tsc fails
 * with "Unused '@ts-expect-error' directive".
 */
import type { ChainAdapter, EvmUsdgAdapter, SolanaAdapter, TopUpAdapter } from "../app/src/lib/core/adapter.ts";

declare const common: ChainAdapter;
declare const evm: EvmUsdgAdapter;
declare const sol: SolanaAdapter;
declare const any: TopUpAdapter;

// @ts-expect-error the common surface has no top-up
void common.topUpReserve;

// @ts-expect-error Solana's top-up takes {amount} only
void sol.topUpReserve({ amount: 1n, expectedFill: 0n });

// @ts-expect-error the EVM top-up needs the fill the page displayed
void evm.topUpReserve({ amount: 1n });

// allowed
void evm.topUpReserve({ amount: 1n, expectedFill: 0n });
void sol.topUpReserve({ amount: 1n });

// A top-up screen must narrow by profile before it can call either shape.
if (any.profile === "evm-usdg-v1") {
  void any.topUpReserve({ amount: 1n, expectedFill: 0n });
} else {
  void any.topUpReserve({ amount: 1n });
}
