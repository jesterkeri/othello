/**
 * The app's HTTP transport for Robinhood Chain reads. viem's own `timeout` covers a response's headers, not its body,
 * so a reply whose body never arrives would hold a read, and the page-wide circle-read queue behind it, forever
 * (adversary passes on 949f7dc and 22bc733: a stalled head block, a stalled circlesOfCount). Every request here is
 * aborted after CALL_TIMEOUT_MS whole, headers and body; viem's retries stay as they are. So every call, and every
 * read and page built from calls, ends in bounded time. A request whose body is still arriving 10 s after it was sent
 * counts as failed (the public testnet RPC answers in well under a second).
 *
 * The bound joins viem's own signal with a timer through an AbortController, not AbortSignal.any / .timeout, which
 * browsers the app still targets lack (adversary on 22d724c: Safari 17.0 to 17.3, Chrome before 116).
 */
import { http } from "viem";

export const CALL_TIMEOUT_MS = 10_000;

const boundedFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const bound = new AbortController();
  const timer = setTimeout(() => bound.abort(new DOMException("The request took too long.", "TimeoutError")), CALL_TIMEOUT_MS);
  // in Node the timer must not keep the process alive; a browser has no unref
  (timer as { unref?: () => void }).unref?.();
  const outer = init?.signal;
  if (outer) {
    if (outer.aborted) bound.abort(outer.reason);
    else outer.addEventListener("abort", () => bound.abort(outer.reason), { once: true });
  }
  return fetch(input, { ...init, signal: bound.signal });
};

/** JSON-RPC over HTTP with batching, each request bounded whole. `url` defaults to the chain's own RPC. */
export function robinhoodHttp(url?: string) {
  return http(url, { batch: true, timeout: CALL_TIMEOUT_MS, fetchFn: boundedFetch });
}
