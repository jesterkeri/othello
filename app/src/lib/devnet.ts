/**
 * The live deployment the app reads. Public addresses only.
 *
 * Every value here is copied from a record the deploy produced, and
 * tests/app-devnet-constants.spec.ts asserts they still match:
 *   ops/demo-circle.json   the program, the demo circle, its members and mints (T24)
 *   ops/devnet-mints.json  the stand-in mints and their labels (S2)
 *   programs/othello/src/allowlist.rs   the four real xStocks (ADR-012)
 *
 * No "@/" imports: the test runs it from the repo root.
 */

export const CLUSTER = "devnet";
export const PROGRAM_ID = "DhZhSvtTh78ZK26MkVVpyeDYr4MuyTZSVrT5YEFqqrDT";

export const DEMO_CIRCLE = "8uGgNmog9gbwDMFMB2EKHXBSQ43YcUaB8eAPhgGsXT3Q";

/**
 * Display names for the demo circle's five seats, in turn order: the same cast the design
 * fixtures use (fixtures/circles.ts), so every screen tells one story. The chain stores only
 * addresses; these are labels, and a connected member's own seat still shows "You".
 */
export const DEMO_NAMES = ["Ada", "Tunde", "Kemi", "Chidi", "Nneka"] as const;

export const NFLXX_MIRROR = "CymeZqJiKk2Nd4FkDvHduyrq3k3XbJELtifAbPqfdSuA";
export const TEST_USDC = "HuNtRYjwPgqKANveLm5vRj9DveBnQAq4cFzWTEf4DoBV";

/** What each stand-in is, in the words it must always be shown with (S2, Joshua). */
export const LABELS = {
  nflxxMirror: "NFLXx devnet mirror (not the real NFLXx)",
  testUsdc: "Othello test USDC (devnet only, not real USDC)",
} as const;

/** The four real xStocks, mainnet, SPEC §9b.1 and allowlist.rs. Addresses, never symbols, identify them. */
export const REAL_XSTOCKS = [
  { symbol: "AAPLx", name: "Apple", address: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp" },
  { symbol: "NFLXx", name: "Netflix", address: "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL" },
  { symbol: "SPYx", name: "S&P 500", address: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W" },
  { symbol: "NVDAx", name: "NVIDIA", address: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh" },
] as const;

export function explorer(kind: "address" | "tx", id: string, cluster: "devnet" | "mainnet" = "devnet"): string {
  const q = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/${kind}/${id}${q}`;
}
