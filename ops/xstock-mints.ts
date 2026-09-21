/**
 * xStock mint allowlist (ADR-012).
 *
 * Collateral is identified by mint ADDRESS, never by symbol: Jupiter returns five
 * tokens named "NFLXx" and only one is real (SPEC 9b.3).
 *
 * WHERE THE TRUST ACTUALLY COMES FROM, stated plainly because an earlier version of
 * this file claimed more than it delivered. A mint's own TokenMetadata symbol, its
 * embedded mint pubkey, its scaled-UI authority and its metadata update authority are
 * ALL copyable: Token-2022 takes the scaled-UI authority and the metadata update
 * authority as non-signer instruction data, so a counterfeit mint can carry Backed's
 * public keys without possessing them, and the metadata URI is an attacker-chosen
 * string. None of those establish issuer identity. They are retained only as
 * integrity and drift checks.
 *
 * The binding that does hold is `productPage`: Backed's own site, fetched over TLS at
 * a URL derived from the symbol here rather than from anything the mint says, stating
 * `data-network-address="<address>"` for Solana. Forging it requires compromising
 * backed.fi's TLS or DNS. That trust root is named, not implied: see OPEN-QUESTIONS.md.
 */
export type XStockMint = {
  symbol: string;
  name: string;
  address: string;
  /** Backed's own product page, the TLS-authenticated symbol-to-address binding. */
  productPage: string;
  source: string;
};

export const VERIFIED_XSTOCK_MINTS: XStockMint[] = [
  {
    symbol: "AAPLx",
    name: "Apple",
    address: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    productPage: "https://assets.backed.fi/products/apple-xstock",
    source: "SPEC.md 9b.1 (design session), corroborated by Backed's product page",
  },
  {
    symbol: "NFLXx",
    name: "Netflix",
    address: "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL",
    productPage: "https://assets.backed.fi/products/netflix-xstock",
    source: "SPEC.md 9b.1 (design session), corroborated by Backed's product page",
  },
  {
    symbol: "SPYx",
    name: "SP500",
    address: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    productPage: "https://assets.backed.fi/products/sp500-xstock",
    source: "Backed's product page only; NOT in SPEC 9b.1. See OPEN-QUESTIONS.md",
  },
  {
    symbol: "NVDAx",
    name: "NVIDIA",
    address: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    productPage: "https://assets.backed.fi/products/nvidia-xstock",
    source: "Backed's product page only; NOT in SPEC 9b.1. See OPEN-QUESTIONS.md",
  },
];

/**
 * The symbols T00 requires a fixture for. This is the requirement itself, not a
 * description of the list above: fetch-fixtures.ts checks the fixtures it wrote
 * against this, so deleting an entry from VERIFIED_XSTOCK_MINTS fails the task
 * instead of quietly producing three fixtures and exiting 0.
 */
export const REQUIRED_FIXTURE_SYMBOLS = ["AAPLx", "NFLXx", "SPYx", "NVDAx"] as const;

/** Empty once every mint T00 names has a verified address. */
export const MINTS_AWAITING_ADDRESS: readonly string[] = [];
