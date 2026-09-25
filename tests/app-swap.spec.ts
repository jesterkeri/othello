/**
 * T18g: Buy in place. The server builds Jupiter's swap for the buyer and relays the buyer-signed
 * bytes to mainnet, and it must never hand out, or relay, anything but a Jupiter swap paid for (and,
 * to relay, signed) by that buyer (app/src/lib/swap.ts, app/api/swap, app/api/swap/send). Jupiter
 * and the mainnet RPC are replaced by recorded-shape answers; nothing is sent to any cluster.
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

const lib = () => import(pathToFileURL(resolve(SRC, "lib/swap.ts")).href) as Promise<typeof import("../app/src/lib/swap.ts")>;

describe("T18g: lib/swap.ts checkSwapTx", () => {
  it("accepts a Jupiter swap paid by the buyer; to relay, it must also be signed", async () => {
    const { checkSwapTx } = await lib();
    assert.equal(checkSwapTx(tx(buyer.publicKey, JUP), buyer.publicKey.toBase58(), false).ok, true);
    assert.equal(checkSwapTx(tx(buyer.publicKey, JUP), buyer.publicKey.toBase58(), true).ok, false);
    assert.equal(checkSwapTx(tx(buyer.publicKey, JUP, buyer), buyer.publicKey.toBase58(), true).ok, true);
  });
  it("refuses a transaction paid by someone else, one that is not a Jupiter swap, and garbage", async () => {
    const { checkSwapTx } = await lib();
    const other = Keypair.generate();
    assert.match((checkSwapTx(tx(other.publicKey, JUP, other), buyer.publicKey.toBase58(), true) as { reason: string }).reason, /not paid for by this wallet/);
    assert.match((checkSwapTx(tx(buyer.publicKey, OTHER, buyer), buyer.publicKey.toBase58(), true) as { reason: string }).reason, /not a Jupiter swap/);
    assert.equal(checkSwapTx("!!!", buyer.publicKey.toBase58(), false).ok, false);
    assert.equal(checkSwapTx(Buffer.alloc(2000, 1).toString("base64"), buyer.publicKey.toBase58(), false).ok, false);
  });
});

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

describe("T18g: /api/swap builds only the buyer's own Jupiter swap, for a listed mint", () => {
  const build = async (body: unknown, swapTx: string, quote: unknown = QUOTE) => {
    const route = await import(pathToFileURL(resolve(SRC, "app/api/swap/route.ts")).href);
    return withFetch(
      (url) => (url.includes("/quote?") ? { body: quote } : { body: { swapTransaction: swapTx, lastValidBlockHeight: 123 } }),
      async () => {
        const res = await route.POST(post(body));
        return { status: res.status as number, body: (await res.json()) as Record<string, unknown> };
      },
    );
  };

  it("returns Jupiter's transaction, and asks Jupiter for the registry's mint, not the browser's", async () => {
    const { out, asked } = await build({ symbol: "NVDAx", usdc: 50, user: buyer.publicKey.toBase58() }, tx(buyer.publicKey, JUP));
    assert.equal(out.status, 200);
    assert.equal(out.body.outRaw, "220000000");
    assert.equal(out.body.minOutRaw, "217800000");
    assert.ok(asked[0]!.includes(`outputMint=${NVDAX}`) && asked[0]!.includes("amount=50000000"));
  });
  it("refuses an unlisted symbol and a bad wallet before asking Jupiter", async () => {
    const a = await build({ symbol: "FAKEx", usdc: 50, user: buyer.publicKey.toBase58() }, tx(buyer.publicKey, JUP));
    assert.equal(a.out.status, 404);
    assert.equal(a.asked.length, 0);
    const b = await build({ symbol: "NVDAx", usdc: 50, user: "nope" }, tx(buyer.publicKey, JUP));
    assert.equal(b.out.status, 400);
  });
  it("refuses Jupiter's transaction if someone else pays it or it is not a Jupiter swap", async () => {
    const a = await build({ symbol: "NVDAx", usdc: 50, user: buyer.publicKey.toBase58() }, tx(Keypair.generate().publicKey, JUP));
    assert.equal(a.out.status, 502);
    assert.match(String(a.out.body.error), /not paid for by this wallet/);
    const b = await build({ symbol: "NVDAx", usdc: 50, user: buyer.publicKey.toBase58() }, tx(buyer.publicKey, OTHER));
    assert.match(String(b.out.body.error), /not a Jupiter swap/);
  });
  it("refuses a quote for a different token", async () => {
    const { out } = await build({ symbol: "NVDAx", usdc: 50, user: buyer.publicKey.toBase58() }, tx(buyer.publicKey, JUP), { ...QUOTE, outputMint: OTHER.toBase58() });
    assert.equal(out.status, 502);
    assert.match(String(out.body.error), /different token/);
  });
});

describe("T18g: /api/swap/send relays only a signed Jupiter swap and reports the chain's answer", () => {
  const send = async (body: unknown, rpc: (method: string) => Answer) => {
    const route = await import(pathToFileURL(resolve(SRC, "app/api/swap/send/route.ts")).href);
    return withFetch(
      (_url, init) => rpc(JSON.parse(String(init?.body ?? "{}")).method as string),
      async () => {
        const res = await route.POST(post(body));
        return { status: res.status as number, body: (await res.json()) as Record<string, unknown> };
      },
    );
  };
  const signed = () => tx(buyer.publicKey, JUP, buyer);

  it("relays a signed Jupiter swap and reports it confirmed", async () => {
    const { out, asked } = await send({ tx: signed(), user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999 }, (m) =>
      m === "sendTransaction" ? { body: { result: "SIG" } } : m === "getSignatureStatuses" ? { body: { result: { value: [{ err: null, confirmationStatus: "confirmed" }] } } } : { body: { result: 1 } },
    );
    assert.deepEqual(out.body, { signature: "SIG", status: "confirmed" });
    assert.ok(asked[0]!.includes('"sendTransaction"'));
  });
  it("relays nothing unsigned, not a Jupiter swap, or paid by someone else", async () => {
    for (const bad of [tx(buyer.publicKey, JUP), tx(buyer.publicKey, OTHER, buyer)]) {
      const { out, asked } = await send({ tx: bad, user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999 }, () => ({ body: { result: "SIG" } }));
      assert.equal(out.status, 400);
      assert.equal(asked.length, 0, "nothing reached the RPC");
    }
  });
  it("reports a swap that failed on chain as failed, with the signature", async () => {
    const { out } = await send({ tx: signed(), user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999 }, (m) =>
      m === "sendTransaction" ? { body: { result: "SIG" } } : { body: { result: { value: [{ err: { InstructionError: [0, { Custom: 6001 }] } }] } } },
    );
    assert.equal(out.body.status, "failed");
    assert.equal(out.body.signature, "SIG");
  });
  it("never echoes the RPC URL (it can carry a key)", async () => {
    const prev = process.env.MAINNET_RPC_URL;
    process.env.MAINNET_RPC_URL = "https://rpc.example/?api-key=SECRET";
    try {
      const { out } = await send({ tx: signed(), user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999 }, () => ({ body: { error: { message: "blocked at https://rpc.example/?api-key=SECRET" } } }));
      assert.doesNotMatch(JSON.stringify(out.body), /SECRET/);
    } finally {
      if (prev === undefined) delete process.env.MAINNET_RPC_URL;
      else process.env.MAINNET_RPC_URL = prev;
    }
  });
  it("never echoes the key alone either (adversary pass 5)", async () => {
    const prev = process.env.MAINNET_RPC_URL;
    process.env.MAINNET_RPC_URL = "https://rpc.example/v2/abcdef0123456789SECRETKEY";
    try {
      const { out } = await send({ tx: signed(), user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999 }, () => ({ body: { error: { message: "invalid api key abcdef0123456789SECRETKEY" } } }));
      assert.doesNotMatch(JSON.stringify(out.body), /SECRETKEY/);
    } finally {
      if (prev === undefined) delete process.env.MAINNET_RPC_URL;
      else process.env.MAINNET_RPC_URL = prev;
    }
  });
});
