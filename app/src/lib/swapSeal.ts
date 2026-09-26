/**
 * B1 (Codex fresh review of 1d2d579, MAJOR): the relay must send only the exact transaction /api/swap
 * built, not any buyer-signed Jupiter route that happens to pass the account checks. /api/swap seals the
 * message it approved; /api/swap/send recomputes the message from the signed transaction (signing fills
 * the signature slots and never changes the message) and relays only if the seal matches and has not
 * expired. Stateless: a keyed HMAC, no store. Replay is bounded by the chain itself (one signature lands
 * once) and by the seal's expiry.
 *
 * Server-only. The key is SWAP_BINDING_SECRET (set by Joshua in the deployment environment; never in the
 * repo, the browser or a log). Without it, Buy refuses to build or relay: no unsealed fallback.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** How long a built swap may wait for the buyer's signature before the relay refuses it. */
export const SEAL_TTL_SECONDS = 120;
const VERSION = "v1";
const MIN_SECRET_LENGTH = 32;

export type SealFacts = { message: Uint8Array; buyer: string; symbol: string };

function secret(): string | null {
  const s = process.env.SWAP_BINDING_SECRET;
  // Characters (code points), not UTF-16 units: an emoji must not count twice (B1 seal adversary).
  return typeof s === "string" && [...s].length >= MIN_SECRET_LENGTH ? s : null;
}

/** True when the binding key is configured; the Buy routes refuse to run without it. */
export function sealConfigured(): boolean {
  return secret() !== null;
}

function mac(key: string, facts: SealFacts, expiresAt: number): Buffer {
  const messageHash = createHash("sha256").update(facts.message).digest("hex");
  return createHmac("sha256", key).update([VERSION, facts.buyer, facts.symbol, String(expiresAt), messageHash].join("|")).digest();
}

/** A seal over the exact message, buyer and listed symbol, valid for SEAL_TTL_SECONDS from `nowSeconds`. */
export function sealSwap(facts: SealFacts, nowSeconds: number): string | null {
  const key = secret();
  if (!key) return null;
  const expiresAt = nowSeconds + SEAL_TTL_SECONDS;
  return `${VERSION}.${expiresAt}.${mac(key, facts, expiresAt).toString("base64url")}`;
}

/** True only for an unexpired seal this server made over these exact facts. */
export function verifySeal(seal: unknown, facts: SealFacts, nowSeconds: number): boolean {
  const key = secret();
  if (!key || typeof seal !== "string") return false;
  // One exact spelling: v1.<expiry, no leading zero>.<43-char unpadded base64url HMAC-SHA256>. Anything
  // else (padding, "+/", whitespace, leading zeros) is refused rather than normalised.
  const m = /^v1\.([1-9]\d{0,11})\.([A-Za-z0-9_-]{43})$/.exec(seal);
  if (!m) return false;
  const parts = [VERSION, m[1]!, m[2]!];
  const expiresAt = Number(parts[1]);
  // Refuse expired seals, and seals claiming more lifetime than this server ever grants.
  if (nowSeconds > expiresAt || expiresAt > nowSeconds + SEAL_TTL_SECONDS) return false;
  const given = Buffer.from(parts[2]!, "base64url");
  const expected = mac(key, facts, expiresAt);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
