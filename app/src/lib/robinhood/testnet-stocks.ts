/**
 * Robinhood's Stock Tokens on Robinhood Chain testnet: the five that Robinhood's testnet faucet
 * (https://faucet.testnet.chain.robinhood.com, "0.01 testnet ETH and five of each Stock Token", once every 24 hours)
 * sends. Checked 2026-10-04 on the chain and its explorer: each is a verified ERC-20 with 18 decimals, all five created
 * by the same account (0x2DD5b0Ea7c29006bA9450B9a4f3ADc234409e5Da), each held by over 220,000 testnet wallets.
 * Other tokens on testnet with the same tickers (for example "TSLA Test Stock") are not these and are not listed.
 *
 * Test tokens with no value. Othello's testnet circles are paid and locked in USDG; these are shown so a person can
 * see what they hold, not used by circles. The release gate pins this exact set (ops/trust-config.ts).
 */
export const TESTNET_STOCK_TOKENS = [
  { symbol: "TSLA", name: "Tesla", address: "0xC9f9c86933092BbbfFF3CCb4b105A4A94bf3Bd4E" },
  { symbol: "AMZN", name: "Amazon", address: "0x5884aD2f920c162CFBbACc88C9C51AA75eC09E02" },
  { symbol: "PLTR", name: "Palantir Technologies", address: "0x1FBE1a0e43594b3455993B5dE5Fd0A7A266298d0" },
  { symbol: "NFLX", name: "Netflix", address: "0x3b8262A63d25f0477c4DDE23F83cfe22Cb768C93" },
  { symbol: "AMD", name: "AMD", address: "0x71178BAc73cBeb415514eB542a8995b82669778d" },
] as const;
export const TESTNET_STOCK_DECIMALS = 18;
export const TESTNET_FAUCET = "https://faucet.testnet.chain.robinhood.com";
