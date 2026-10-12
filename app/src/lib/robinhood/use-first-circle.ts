"use client";

/**
 * The landing's Robinhood Chain "Try it on" link: the trusted factory's first circle, read when the landing opens.
 * Read, never written into the build: the trust gate (ops/trust-config.ts) allows no address in the page's bundle
 * but USDG and the factory, so a link to a hard-coded circle would ship an address nobody checked.
 */
import { useEffect, useState } from "react";
import type { Address } from "viem";

import { firstCircle } from "./adapter";
import { robinhoodPublicClient } from "./wallet";

export type FirstCircle = { status: "loading" } | { status: "ready"; circle: Address } | { status: "none" } | { status: "error" };

export function useFirstCircle(): FirstCircle {
  const [state, setState] = useState<FirstCircle>({ status: "loading" });
  useEffect(() => {
    let live = true;
    firstCircle(robinhoodPublicClient).then(
      (circle) => { if (live) setState(circle ? { status: "ready", circle } : { status: "none" }); },
      () => { if (live) setState({ status: "error" }); },
    );
    return () => { live = false; };
  }, []);
  return state;
}
