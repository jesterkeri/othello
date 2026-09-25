/**
 * T18g adversary: /api/swap takes the buyer's USDC amount through Number() and Math.round, so an
 * amount that is not a positive plain decimal within USDC's 6 places is rounded or reinterpreted
 * and sent to Jupiter, where the brief's contract says it must be refused ("Amounts typed by a
 * person convert exactly (no floats) and reject anything but a positive plain decimal within the
 * token's decimals"). Harness copied from tests/app-swap.spec.ts; nothing leaves the process.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as anchor from "@coral-xyz/anchor";

// web3 through anchor: @solana/web3.js is not a root dependency (root tsc resolves types from here).
const { Keypair, MessageV0, PublicKey, TransactionInstruction, VersionedTransaction } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

import { REPO } from "./artifacts.ts";

const SRC = resolve(REPO, "app/src");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx"]) {
        try {
          readFileSync(base + ext);
          return next(pathToFileURL(base + ext).href, context);
        } catch {
          /* next extension */
        }
      }
    }
    return next(specifier, context);
  },
});

const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5L3aH9Q8b");
const OTHER = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const buyer = Keypair.generate();

function tx(payer: PublicKey, program: PublicKey, sign?: Keypair): string {
  const msg = MessageV0.compile({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [new TransactionInstruction({ programId: program, keys: [], data: Buffer.from([1]) })],
  });
  const t = new VersionedTransaction(msg);
  if (sign) t.sign([sign]);
  return Buffer.from(t.serialize()).toString("base64");
}



type Answer = { status?: number; body: unknown };
async function withFetch<T>(answers: (url: string, init?: RequestInit) => Answer, run: () => Promise<T>): Promise<{ out: T; asked: string[] }> {
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    asked.push(`${String(url)} ${init?.body ?? ""}`);
    const a = answers(String(url), init);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return { out: await run(), asked };
  } finally {
    globalThis.fetch = real;
  }
}
const post = (body: unknown) => ({ json: async () => body }) as never;
const QUOTE = { outputMint: NVDAX, outAmount: "220000000", otherAmountThreshold: "217800000", priceImpactPct: "0.001", routePlan: [] };

describe("T18g adversary: /api/swap refuses an amount that is not a plain decimal within 6 places", () => {
  const build = async (usdc: unknown) => {
    const route = await import(pathToFileURL(resolve(SRC, "app/api/swap/route.ts")).href);
    return withFetch(
      (url) => (url.includes("/quote?") ? { body: QUOTE } : { body: { swapTransaction: tx(buyer.publicKey, JUP), lastValidBlockHeight: 123 } }),
      async () => {
        const res = await route.POST(post({ symbol: "NVDAx", usdc, user: buyer.publicKey.toBase58() }));
        return { status: res.status as number, body: (await res.json()) as Record<string, unknown> };
      },
    );
  };
  for (const usdc of ["1e2", "0x10", 1.0000005, "50.1234567"]) {
    it(`refuses ${JSON.stringify(usdc)} before asking Jupiter`, async () => {
      const { out, asked } = await build(usdc);
      assert.equal(out.status, 400, `built a swap for ${JSON.stringify(usdc)}: ${asked[0] ?? ""}`);
      assert.equal(asked.length, 0);
    });
  }
});
