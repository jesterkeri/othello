/**
 * T18d adversary: the live circle page's "Anyone can move the circle on" panel must not
 * say anything false (T18d requirement 2: "No false statement on screen").
 *
 * 1. SPEC.md §5 release_pot: "every seat paid OR defaulted". A defaulted seat does not pay;
 *    release_pot takes its contribution from the escrow. With Ada defaulted and the other
 *    four paid, the panel must not claim that every seat has paid.
 * 2. A transaction the wallet sent, which landed and failed on chain (confirmTransaction
 *    returns an err), was sent: its fee is spent. The status line must not say "not sent".
 *
 * LiveCircle is rendered with react-dom/server. Substitutions: CSS modules as class-name
 * stubs, the header's WalletControl as nothing, @solana/wallet-adapter-react as a stub wallet
 * and connection, and LiveCircle's own useState seeded with a read (its fetch runs in an
 * effect, which a server render never runs). Member wallets are fresh keypairs; the circle,
 * mints and error code come from the repo (DEMO_CIRCLE, ops/devnet-mints.json, the IDL).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as anchor from "@coral-xyz/anchor";

import { REPO } from "./artifacts.ts";
import { CIRCLE_STATES } from "../app/src/fixtures/circles.ts";

const SRC = resolve(REPO, "app/src");
const appRequire = createRequire(resolve(SRC, "components/circle/index.ts"));
const REACT_URL = pathToFileURL(appRequire.resolve("react")).href;

type G = {
  React?: unknown;
  __seed?: unknown[];
  __n?: number;
  __sets?: unknown[];
  __wallet?: unknown;
  __conn?: unknown;
  __clicks?: Record<string, () => unknown>;
};
const g = globalThis as G;

// LiveCircle's useState, in call order: live, error, pay. Each is seeded from g.__seed and
// every set is recorded in g.__sets.
const REACT_SHIM = `
import R from "${REACT_URL}";
export default R;
export const { useCallback, useEffect, useRef } = R;
export function useState(init) {
  const [v, set] = R.useState(init);
  const k = (globalThis.__n++) % 3;
  const seeded = globalThis.__seed && k in globalThis.__seed ? globalThis.__seed[k] : v;
  return [seeded, (x) => { globalThis.__sets.push(x); try { set(x); } catch {} }];
}`;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".module.css")) {
      return { url: "data:text/javascript,export default new Proxy({}, { get: (_, k) => String(k) });", shortCircuit: true };
    }
    if (specifier === "@/components/othello/WalletConnect" || specifier === "./WalletConnect") {
      return { url: "data:text/javascript,export function WalletControl() { return null; }", shortCircuit: true };
    }
    if (specifier === "@solana/wallet-adapter-react") {
      return {
        url: "data:text/javascript,export function useConnection() { return { connection: globalThis.__conn }; } export function useWallet() { return globalThis.__wallet; }",
        shortCircuit: true,
      };
    }
    if (specifier === "react" && context.parentURL?.endsWith("/live/LiveCircle.tsx")) {
      return { url: `data:text/javascript,${encodeURIComponent(REACT_SHIM)}`, shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
        try {
          readFileSync(base + ext);
          return next(pathToFileURL(base + ext).href, context);
        } catch {
          /* try the next extension */
        }
      }
    }
    return next(specifier, context);
  },
});

const mints = JSON.parse(readFileSync(resolve(REPO, "ops/devnet-mints.json"), "utf8")) as { nflxxMirror: string; testUsdc: string };
const idl = JSON.parse(readFileSync(resolve(SRC, "idl/othello.json"), "utf8")) as { errors: { code: number; name: string }[] };
const ROUND_NOT_FUNDED = idl.errors.find((e) => e.name === "RoundNotFunded")!.code;

const wallets = CIRCLE_STATES.active.members.map(() => anchor.web3.Keypair.generate().publicKey.toBase58());
// Round 2: Ada (seat 1) took round 1's pot, then defaulted; the other four have paid round 2.
const view = {
  ...CIRCLE_STATES.active,
  members: CIRCLE_STATES.active.members.map((m, i) => ({ ...m, address: wallets[i]! })),
  round: 1,
  paidBitmap: 0b11110,
  receivedBitmap: 0b00001,
  defaultedBitmap: 0b00001,
  escrow: 4 * CIRCLE_STATES.active.contribution,
};
const live = {
  view,
  accounts: { circle: "8uGgNmog9gbwDMFMB2EKHXBSQ43YcUaB8eAPhgGsXT3Q", usdcMint: mints.testUsdc, stockMint: mints.nflxxMirror },
  split: { multiplier: 1, newMultiplier: 1, effectiveAt: 0 },
  // T18e: the live read carries the liquidation pool (Codex T18d r1); nobody here is defaultable.
  pool: { discountBps: 2000, usdc: 0 },
  readAt: Math.floor(Date.now() / 1000),
};

const textOf = (node: unknown): string =>
  Array.isArray(node) ? node.map(textOf).join("") : typeof node === "string" || typeof node === "number" ? String(node) : "";

async function render(pay: unknown): Promise<string> {
  const React = appRequire("react");
  const { renderToStaticMarkup } = appRequire("react-dom/server");
  // Classic JSX calls the global React; record each button's onClick by its label.
  g.__clicks = {};
  g.React = {
    ...React,
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
      if (type === "button" && typeof props?.onClick === "function") g.__clicks![textOf(children)] = props.onClick as () => unknown;
      return React.createElement(type, props, ...children);
    },
  };
  g.__n = 0;
  g.__seed = [live, null, pay];
  const { default: LiveCircle } = await import(pathToFileURL(resolve(SRC, "components/live/LiveCircle.tsx")).href);
  const html: string = renderToStaticMarkup(React.createElement(LiveCircle));
  return html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
}

describe("T18d adversary: the anyone-may-send panel says only true things", () => {
  const stranger = anchor.web3.Keypair.generate().publicKey;
  let sent: number;

  beforeEach(() => {
    sent = 0;
    g.__sets = [];
    g.__wallet = {
      publicKey: stranger,
      sendTransaction: async () => {
        sent++;
        return "5VERNGQ8o5hQx8Yp8b3kLbbYx4wP2XWbPqKkq7w7nRwYJk3x6CjvL6CwFqS4fFq3nq3YdK8VqXQy1u8YzZ7eTnF";
      },
    };
    g.__conn = {
      getLatestBlockhash: async () => ({ blockhash: anchor.web3.Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1 }),
      // The shape web3.js returns for a transaction that landed and was refused by the program.
      confirmTransaction: async () => ({ context: { slot: 1 }, value: { err: { InstructionError: [0, { Custom: ROUND_NOT_FUNDED }] } } }),
      getTransaction: async () => null,
    };
  });

  it("control: with Ada defaulted and the rest paid, Release pot is enabled", async () => {
    const html = await render({ phase: "idle" });
    assert.match(html, /Release pot to Tunde/);
    assert.ok(g.__clicks!["Release pot to Tunde"], "Release pot has a handler");
  });

  it("does not say every seat has paid when a seat has defaulted and has not paid", async () => {
    const text = await render({ phase: "idle" });
    assert.doesNotMatch(
      text,
      /Every seat has paid/,
      `Ada (seat 1) is defaulted and her paid bit is 0; release_pot covers her from the escrow (SPEC §5), yet the panel says: ${/Every seat has paid[^.]*\./.exec(text)?.[0]}`,
    );
  });

  it("does not say 'not sent' for a transaction the wallet sent and the chain refused", async () => {
    await render({ phase: "idle" });
    await g.__clicks!["Release pot to Tunde"]!();
    for (let i = 0; i < 50 && !g.__sets!.some((x) => (x as { phase?: string }).phase === "failed"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(sent, 1, "the wallet sent the transaction");
    const failed = g.__sets!.find((x) => (x as { phase?: string }).phase === "failed");
    assert.ok(failed, `the send ended in the failed phase: ${JSON.stringify(g.__sets)}`);

    const text = await render(failed);
    assert.match(text, /RoundNotFunded/, "the program's own words are shown");
    assert.doesNotMatch(text, /not sent/, `the wallet sent it and it landed on chain, yet the screen says: ${/Release:[^.]*\./.exec(text)?.[0]}`);
  });
});
