/**
 * The app's HTTP transport for Robinhood Chain reads. viem's own `timeout` covers a response's headers, not its body,
 * so a reply whose body never arrives would hold a read, and the page-wide circle-read queue behind it, forever
 * (adversary passes on 949f7dc and 22bc733: a stalled head block, a stalled circlesOfCount). Every request here is
 * aborted after CALL_TIMEOUT_MS whole, headers and body, the same bound viem gives the headers; viem's retries stay as
 * they are. So every call, and every read and page built from calls, ends in bounded time without a page-level
 * deadline that could cut a slow but healthy page short.
 */
import { http } from "viem";

export const CALL_TIMEOUT_MS = 10_000;

const boundedFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const limit = AbortSignal.timeout(CALL_TIMEOUT_MS);
  return fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, limit]) : limit });
};

/** JSON-RPC over HTTP with batching, each request bounded whole. `url` defaults to the chain's own RPC. */
export function robinhoodHttp(url?: string) {
  return http(url, { batch: true, timeout: CALL_TIMEOUT_MS, fetchFn: boundedFetch });
}
