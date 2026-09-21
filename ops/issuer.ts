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
  throw new Error(`could not reach ${url} after 3 attempts: ${e?.message ?? String(last)} (${cause})`);
}
