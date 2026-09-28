/** Robinhood Chain testnet (ARB-DESIGN r9 section 0.3). Checked 2026-09-28: `cast chain-id` = 46630; explorer answers. */
import { defineChain } from "viem";

export const ROBINHOOD_TESTNET_ID = 46630;

export const robinhoodTestnet = defineChain({
  id: ROBINHOOD_TESTNET_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com" } },
  testnet: true,
});

/** Paxos USDG on Robinhood Chain testnet: 6 decimals, EIP-1967 proxy (issuer-upgradeable and freezable, AL2). */
export const USDG = "0x7E955252E15c84f5768B83c41a71F9eba181802F" as const;
export const USDG_DECIMALS = 6;

export const explorerTx = (hash: string) => `${robinhoodTestnet.blockExplorers.default.url}/tx/${hash}`;
export const explorerAddress = (a: string) => `${robinhoodTestnet.blockExplorers.default.url}/address/${a}`;
