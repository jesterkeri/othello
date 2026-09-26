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

const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const OTHER = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const buyer = Keypair.generate();

function tx(payer: PublicKey, program: PublicKey, sign?: Keypair): string {
  const msg = MessageV0.compile({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    // The listed mint rides as an account, as in Jupiter's route instruction.
    instructions: [new TransactionInstruction({ programId: program, keys: [{ pubkey: new PublicKey(NVDAX), isSigner: false, isWritable: false }], data: Buffer.from([1]) })],
  });
  const t = new VersionedTransaction(msg);
  if (sign) t.sign([sign]);
  return Buffer.from(t.serialize()).toString("base64");
}

function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA)[0];
}

/** A minimal, signed-or-unsigned shape of the documented Jupiter V6 `route` instruction. */
function approvedTx(payer: PublicKey, sign?: Keypair, extras: InstanceType<typeof TransactionInstruction>[] = []): string {
  const out = ata(payer, new PublicKey(NVDAX), TOKEN_2022);
  const input = ata(payer, USDC, OTHER);
  const route = new TransactionInstruction({
    programId: JUP,
    keys: [
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: input, isSigner: false, isWritable: true },
      { pubkey: out, isSigner: false, isWritable: true },
      { pubkey: JUP, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(NVDAX), isSigner: false, isWritable: false },
    ],
    // Anchor's `global:route` discriminator, from Jupiter's published V6 IDL.
    data: Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]),
  });
  const msg = MessageV0.compile({ payerKey: payer, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [...extras, route] });
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

describe("T18g: checkSwapTx against a REAL Jupiter transaction (Codex T18d r4)", () => {
  const fx = JSON.parse(readFileSync(resolve(REPO, "tests/fixtures/jup-swap-qqqx.json"), "utf8")) as { user: string; swapTransaction: string };
  it("resolves the real transaction's lookup table and binds its documented `route` output to QQQx (B1)", async () => {
    const { resolveKeys, checkSwapAccounts } = await lib();
    const fxl = JSON.parse(readFileSync(resolve(REPO, "tests/fixtures/jup-swap-qqqx.json"), "utf8")) as { user: string; outputMint: string; swapTransaction: string; lookupTables: Record<string, string> };
    const t = VersionedTransaction.deserialize(Buffer.from(fxl.swapTransaction, "base64"));
    const tables = Object.fromEntries(Object.entries(fxl.lookupTables).map(([k, v]) => [k, Uint8Array.from(Buffer.from(v, "base64"))]));
    const keys = resolveKeys(t, tables)!;
    assert.ok(keys.includes(fxl.outputMint), "the output mint comes from the lookup table");
    assert.equal(checkSwapAccounts(t, keys, fxl.user, fxl.outputMint), null);
    assert.match(String(checkSwapAccounts(t, keys, fxl.user, NVDAX)), /does not send the listed stock/);
    assert.match(String(checkSwapAccounts(t, keys, Keypair.generate().publicKey.toBase58(), fxl.outputMint)), /does not send the listed stock/);
  });

  it("refuses real-fixture mutations that unbind the output account or mint (B1)", async () => {
    const { resolveKeys, checkSwapAccounts } = await lib();
    const fxl = JSON.parse(readFileSync(resolve(REPO, "tests/fixtures/jup-swap-qqqx.json"), "utf8")) as { user: string; outputMint: string; swapTransaction: string; lookupTables: Record<string, string> };
    const t = VersionedTransaction.deserialize(Buffer.from(fxl.swapTransaction, "base64"));
    const tables = Object.fromEntries(Object.entries(fxl.lookupTables).map(([k, v]) => [k, Uint8Array.from(Buffer.from(v, "base64"))]));
    const keys = resolveKeys(t, tables)!;
    const route = t.message.compiledInstructions.find((ix) => keys[ix.programIdIndex] === JUP.toBase58())!;

    const anotherOwner = Keypair.generate().publicKey;
    const wrongOutput = VersionedTransaction.deserialize(Buffer.from(fxl.swapTransaction, "base64"));
    const wrongOutputRoute = wrongOutput.message.compiledInstructions.find((ix) => keys[ix.programIdIndex] === JUP.toBase58())!;
    // Alter only route's userDestinationTokenAccount. The ATA instruction remains a valid creation of
    // the original output ATA, so this proves the route-output binding independently.
    wrongOutputRoute.accountKeyIndexes[3] = route.accountKeyIndexes[0]!;
    assert.match(String(checkSwapAccounts(wrongOutput, keys, fxl.user, fxl.outputMint)), /does not send the listed stock/);

    const wrongSource = [...keys];
    wrongSource[route.accountKeyIndexes[2]!] = ata(anotherOwner, USDC, OTHER).toBase58();
    assert.match(String(checkSwapAccounts(t, wrongSource, fxl.user, fxl.outputMint)), /does not send the listed stock/);

    const wrongMint = [...keys];
    wrongMint[route.accountKeyIndexes[5]!] = NVDAX;
    assert.match(String(checkSwapAccounts(t, wrongMint, fxl.user, fxl.outputMint)), /does not send the listed stock/);

    // QQQx is still present in a remaining account, but it is no longer the route's destination mint.
    wrongMint[route.accountKeyIndexes[11]!] = fxl.outputMint;
    assert.ok(wrongMint.includes(fxl.outputMint));
    assert.match(String(checkSwapAccounts(t, wrongMint, fxl.user, fxl.outputMint)), /does not send the listed stock/);
  });

  it("refuses an unmapped Jupiter discriminator and an ATA create that is not the bound output ATA (B1)", async () => {
    const { resolveKeys, checkSwapAccounts } = await lib();
    const fxl = JSON.parse(readFileSync(resolve(REPO, "tests/fixtures/jup-swap-qqqx.json"), "utf8")) as { user: string; outputMint: string; swapTransaction: string; lookupTables: Record<string, string> };
    const tables = Object.fromEntries(Object.entries(fxl.lookupTables).map(([k, v]) => [k, Uint8Array.from(Buffer.from(v, "base64"))]));
    const t = VersionedTransaction.deserialize(Buffer.from(fxl.swapTransaction, "base64"));
    const keys = resolveKeys(t, tables)!;
    const unmapped = VersionedTransaction.deserialize(Buffer.from(fxl.swapTransaction, "base64"));
    const unmappedRoute = unmapped.message.compiledInstructions.find((ix) => keys[ix.programIdIndex] === JUP.toBase58())!;
    const discriminatorStart = unmappedRoute.data[0];
    if (discriminatorStart === undefined) throw new Error("fixture route has no discriminator");
    unmappedRoute.data[0] = discriminatorStart ^ 0xff;
    assert.match(String(checkSwapAccounts(unmapped, keys, fxl.user, fxl.outputMint)), /unsupported Jupiter instruction/);

    // Alter only the ATA instruction's index. Replacing the lookup-table entry itself would also alter
    // the route instruction, which is a different check.
    const wrongAta = VersionedTransaction.deserialize(Buffer.from(fxl.swapTransaction, "base64"));
    const wrongAtaCreate = wrongAta.message.compiledInstructions.find((ix) => keys[ix.programIdIndex] === ATA.toBase58())!;
    wrongAtaCreate.accountKeyIndexes[1] = unmappedRoute.accountKeyIndexes[0]!;
    assert.match(String(checkSwapAccounts(wrongAta, keys, fxl.user, fxl.outputMint)), /other than the buyer's input or output ATA/);

    const wrongOwner = VersionedTransaction.deserialize(Buffer.from(fxl.swapTransaction, "base64"));
    const wrongOwnerCreate = wrongOwner.message.compiledInstructions.find((ix) => keys[ix.programIdIndex] === ATA.toBase58())!;
    wrongOwnerCreate.accountKeyIndexes[2] = unmappedRoute.accountKeyIndexes[4]!;
    assert.match(String(checkSwapAccounts(wrongOwner, keys, fxl.user, fxl.outputMint)), /other than the buyer's input or output ATA/);

    const twoRoutes = VersionedTransaction.deserialize(Buffer.from(fxl.swapTransaction, "base64"));
    const anotherRoute = twoRoutes.message.compiledInstructions.find((ix) => keys[ix.programIdIndex] === JUP.toBase58())!;
    twoRoutes.message.compiledInstructions.push({
      programIdIndex: anotherRoute.programIdIndex,
      accountKeyIndexes: Array.from(anotherRoute.accountKeyIndexes),
      data: Uint8Array.from(anotherRoute.data),
    });
    assert.match(String(checkSwapAccounts(twoRoutes, keys, fxl.user, fxl.outputMint)), /not a single Jupiter swap/);
  });
  it("refuses an unbounded compute budget (Codex T18d final)", async () => {
    const { checkSwapAccounts } = await lib();
    const payer = Keypair.generate();
    const price = Buffer.alloc(9); price[0] = 3; price.writeBigUInt64LE(10_000_000n, 1);
    const v = VersionedTransaction.deserialize(Buffer.from(approvedTx(payer.publicKey, undefined, [new TransactionInstruction({ programId: new PublicKey("ComputeBudget111111111111111111111111111111"), keys: [], data: price })]), "base64"));
    const keys = v.message.staticAccountKeys.map((k) => k.toBase58());
    assert.match(String(checkSwapAccounts(v, keys, payer.publicKey.toBase58(), NVDAX)), /unexpected compute budget/);
  });

  it("accepts the transaction Jupiter's /swap actually built (its program id is the one we check)", async () => {
    const { checkSwapTx } = await lib();
    const r = checkSwapTx(fx.swapTransaction, fx.user, false);
    assert.equal(r.ok, true, (r as { reason?: string }).reason);
  });
  it("refuses a Jupiter swap with an SPL token transfer, or an Associated Token RecoverNested, beside it (Codex T18d r5)", async () => {
    const { checkSwapTx } = await lib();
    const payer = Keypair.generate();
    const build = (extra: InstanceType<typeof TransactionInstruction>) => {
      const m = MessageV0.compile({ payerKey: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [new TransactionInstruction({ programId: JUP, keys: [], data: Buffer.from([1]) }), extra] });
      const v = new VersionedTransaction(m);
      v.sign([payer]);
      return Buffer.from(v.serialize()).toString("base64");
    };
    // SPL Token Transfer (3) of 1 unit to someone else.
    const splTransfer = new TransactionInstruction({ programId: OTHER, keys: [{ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: false }], data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]) });
    assert.match((checkSwapTx(build(splTransfer), payer.publicKey.toBase58(), true) as { reason: string }).reason, /does more than a Jupiter swap/);
    const recover = new TransactionInstruction({ programId: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"), keys: [], data: Buffer.from([2]) });
    assert.match((checkSwapTx(build(recover), payer.publicKey.toBase58(), true) as { reason: string }).reason, /does more than a Jupiter swap/);
  });

  it("refuses a Jupiter swap with an unrelated transfer added", async () => {
    const { checkSwapTx } = await lib();
    const payer = Keypair.generate();
    const msg = MessageV0.compile({
      payerKey: payer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [
        new TransactionInstruction({ programId: JUP, keys: [], data: Buffer.from([1]) }),
        anchor.web3.SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }),
      ],
    });
    const t = new VersionedTransaction(msg);
    t.sign([payer]);
    const r = checkSwapTx(Buffer.from(t.serialize()).toString("base64"), payer.publicKey.toBase58(), true);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /does more than a Jupiter swap/);
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
    const { out, asked } = await build({ symbol: "NVDAx", usdc: "50", user: buyer.publicKey.toBase58() }, approvedTx(buyer.publicKey));
    assert.equal(out.status, 200);
    assert.equal(out.body.outRaw, "220000000");
    assert.equal(out.body.minOutRaw, "217800000");
    assert.ok(asked[0]!.includes(`outputMint=${NVDAX}`) && asked[0]!.includes("amount=50000000"));
  });
  it("refuses an unlisted symbol and a bad wallet before asking Jupiter", async () => {
    const a = await build({ symbol: "FAKEx", usdc: "50", user: buyer.publicKey.toBase58() }, approvedTx(buyer.publicKey));
    assert.equal(a.out.status, 404);
    assert.equal(a.asked.length, 0);
    const b = await build({ symbol: "NVDAx", usdc: "50", user: "nope" }, approvedTx(buyer.publicKey));
    assert.equal(b.out.status, 400);
  });
  it("refuses Jupiter's transaction if someone else pays it or it is not a Jupiter swap", async () => {
    const a = await build({ symbol: "NVDAx", usdc: "50", user: buyer.publicKey.toBase58() }, tx(Keypair.generate().publicKey, JUP));
    assert.equal(a.out.status, 502);
    assert.match(String(a.out.body.error), /not paid for by this wallet/);
    const b = await build({ symbol: "NVDAx", usdc: "50", user: buyer.publicKey.toBase58() }, tx(buyer.publicKey, OTHER));
    assert.match(String(b.out.body.error), /not a Jupiter swap/);
  });
  it("accepts 0.10 USDC, the minimum, and refuses 0.099999 (Joshua: a real buy for pocket change)", async () => {
    const ok = await build({ symbol: "NVDAx", usdc: "0.10", user: buyer.publicKey.toBase58() }, approvedTx(buyer.publicKey));
    assert.equal(ok.out.status, 200);
    assert.ok(ok.asked[0]!.includes("amount=100000&"));
    const low = await build({ symbol: "NVDAx", usdc: "0.099999", user: buyer.publicKey.toBase58() }, approvedTx(buyer.publicKey));
    assert.equal(low.out.status, 400);
    assert.equal(low.asked.length, 0);
  });
  it("refuses a JSON number amount (1e2 arrives as 100; Codex T18d r4)", async () => {
    const { out, asked } = await build({ symbol: "NVDAx", usdc: 1e2, user: buyer.publicKey.toBase58() }, approvedTx(buyer.publicKey));
    assert.equal(out.status, 400);
    assert.equal(asked.length, 0);
  });
  it("refuses a quote for a different token", async () => {
    const { out } = await build({ symbol: "NVDAx", usdc: "50", user: buyer.publicKey.toBase58() }, approvedTx(buyer.publicKey), { ...QUOTE, outputMint: OTHER.toBase58() });
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
  const signed = async () => {
    const encoded = approvedTx(buyer.publicKey, buyer);
    const { signedTransactionSignature } = await lib();
    const decoded = VersionedTransaction.deserialize(Buffer.from(encoded, "base64"));
    const signature = signedTransactionSignature(decoded);
    assert.ok(signature, "the test transaction is signed");
    const feePayerSignature = decoded.signatures[0];
    if (!feePayerSignature) throw new Error("test transaction has no fee-payer signature");
    assert.equal(signature, anchor.utils.bytes.bs58.encode(feePayerSignature), "the route uses canonical base58 for the signed bytes");
    return { encoded, signature };
  };

  it("derives the signature from the signed transaction, requires the RPC to match it, and returns only that value", async () => {
    const { encoded, signature } = await signed();
    const { out, asked } = await send({ tx: encoded, user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx" }, (m) =>
      m === "sendTransaction" ? { body: { result: signature } } : m === "getSignatureStatuses" ? { body: { result: { value: [{ err: null, confirmationStatus: "confirmed" }] } } } : { body: { result: 1 } },
    );
    assert.deepEqual(out.body, { signature, status: "confirmed" });
    assert.ok(asked[0]!.includes('"sendTransaction"'));
  });
  it("refuses a different RPC signature without echoing it (B1)", async () => {
    const { encoded, signature } = await signed();
    const rpcOnly = "5VERNGQ8o5hQx8Yp8b3kLbbYx4wP2XWbPqKkq7w7nRwYJk3x6CjvL6CwFqS4fFq3nq3YdK8VqXQy1u8YzZ7eTnF";
    assert.notEqual(rpcOnly, signature);
    const { out } = await send({ tx: encoded, user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx" }, () => ({ body: { result: rpcOnly } }));
    assert.equal(out.status, 502);
    assert.deepEqual(out.body, { error: "sendTransaction: the network returned a different signature" });
    assert.doesNotMatch(JSON.stringify(out.body), new RegExp(rpcOnly));
  });
  it("relays nothing unsigned, not a Jupiter swap, or paid by someone else", async () => {
    for (const bad of [approvedTx(buyer.publicKey), tx(buyer.publicKey, OTHER, buyer)]) {
      const { out, asked } = await send({ tx: bad, user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx" }, () => ({ body: { result: "ignored" } }));
      assert.equal(out.status, 400);
      assert.equal(asked.length, 0, "nothing reached the RPC");
    }
  });
  it("reports a swap that failed on chain as failed, with the signature", async () => {
    const { encoded, signature } = await signed();
    const { out } = await send({ tx: encoded, user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx" }, (m) =>
      m === "sendTransaction" ? { body: { result: signature } } : { body: { result: { value: [{ err: { InstructionError: [0, { Custom: 6001 }] } }] } } },
    );
    assert.equal(out.body.status, "failed");
    assert.equal(out.body.signature, signature);
    // Codex T18d r5: fixed words and the program's error number only.
    assert.equal(out.body.error, "the swap failed on chain (program error 6001)");
  });
  it("never echoes the RPC URL (it can carry a key)", async () => {
    const { encoded } = await signed();
    const prev = process.env.MAINNET_RPC_URL;
    process.env.MAINNET_RPC_URL = "https://rpc.example/?api-key=SECRET";
    try {
      const { out } = await send({ tx: encoded, user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx" }, () => ({ body: { error: { message: "blocked at https://rpc.example/?api-key=SECRET" } } }));
      assert.doesNotMatch(JSON.stringify(out.body), /SECRET/);
    } finally {
      if (prev === undefined) delete process.env.MAINNET_RPC_URL;
      else process.env.MAINNET_RPC_URL = prev;
    }
  });
  it("never echoes the key alone either (adversary pass 5)", async () => {
    const { encoded } = await signed();
    const prev = process.env.MAINNET_RPC_URL;
    process.env.MAINNET_RPC_URL = "https://rpc.example/v2/abcdef0123456789SECRETKEY";
    try {
      const { out } = await send({ tx: encoded, user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx" }, () => ({ body: { error: { message: "invalid api key abcdef0123456789SECRETKEY" } } }));
      assert.doesNotMatch(JSON.stringify(out.body), /SECRETKEY/);
    } finally {
      if (prev === undefined) delete process.env.MAINNET_RPC_URL;
      else process.env.MAINNET_RPC_URL = prev;
    }
  });
  it("returns no provider text at all, only fixed words (Codex T18d r4: a short key could be in it)", async () => {
    const { encoded } = await signed();
    const prev = process.env.MAINNET_RPC_URL;
    process.env.MAINNET_RPC_URL = "https://rpc.example/?k=ab12";
    try {
      const { out } = await send({ tx: encoded, user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx" }, () => ({ body: { error: { message: "Transaction simulation failed: key ab12 rejected" } } }));
      assert.doesNotMatch(JSON.stringify(out.body), /ab12|rejected/);
      assert.match(String(out.body.error), /^sendTransaction: the network's simulation of the swap failed$/);
    } finally {
      if (prev === undefined) delete process.env.MAINNET_RPC_URL;
      else process.env.MAINNET_RPC_URL = prev;
    }
  });
});

describe("Codex T18d final: the relay echoes only a real signature", () => {
  it("returns fixed words if the RPC's signature differs from the signed transaction", async () => {
    const encoded = approvedTx(buyer.publicKey, buyer);
    const route = await import(pathToFileURL(resolve(SRC, "app/api/swap/send/route.ts")).href);
    const { out } = await withFetch(
      () => ({ body: { result: "<script>provider text</script>" } }),
      async () => {
        const res = await route.POST(post({ tx: encoded, user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx" }));
        return { status: res.status as number, body: (await res.json()) as Record<string, unknown> };
      },
    );
    assert.doesNotMatch(JSON.stringify(out.body), /provider text/);
  });
});

describe("T18i: /api/wallet reads lamports digit for digit (Codex T18d r5)", () => {
  it("keeps a balance above 2^53 lamports exact, on mainnet and devnet", async () => {
    const route = await import(pathToFileURL(resolve(SRC, "app/api/wallet/route.ts")).href);
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const method = JSON.parse(String(init?.body ?? "{}")).method as string;
      const body = method === "getBalance" ? '{"jsonrpc":"2.0","id":1,"result":{"context":{"slot":1},"value":9007199254740993}}' : JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: [] } });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const res = await route.GET({ nextUrl: new URL(`http://localhost/api/wallet?owner=${buyer.publicKey.toBase58()}`) });
      const b = (await res.json()) as { lamports: string; devnet: { lamports: string } };
      assert.equal(b.lamports, "9007199254740993");
      assert.equal(b.devnet.lamports, "9007199254740993");
    } finally {
      globalThis.fetch = real;
    }
  });
});
