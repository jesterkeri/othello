/**
 * A base58 Solana address, or null. One check for every place a circle address arrives from a URL or a query: the
 * pages (/circle/sol:<address>), the route rules (lib/side-rules.ts) and the read routes (/api/circle, /api/circles),
 * so a page never renders for an id the rules call a 404, or the reverse.
 */
import { PublicKey } from "@solana/web3.js";

export function parseAddress(raw: string | null | undefined): string | null {
  if (!raw || raw.length < 32 || raw.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(raw)) return null;
  try {
    return new PublicKey(raw).toBase58() === raw ? raw : null;
  } catch {
    return null;
  }
}
