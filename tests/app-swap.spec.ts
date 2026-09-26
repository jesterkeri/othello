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

// B1: the Buy routes refuse to run without a binding key; this fixed value exists only in tests.
process.env.SWAP_BINDING_SECRET = "test-only-binding-key-never-used-outside-tests-0000";

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

/** Route arguments shaped like a real Jupiter V6 `route`: discriminator, empty plan, fixed tail. */
function routeData(o: { inAmount?: bigint; quotedOut?: bigint; slippageBps?: number; platformFeeBps?: number } = {}): Buffer {
  const tail = Buffer.alloc(19);
  tail.writeBigUInt64LE(o.inAmount ?? 1_000_000n, 0);
  tail.writeBigUInt64LE(o.quotedOut ?? 133_885n, 8);
  tail.writeUInt16LE(o.slippageBps ?? 100, 16);
  tail.writeUInt8(o.platformFeeBps ?? 0, 18);
  return Buffer.concat([Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]), Buffer.alloc(4), tail]);
}

/** A minimal, signed-or-unsigned shape of the documented Jupiter V6 `route` instruction. */
function approvedTx(payer: PublicKey, sign?: Keypair, extras: InstanceType<typeof TransactionInstruction>[] = [], amounts: Parameters<typeof routeData>[0] = {}): string {
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
      { pubkey: JUP, isSigner: false, isWritable: false }, // platformFeeAccount: not provided
    ],
    // Anchor's `global:route` discriminator (Jupiter's published V6 IDL), then the IDL's arguments:
    // an empty route plan and the fixed tail in_amount, quoted_out_amount, slippage_bps, platform_fee_bps,
    // shaped like the real fixture (1 USDC in, slippage 100, no platform fee).
    data: routeData(amounts),
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

  it("binds the optional destinationTokenAccount, refuses a platform fee and unsafe route amounts (B1 adversary)", async () => {
    const { resolveKeys, checkSwapAccounts } = await lib();
    const fxl = JSON.parse(readFileSync(resolve(REPO, "tests/fixtures/jup-swap-qqqx.json"), "utf8")) as { user: string; outputMint: string; swapTransaction: string; lookupTables: Record<string, string> };
    const tables = Object.fromEntries(Object.entries(fxl.lookupTables).map(([k, v]) => [k, Uint8Array.from(Buffer.from(v, "base64"))]));
    const fresh = () => VersionedTransaction.deserialize(Buffer.from(fxl.swapTransaction, "base64"));
    const t = fresh();
    const keys = resolveKeys(t, tables)!;
    const routeOf = (v: InstanceType<typeof VersionedTransaction>) => v.message.compiledInstructions.find((ix) => keys[ix.programIdIndex] === JUP.toBase58())!;
    const route = routeOf(t);
    const buyerOutput = ata(new PublicKey(fxl.user), new PublicKey(fxl.outputMint), TOKEN_2022).toBase58();
    const stranger = ata(Keypair.generate().publicKey, new PublicKey(fxl.outputMint), TOKEN_2022).toBase58();

    // Slots 4 and 6 hold the Jupiter program id ("not provided") in the real fixture, the same account entry
    // as the program itself, so each case repoints only that instruction slot at another existing account.
    // Slot 4 (destinationTokenAccount) receives the output when provided: only "not provided" or the buyer's ATA.
    const toBuyer = fresh();
    routeOf(toBuyer).accountKeyIndexes[4] = route.accountKeyIndexes[3]!; // the buyer's output ATA
    assert.equal(keys[route.accountKeyIndexes[3]!], buyerOutput);
    assert.equal(checkSwapAccounts(toBuyer, keys, fxl.user, fxl.outputMint), null);
    const elsewhere = fresh();
    routeOf(elsewhere).accountKeyIndexes[4] = route.accountKeyIndexes[2]!; // any account that is not the buyer's output ATA
    assert.match(String(checkSwapAccounts(elsewhere, keys, fxl.user, fxl.outputMint)), /does not send the listed stock/);
    // (a true stranger's ATA at slot 4, recompiled through the lookup table, is tests/b1-adversary.spec.ts)
    assert.ok(stranger);

    // Slot 6 (platformFeeAccount) must be "not provided", and platform_fee_bps (last byte) must be 0.
    const feeAccount = fresh();
    routeOf(feeAccount).accountKeyIndexes[6] = route.accountKeyIndexes[3]!;
    assert.match(String(checkSwapAccounts(feeAccount, keys, fxl.user, fxl.outputMint)), /platform fee/);
    const feeBps = fresh();
    const fr = routeOf(feeBps);
    fr.data[fr.data.length - 1] = 1;
    assert.match(String(checkSwapAccounts(feeBps, keys, fxl.user, fxl.outputMint)), /platform fee/);

    // slippage_bps (u16 at length-3): 100, as /api/swap requests, passes; 101 does not.
    const slip = fresh();
    const sr = routeOf(slip);
    new DataView(sr.data.buffer, sr.data.byteOffset).setUint16(sr.data.length - 3, 101, true);
    assert.match(String(checkSwapAccounts(slip, keys, fxl.user, fxl.outputMint)), /unsafe amounts/);

    // quoted_out_amount (u64 at length-11) and in_amount (u64 at length-19) must be positive.
    for (const at of [11, 19]) {
      const zero = fresh();
      const zr = routeOf(zero);
      new DataView(zr.data.buffer, zr.data.byteOffset).setBigUint64(zr.data.length - at, 0n, true);
      assert.match(String(checkSwapAccounts(zero, keys, fxl.user, fxl.outputMint)), /unsafe amounts/);
    }
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
/** A request for 50 USDC: the transaction Jupiter returns spends exactly that and promises QUOTE.outAmount. */
const FIFTY = { inAmount: 50_000_000n, quotedOut: 220_000_000n };
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
    // B1 (fresh review r2): the transaction spends exactly the requested 50 USDC and promises the quoted output.
    const { out, asked } = await build({ symbol: "NVDAx", usdc: "50", user: buyer.publicKey.toBase58() }, approvedTx(buyer.publicKey, undefined, [], FIFTY), { ...QUOTE, inAmount: "50000000" });
    assert.equal(out.status, 200);
    assert.equal(out.body.outRaw, "220000000");
    assert.equal(out.body.minOutRaw, "217800000");
    assert.ok(asked[0]!.includes(`outputMint=${NVDAX}`) && asked[0]!.includes("amount=50000000"));
    // B1: the build carries a seal over exactly this transaction, for this buyer and symbol only.
    const { verifySeal } = (await import(pathToFileURL(resolve(SRC, "lib/swapSeal.ts")).href)) as typeof import("../app/src/lib/swapSeal.ts");
    const message = VersionedTransaction.deserialize(Buffer.from(String(out.body.tx), "base64")).message.serialize();
    const now = Math.floor(Date.now() / 1000);
    assert.equal(verifySeal(out.body.seal, { message, buyer: buyer.publicKey.toBase58(), symbol: "NVDAx" }, now), true);
    assert.equal(verifySeal(out.body.seal, { message, buyer: buyer.publicKey.toBase58(), symbol: "TSLAx" }, now), false);
    assert.equal(verifySeal(out.body.seal, { message, buyer: buyer.publicKey.toBase58(), symbol: "NVDAx" }, now + 121), false);
  });
  it("refuses a transaction or quote that is not the requested purchase (B1 fresh review r2 MAJOR)", async () => {
    const body = { symbol: "NVDAx", usdc: "50", user: buyer.publicKey.toBase58() };
    const quote50 = { ...QUOTE, inAmount: "50000000" };
    // The exact mismatch the review found: 50 USDC requested, a transaction spending 1 USDC.
    const oneUsdc = await build(body, approvedTx(buyer.publicKey, undefined, [], { inAmount: 1_000_000n, quotedOut: 220_000_000n }), quote50);
    assert.equal(oneUsdc.out.status, 502);
    assert.match(String(oneUsdc.out.body.error), /does not match the quote/);
    assert.equal(oneUsdc.out.body.seal, undefined, "no seal for a mismatched transaction");
    // A transaction spending more than requested (a buyer's whole balance) for a dust output.
    const drain = await build(body, approvedTx(buyer.publicKey, undefined, [], { inAmount: 99_000_000_000n, quotedOut: 1n }), quote50);
    assert.match(String(drain.out.body.error), /does not match the quote/);
    // The quoted output differs from the transaction's promised output.
    const lessOut = await build(body, approvedTx(buyer.publicKey, undefined, [], { inAmount: 50_000_000n, quotedOut: 219_999_999n }), quote50);
    assert.match(String(lessOut.out.body.error), /does not match the quote/);
    // Slippage other than the 100 bps requested.
    const slip = await build(body, approvedTx(buyer.publicKey, undefined, [], { ...FIFTY, slippageBps: 50 }), quote50);
    assert.match(String(slip.out.body.error), /does not match the quote/);
    // Jupiter quoting a different input amount than requested.
    const other = await build(body, approvedTx(buyer.publicKey, undefined, [], FIFTY), { ...QUOTE, inAmount: "5000000" });
    assert.match(String(other.out.body.error), /different amount/);
  });

  it("refuses an unlisted symbol and a bad wallet before asking Jupiter", async () => {
    const a = await build({ symbol: "FAKEx", usdc: "50", user: buyer.publicKey.toBase58() }, approvedTx(buyer.publicKey));
    assert.equal(a.out.status, 404);
    assert.equal(a.asked.length, 0);
    const b = await build({ symbol: "NVDAx", usdc: "50", user: "nope" }, approvedTx(buyer.publicKey));
    assert.equal(b.out.status, 400);
  });
  it("refuses Jupiter's transaction if someone else pays it or it is not a Jupiter swap", async () => {
    const a = await build({ symbol: "NVDAx", usdc: "50", user: buyer.publicKey.toBase58() }, tx(Keypair.generate().publicKey, JUP), { ...QUOTE, inAmount: "50000000" });
    assert.equal(a.out.status, 502);
    assert.match(String(a.out.body.error), /not paid for by this wallet/);
    const b = await build({ symbol: "NVDAx", usdc: "50", user: buyer.publicKey.toBase58() }, tx(buyer.publicKey, OTHER), { ...QUOTE, inAmount: "50000000" });
    assert.match(String(b.out.body.error), /not a Jupiter swap/);
  });
  it("accepts 0.10 USDC, the minimum, and refuses 0.099999 (Joshua: a real buy for pocket change)", async () => {
    const ok = await build({ symbol: "NVDAx", usdc: "0.10", user: buyer.publicKey.toBase58() }, approvedTx(buyer.publicKey, undefined, [], { inAmount: 100_000n, quotedOut: 220_000_000n }), { ...QUOTE, inAmount: "100000" });
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
  /** The seal /api/swap would have issued for this exact transaction (B1). */
  const sealOf = async (encoded: string, who = buyer.publicKey.toBase58(), symbol = "NVDAx", now = Math.floor(Date.now() / 1000)) => {
    const { sealSwap } = (await import(pathToFileURL(resolve(SRC, "lib/swapSeal.ts")).href)) as typeof import("../app/src/lib/swapSeal.ts");
    const message = VersionedTransaction.deserialize(Buffer.from(encoded, "base64")).message.serialize();
    return sealSwap({ message, buyer: who, symbol }, now)!;
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
    const { out, asked } = await send({ tx: encoded, seal: await sealOf(encoded), user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx" }, (m) =>
      m === "sendTransaction" ? { body: { result: signature } } : m === "getSignatureStatuses" ? { body: { result: { value: [{ err: null, confirmationStatus: "confirmed" }] } } } : { body: { result: 1 } },
    );
    assert.deepEqual(out.body, { signature, status: "confirmed" });
    assert.ok(asked[0]!.includes('"sendTransaction"'));
  });
  it("refuses a different RPC signature without echoing it (B1)", async () => {
    const { encoded, signature } = await signed();
    const rpcOnly = "5VERNGQ8o5hQx8Yp8b3kLbbYx4wP2XWbPqKkq7w7nRwYJk3x6CjvL6CwFqS4fFq3nq3YdK8VqXQy1u8YzZ7eTnF";
    assert.notEqual(rpcOnly, signature);
    const { out } = await send({ tx: encoded, seal: await sealOf(encoded), user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx" }, () => ({ body: { result: rpcOnly } }));
    assert.equal(out.status, 502);
    assert.deepEqual(out.body, { error: "sendTransaction: the network returned a different signature" });
    assert.doesNotMatch(JSON.stringify(out.body), new RegExp(rpcOnly));
  });
  describe("B1: the relay sends only the exact transaction /api/swap sealed (Codex fresh review MAJOR)", () => {
    const refusedUnbuilt = /not the swap Othello built for you, or it expired/;
    const ok = (sig: string) => (m: string): Answer =>
      m === "sendTransaction" ? { body: { result: sig } } : m === "getSignatureStatuses" ? { body: { result: { value: [{ err: null, confirmationStatus: "confirmed" }] } } } : { body: { result: 1 } };
    const relay = (body: Record<string, unknown>, sig = "unused") => send({ user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx", ...body }, ok(sig));

    it("refuses a missing, tampered, expired or over-long seal before anything reaches the RPC", async () => {
      const { encoded } = await signed();
      const good = await sealOf(encoded);
      const now = Math.floor(Date.now() / 1000);
      const [v, exp, mac] = good.split(".");
      const flipped = `${v}.${exp}.${mac!.startsWith("A") ? "B" : "A"}${mac!.slice(1)}`;
      for (const seal of [undefined, "", "junk", flipped, await sealOf(encoded, undefined, undefined, now - 200), `${v}.${Number(exp) + 600}.${mac}`]) {
        const { out, asked } = await relay({ tx: encoded, seal });
        assert.equal(out.status, 400, `accepted seal ${String(seal)}`);
        assert.match(String(out.body.error), refusedUnbuilt);
        assert.equal(asked.length, 0, "nothing reached the RPC");
      }
    });

    it("refuses a seal for another buyer, another symbol, or another transaction", async () => {
      const { encoded } = await signed();
      const other = approvedTx(buyer.publicKey, buyer); // a different valid, signed Jupiter swap (new blockhash)
      for (const seal of [await sealOf(encoded, Keypair.generate().publicKey.toBase58()), await sealOf(encoded, undefined, "TSLAx"), await sealOf(other)]) {
        const { out, asked } = await relay({ tx: encoded, seal });
        assert.equal(out.status, 400);
        assert.match(String(out.body.error), refusedUnbuilt);
        assert.equal(asked.length, 0);
      }
    });

    it("refuses the built transaction re-signed after its route bytes were changed (higher amount)", async () => {
      const unsignedBuilt = approvedTx(buyer.publicKey);
      const seal = await sealOf(unsignedBuilt);
      const altered = VersionedTransaction.deserialize(Buffer.from(unsignedBuilt, "base64"));
      const r = altered.message.compiledInstructions.find((ix) => altered.message.staticAccountKeys[ix.programIdIndex]!.equals(JUP))!;
      new DataView(r.data.buffer, r.data.byteOffset).setBigUint64(r.data.length - 19, 99_000_000_000n, true); // in_amount
      altered.sign([buyer]);
      const { out, asked } = await relay({ tx: Buffer.from(altered.serialize()).toString("base64"), seal });
      assert.equal(out.status, 400);
      assert.match(String(out.body.error), refusedUnbuilt);
      assert.equal(asked.length, 0);
    });

    it("relays the sealed transaction once the buyer has signed it (signing does not change the message)", async () => {
      const unsignedBuilt = approvedTx(buyer.publicKey);
      const seal = await sealOf(unsignedBuilt);
      const t = VersionedTransaction.deserialize(Buffer.from(unsignedBuilt, "base64"));
      t.sign([buyer]);
      const sig = anchor.utils.bytes.bs58.encode(t.signatures[0]!);
      const { out } = await relay({ tx: Buffer.from(t.serialize()).toString("base64"), seal }, sig);
      assert.deepEqual(out.body, { signature: sig, status: "confirmed" });
    });

    it("refuses random nonzero bytes in the fee-payer signature slot (Codex fresh review MINOR)", async () => {
      const { encoded } = await signed();
      const forged = VersionedTransaction.deserialize(Buffer.from(encoded, "base64"));
      forged.signatures[0] = Uint8Array.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 251 || 1));
      const { out, asked } = await relay({ tx: Buffer.from(forged.serialize()).toString("base64"), seal: await sealOf(encoded) });
      assert.equal(out.status, 400);
      assert.match(String(out.body.error), /not signed by this wallet/);
      assert.equal(asked.length, 0);
    });

    it("relays the checked transaction re-serialized, never the request's raw bytes (B1 seal adversary)", async () => {
      const { encoded, signature } = await signed();
      const withJunk = Buffer.concat([Buffer.from(encoded, "base64"), Buffer.from([7, 7, 7])]).toString("base64");
      const { out, asked } = await relay({ tx: withJunk, seal: await sealOf(encoded) }, signature);
      assert.deepEqual(out.body, { signature, status: "confirmed" });
      const sent = JSON.parse(asked.find((a) => a.includes('"sendTransaction"'))!.slice(asked.find((a) => a.includes('"sendTransaction"'))!.indexOf("{"))) as { params: [string] };
      assert.equal(sent.params[0], encoded, "the RPC received the canonical bytes");
    });

    it("refuses a buyer that is not a plain string (an array would otherwise be coerced)", async () => {
      const { encoded } = await signed();
      const { out, asked } = await send({ tx: encoded, seal: await sealOf(encoded), user: [buyer.publicKey.toBase58()], lastValidBlockHeight: 999, symbol: "NVDAx" }, () => ({ body: { result: "x" } }));
      assert.equal(out.status, 400);
      assert.equal(asked.length, 0);
    });

    it("builds and relays nothing without the binding key (no unsealed fallback)", async () => {
      const saved = process.env.SWAP_BINDING_SECRET;
      delete process.env.SWAP_BINDING_SECRET;
      try {
        const { encoded } = await signed();
        const s = await relay({ tx: encoded, seal: "v1.1.x" });
        assert.equal(s.out.status, 503);
        assert.equal(s.asked.length, 0);
        const route = await import(pathToFileURL(resolve(SRC, "app/api/swap/route.ts")).href);
        const res = await route.POST(post({ symbol: "NVDAx", usdc: "50", user: buyer.publicKey.toBase58() }));
        assert.equal(res.status, 503);
      } finally {
        process.env.SWAP_BINDING_SECRET = saved;
      }
    });
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
    const { out } = await send({ tx: encoded, seal: await sealOf(encoded), user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx" }, (m) =>
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
      const { out } = await send({ tx: encoded, seal: await sealOf(encoded), user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx" }, () => ({ body: { error: { message: "blocked at https://rpc.example/?api-key=SECRET" } } }));
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
      const { out } = await send({ tx: encoded, seal: await sealOf(encoded), user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx" }, () => ({ body: { error: { message: "invalid api key abcdef0123456789SECRETKEY" } } }));
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
      const { out } = await send({ tx: encoded, seal: await sealOf(encoded), user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx" }, () => ({ body: { error: { message: "Transaction simulation failed: key ab12 rejected" } } }));
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
