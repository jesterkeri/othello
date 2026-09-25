/**
 * The buyable xStocks the app lists (Joshua, 2026-09-25: "only add things that are tradable",
 * meaning a user can buy them in the app and hold them).
 *
 * Provenance, 2026-09-25 (mainnet slot 450,320,479):
 * 1. Candidates: every token Jupiter's search lists whose mint authority is Backed's xStock
 *    authority 7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj (222).
 * 2. Each read from mainnet itself: Token-2022, that mint authority, ScaledUiAmountConfig (222/222).
 * 3. Kept only if tradable now: a Jupiter price, traded in the last 24 h, at least $1,000 of
 *    liquidity, and not paused on-chain (22).
 * 4. Buyable: each returned a live Jupiter route for 50 USDC in (22/22).
 * Names are the mint's own TokenMetadata name without " xStock". Addresses, never names,
 * identify them (ADR-012). Collateral is a separate, smaller list: REAL_XSTOCKS in devnet.ts,
 * the program's allowlist; tests/app-xstocks.spec.ts asserts those four are in this list.
 *
 * No "@/" imports: the test runs it from the repo root.
 */
export type XStock = { symbol: string; name: string; address: string };

export const TRADABLE_XSTOCKS: readonly XStock[] = [
  { symbol: "SPYx", name: "SP500", address: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W" },
  { symbol: "NVDAx", name: "NVIDIA", address: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh" },
  { symbol: "CRCLx", name: "Circle", address: "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1" },
  { symbol: "QQQx", name: "Nasdaq", address: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ" },
  { symbol: "SPCXx", name: "SpaceX", address: "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8" },
  { symbol: "TSLAx", name: "Tesla", address: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB" },
  { symbol: "GLDx", name: "Gold", address: "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re" },
  { symbol: "COINx", name: "Coinbase", address: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu" },
  { symbol: "HOODx", name: "Robinhood", address: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg" },
  { symbol: "MSTRx", name: "MicroStrategy", address: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ" },
  { symbol: "METAx", name: "Meta", address: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu" },
  { symbol: "GMEx", name: "Gamestop", address: "Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc" },
  { symbol: "MSFTx", name: "Microsoft", address: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX" },
  { symbol: "AAPLx", name: "Apple", address: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp" },
  { symbol: "GOOGLx", name: "Alphabet", address: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN" },
  { symbol: "MCDx", name: "McDonald's", address: "XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2" },
  { symbol: "PLTRx", name: "Palantir", address: "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4" },
  { symbol: "AMZNx", name: "Amazon.com", address: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg" },
  { symbol: "STRCx", name: "Strategy PP Variable", address: "Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH" },
  { symbol: "INTCx", name: "Intel", address: "XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM" },
  { symbol: "XOMx", name: "Exxon Mobil", address: "XsaHND8sHyfMfsWPj6kSdd5VwvCayZvjYgKmmcNL5qh" },
  { symbol: "NFLXx", name: "Netflix", address: "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL" },
];
