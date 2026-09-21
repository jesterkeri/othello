/**
 * xStock mint allowlist (ADR-012).
 *
 * Collateral is identified by mint ADDRESS, never by symbol: Jupiter returns
 * five tokens named "NFLXx" and only one is real (SPEC 9b.3). Every entry here
 * carries the source that states the address, and every entry is verified
 * on-chain by ops/fetch-fixtures.ts before a fixture is written: the account
 * must be owned by Token-2022, carry ScaledUiAmountConfig, and its own
 * TokenMetadata extension must report the symbol claimed below. An address
 * never enters this list by being guessed or resolved from a ticker.
 */
export type XStockMint = {
  symbol: string;
  name: string;
  address: string;
  source: string;
};

export const VERIFIED_XSTOCK_MINTS: XStockMint[] = [
  {
    symbol: "AAPLx",
    name: "Apple",
    address: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    source: "SPEC.md 9b.1, verified live 2026-09-21",
  },
  {
    symbol: "NFLXx",
    name: "Netflix",
    address: "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL",
    source: "SPEC.md 9b.1, verified live 2026-09-21",
  },
  {
    symbol: "SPYx",
    name: "SP500",
    address: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    source: "https://assets.backed.fi/products/sp500-xstock (Backed's own product page, data-network-address), read 2026-09-21",
  },
  {
    symbol: "NVDAx",
    name: "NVIDIA",
    address: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    source: "https://assets.backed.fi/products/nvidia-xstock (Backed's own product page, data-network-address), read 2026-09-21",
  },
];

/** Empty once every mint T00 names has a verified address. */
export const MINTS_AWAITING_ADDRESS: readonly string[] = [];
