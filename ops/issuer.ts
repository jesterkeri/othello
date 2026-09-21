/**
 * The issuer binding primitives, shared by ops/verify-issuer-bindings.ts (which
 * performs the live check) and ops/fetch-fixtures.ts (which requires its evidence).
 */
export const BACKED_ORIGIN = "https://assets.backed.fi";
export const BACKED_NETWORK_ATTR = "data-network-address";

/** Built from a reviewed slug against a pinned origin, never from anything a mint says. */
export function productPageUrl(productSlug: string, originOverride?: string): string {
  const origin = originOverride ?? BACKED_ORIGIN;
  const url = `${origin}/products/${encodeURIComponent(productSlug)}`;
  if (new URL(url).origin !== new URL(origin).origin) {
    throw new Error(`product URL ${url} escaped the pinned origin ${origin}`);
  }
  return url;
}

/**
 * Bounded retry for transport-level failures only. Not a fallback: it never invents
 * data, and an HTTP status, a redirect or a missing attribute is a real answer that
 * is never retried. On giving up it names the URL and the underlying cause, because
 * node's bare `fetch failed` names neither.
 */
/** The endpoint could not be reached. A typed class, so callers never classify by message text. */
export class EndpointUnavailableError extends Error {
  readonly url: string;
  constructor(url: string, message: string) {
    super(message);
    this.name = "EndpointUnavailableError";
    this.url = url;
  }
}

export async function fetchOrExplain(url: string, init?: RequestInit): Promise<Response> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      last = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 500));
    }
  }
  const e = last as { message?: string; cause?: { message?: string; code?: string } };
  const cause = e?.cause?.message ?? e?.cause?.code ?? "no cause reported";
  throw new EndpointUnavailableError(
    url,
    `could not reach ${url} after 3 attempts: ${e?.message ?? String(last)} (${cause})`,
  );
}

/** A recorded binding. Every field is validated before use; none is decorative. */
export type IssuerBindingRecord = {
  symbol: string;
  address: string;
  url: string;
  attribute: string;
  bodySha256: string;
  verifiedAt: string;
};

/** How stale a recorded binding may be before it is refused outright. */
export const BINDING_MAX_AGE_DAYS = 30;

/**
 * How far ahead of now a verifiedAt may sit. Small, for ordinary clock skew between
 * the machine that verified and the machine reading. Anything beyond it is refused:
 * a future timestamp otherwise makes the computed age negative and slips past the
 * age limit entirely, which is a way to make a stale record look fresh forever.
 */
export const BINDING_MAX_SKEW_MS = 5 * 60 * 1000;

export function validateBindingRecord(
  symbol: string,
  address: string,
  expectedUrl: string,
  raw: unknown,
): IssuerBindingRecord {
  const r = raw as Partial<IssuerBindingRecord> | undefined;
  const fail = (why: string): never => {
    throw new Error(`${symbol}: recorded issuer binding ${why}. Run: pnpm tsx ops/verify-issuer-bindings.ts`);
  };
  if (!r || typeof r !== "object") fail("is missing");
  if (r!.symbol !== symbol) fail(`names symbol ${r!.symbol}, expected ${symbol}`);
  if (r!.address !== address) fail(`is for ${r!.address}, allowlist says ${address}`);
  if (r!.url !== expectedUrl) fail(`url ${r!.url} is not ${expectedUrl}`);
  const expectedAttr = `${BACKED_NETWORK_ATTR}="${address}"`;
  if (r!.attribute !== expectedAttr) fail(`attribute ${r!.attribute} is not ${expectedAttr}`);
  if (typeof r!.bodySha256 !== "string" || !/^[0-9a-f]{64}$/.test(r!.bodySha256)) {
    fail("bodySha256 is not a sha-256 digest");
  }
  const at = Date.parse(r!.verifiedAt ?? "");
  if (Number.isNaN(at)) fail(`verifiedAt ${r!.verifiedAt} is not a date`);
  const ageMs = Date.now() - at;
  if (ageMs < -BINDING_MAX_SKEW_MS) {
    fail(
      `verifiedAt ${r!.verifiedAt} is in the future by ` +
        `${Math.floor(-ageMs / 1000)}s, beyond the ${BINDING_MAX_SKEW_MS / 1000}s skew allowance`,
    );
  }
  const ageDays = ageMs / 86_400_000;
  if (ageDays > BINDING_MAX_AGE_DAYS) {
    fail(`was verified ${Math.floor(ageDays)} days ago, older than the ${BINDING_MAX_AGE_DAYS} day limit`);
  }
  return r as IssuerBindingRecord;
}
