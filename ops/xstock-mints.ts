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
 * The binding that does hold is `productSlug`: Backed's own site, fetched over TLS at
 * a URL this repo builds from a reviewed slug rather than from anything the mint says,
 * with a pinned origin and redirects refused, stating
 * `data-network-address="<address>"` for Solana. Forging it requires compromising
 * backed.fi's TLS or DNS. That trust root is named, not implied: see OPEN-QUESTIONS.md.
 */
export type XStockMint = {
  symbol: string;
  name: string;
  address: string;
  /**
   * The slug of Backed's own product page. A slug, not a URL, so the origin cannot
   * be varied here: fetch-fixtures.ts builds
   * https://assets.backed.fi/products/<slug> itself and rejects redirects.
   */
  productSlug: string;
  source: string;
};

export const VERIFIED_XSTOCK_MINTS: XStockMint[] = [
  {
    symbol: "AAPLx",
    name: "Apple",
    address: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    productSlug: "apple-xstock",
    source: "SPEC.md 9b.1 (design session), bound by Backed's product page per SPEC 9b.6",
  },
  {
    symbol: "NFLXx",
    name: "Netflix",
    address: "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL",
    productSlug: "netflix-xstock",
    source: "SPEC.md 9b.1 (design session), bound by Backed's product page per SPEC 9b.6",
  },
  {
    symbol: "SPYx",
    name: "SP500",
    address: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    productSlug: "sp500-xstock",
    source: "SPEC.md 9b.1 (added 2026-09-21), bound by Backed's product page per SPEC 9b.6",
  },
  {
    symbol: "NVDAx",
    name: "NVIDIA",
    address: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    productSlug: "nvidia-xstock",
    source: "SPEC.md 9b.1 (added 2026-09-21), bound by Backed's product page per SPEC 9b.6",
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
