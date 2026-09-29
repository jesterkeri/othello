/**
 * State of the "My circles" list on the Robinhood home page, as a pure reducer so the page's transitions are tested
 * without a browser (tests/robinhood-my-circles.spec.ts). Pages arrive newest first; "Show more" asks for the page
 * below `before`. Starting a request clears any earlier error, so an old failure never sits beside a later success.
 */
import type { CirclePage, CircleSummary } from "./adapter";

export type MyCircles = {
  circles: CircleSummary[];
  /** Where the next (older) page ends; null once the oldest page has arrived. */
  before: number | null;
  started: boolean;
  loading: boolean;
  error: string | null;
};

export type MyCirclesAction =
  | { type: "reset" }
  | { type: "start" }
  | { type: "page"; page: CirclePage }
  | { type: "fail"; message: string };

export const EMPTY: MyCircles = { circles: [], before: null, started: false, loading: false, error: null };

export function myCircles(state: MyCircles, a: MyCirclesAction): MyCircles {
  switch (a.type) {
    case "reset":
      return EMPTY;
    case "start":
      return { ...state, loading: true, error: null };
    case "page": {
      const seen = new Set(state.circles.map((c) => c.address.toLowerCase()));
      const fresh = a.page.circles.filter((c) => !seen.has(c.address.toLowerCase()));
      return { circles: [...state.circles, ...fresh], before: a.page.before, started: true, loading: false, error: null };
    }
    case "fail":
      return { ...state, loading: false, error: a.message };
  }
}

/** The `before` for the next request: undefined asks for the newest page. */
export const nextBefore = (s: MyCircles): number | undefined => (s.started ? (s.before ?? undefined) : undefined);
export const hasMore = (s: MyCircles): boolean => s.started && s.before !== null;
