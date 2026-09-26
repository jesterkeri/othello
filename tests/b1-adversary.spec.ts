/**
 * B1 adversary pass: attacks on the Jupiter output binding (app/src/lib/swap.ts checkSwapAccounts,
 * resolveKeys, signedTransactionSignature) and on the relay's signature handling
 * (app/src/app/api/swap/send/route.ts). Mutations of the real fixture are rebuilt as real v0
 * transactions through the fixture's own lookup table, with web3.js's compiler, so the account
 * indexes the checker sees are the ones a wallet would sign. Nothing is sent to any cluster.
 *
 * Jupiter semantics used below, with provenance:
 * - Route account order: Jupiter's published V6 IDL,
 *   https://github.com/jup-ag/instruction-parser/blob/main/src/idl/jupiter.ts (fetched 2026-09-26):
 *   tokenProgram, userTransferAuthority, userSourceTokenAccount, userDestinationTokenAccount,
 *   destinationTokenAccount (isOptional), destinationMint, platformFeeAccount (isOptional).
 * - What destinationTokenAccount means: Jupiter's Swap API v1 OpenAPI,
 *   https://developers.jup.ag/docs/openapi-spec/swap/swap.yaml lines 465-473 (fetched 2026-09-26):
 *   "Public key of a token account that will be used to receive the token out of the swap.
 *   If not provided, the signer's token account will be used."
 *   An absent Anchor optional account is encoded as the program id itself, which is what the real
 *   fixture carries in that slot (JUP6...).
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as anchor from "@coral-xyz/anchor";

const { AddressLookupTableAccount, Keypair, MessageV0, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;
type VersionedTransaction = anchor.web3.VersionedTransaction;
type TransactionInstruction = anchor.web3.TransactionInstruction;
type AddressLookupTableAccount = anchor.web3.AddressLookupTableAccount;

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

const lib = () => import(pathToFileURL(resolve(SRC, "lib/swap.ts")).href) as Promise<typeof import("../app/src/lib/swap.ts")>;

const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SYSTEM = new PublicKey("11111111111111111111111111111111");
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const NVDAX = new PublicKey("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh");

function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
}
/** The fixed argument tail of a real Jupiter V6 route (1 USDC in, positive quote, slippage 100, no fee). */
function realTail(): Buffer {
  const t = Buffer.alloc(19);
  t.writeBigUInt64LE(1_000_000n, 0);
  t.writeBigUInt64LE(133_885n, 8);
  t.writeUInt16LE(100, 16);
  return t;
}

function anchorDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

/* ------------------------------------------------------------------------- *
 * The real fixture, decompiled through its real lookup table.
 * ------------------------------------------------------------------------- */

const fx = JSON.parse(readFileSync(resolve(REPO, "tests/fixtures/jup-swap-qqqx.json"), "utf8")) as { user: string; outputMint: string; swapTransaction: string; lookupTables: Record<string, string> };
const USER = new PublicKey(fx.user);
const QQQX = new PublicKey(fx.outputMint);
const tableBytes = Object.fromEntries(Object.entries(fx.lookupTables).map(([k, v]) => [k, Uint8Array.from(Buffer.from(v, "base64"))]));
const luts: AddressLookupTableAccount[] = Object.entries(tableBytes).map(([k, v]) => new AddressLookupTableAccount({ key: new PublicKey(k), state: AddressLookupTableAccount.deserialize(v) }));
const original = VersionedTransaction.deserialize(Buffer.from(fx.swapTransaction, "base64"));

function decompiled(): { payerKey: PublicKey; recentBlockhash: string; instructions: TransactionInstruction[] } {
  const m = TransactionMessage.decompile(original.message, { addressLookupTableAccounts: luts });
  return { payerKey: m.payerKey, recentBlockhash: m.recentBlockhash, instructions: m.instructions };
}
function rebuild(instructions: TransactionInstruction[]): VersionedTransaction {
  const d = decompiled();
  return new VersionedTransaction(MessageV0.compile({ payerKey: d.payerKey, recentBlockhash: d.recentBlockhash, instructions, addressLookupTableAccounts: luts }));
}
function cloneIx(ix: TransactionInstruction, edit: (keys: TransactionInstruction["keys"]) => void, data?: Buffer): TransactionInstruction {
  const keys = ix.keys.map((k) => ({ ...k }));
  edit(keys);
  return new TransactionInstruction({ programId: ix.programId, keys, data: data ?? Buffer.from(ix.data) });
}
async function verdict(t: VersionedTransaction, payer = fx.user, mint = fx.outputMint): Promise<string | null> {
  const { checkSwapTx, resolveKeys, checkSwapAccounts } = await lib();
  const b64 = Buffer.from(t.serialize()).toString("base64");
  const c = checkSwapTx(b64, payer, false);
  if (!c.ok) return `checkSwapTx: ${c.reason}`;
  const keys = resolveKeys(c.tx, tableBytes);
  if (!keys) return "resolveKeys: null";
  return checkSwapAccounts(c.tx, keys, payer, mint);
}
const isJup = (ix: TransactionInstruction) => ix.programId.equals(JUP);
const isAta = (ix: TransactionInstruction) => ix.programId.equals(ATA_PROGRAM);

/** Route with one account slot replaced; every other instruction untouched. */
function withRouteSlot(slot: number, pubkey: PublicKey, isWritable = true): VersionedTransaction {
  return rebuild(decompiled().instructions.map((ix) => (isJup(ix) ? cloneIx(ix, (k) => { k[slot] = { pubkey, isSigner: false, isWritable }; }) : ix)));
}

describe("B1 adversary: control, the rebuild harness is faithful", () => {
  it("the fixture rebuilt through its own lookup table still passes every check", async () => {
    assert.equal(await verdict(original), null, "original fixture");
    assert.equal(await verdict(rebuild(decompiled().instructions)), null, "rebuilt fixture");
  });
  it("the fixture's optional destinationTokenAccount slot (4) is the Jupiter program id, i.e. None", () => {
    const route = decompiled().instructions.find(isJup)!;
    assert.ok(route.keys[4]!.pubkey.equals(JUP));
    assert.ok(route.keys[3]!.pubkey.equals(ata(USER, QQQX, TOKEN_2022)));
  });
});

describe("B1 adversary: route output binding", () => {
  const thief = Keypair.generate().publicKey;

  it("refuses a route whose destinationTokenAccount (IDL slot 4, the account that receives the output) is another owner's QQQx ATA", async () => {
    // userDestinationTokenAccount (slot 3) stays the buyer's ATA and destinationMint stays QQQx, so
    // only the optional output account is redirected.
    const t = withRouteSlot(4, ata(thief, QQQX, TOKEN_2022));
    assert.notEqual(await verdict(t), null, "output redirected to another owner's token account was accepted");
  });

  it("refuses userDestinationTokenAccount = another owner's QQQx ATA", async () => {
    assert.match(String(await verdict(withRouteSlot(3, ata(thief, QQQX, TOKEN_2022)))), /does not send the listed stock/);
  });
  it("refuses userDestinationTokenAccount = the buyer's QQQx ATA under classic SPL Token", async () => {
    assert.match(String(await verdict(withRouteSlot(3, ata(USER, QQQX, TOKEN)))), /does not send the listed stock/);
  });
  it("refuses destinationMint swapped to another listed xStock", async () => {
    assert.match(String(await verdict(withRouteSlot(5, NVDAX, false))), /does not send the listed stock/);
  });
  it("refuses tokenProgram swapped to classic SPL Token", async () => {
    assert.match(String(await verdict(withRouteSlot(0, TOKEN, false))), /does not send the listed stock/);
  });
  it("refuses userSourceTokenAccount = another owner's USDC ATA", async () => {
    assert.match(String(await verdict(withRouteSlot(2, ata(thief, USDC, TOKEN)))), /does not send the listed stock/);
  });
  it("refuses userTransferAuthority = someone else", async () => {
    assert.match(String(await verdict(withRouteSlot(1, thief, false))), /does not send the listed stock/);
  });
  it("refuses QQQx present only in a remaining account, with another mint as destinationMint", async () => {
    const t = rebuild(decompiled().instructions.map((ix) => (isJup(ix) ? cloneIx(ix, (k) => {
      k[5] = { pubkey: NVDAX, isSigner: false, isWritable: false };
      k.push({ pubkey: QQQX, isSigner: false, isWritable: false });
    }) : ix)));
    assert.match(String(await verdict(t)), /does not send the listed stock/);
  });
  it("refuses a truncated route with only five accounts", async () => {
    const t = rebuild(decompiled().instructions.map((ix) => (isJup(ix) ? cloneIx(ix, (k) => { k.splice(5); }) : ix)));
    assert.notEqual(await verdict(t), null);
  });
});

describe("B1 adversary: only the mapped Jupiter variant", () => {
  for (const name of ["shared_accounts_route", "route_with_token_ledger", "exact_out_route", "shared_accounts_exact_out_route", "shared_accounts_route_with_token_ledger", "set_token_ledger", "create_token_ledger"]) {
    it(`refuses ${name} with the route's accounts`, async () => {
      const t = rebuild(decompiled().instructions.map((ix) => (isJup(ix) ? cloneIx(ix, () => {}, Buffer.concat([anchorDiscriminator(name), Buffer.from(ix.data).subarray(8)])) : ix)));
      assert.match(String(await verdict(t)), /unsupported Jupiter instruction/);
    });
  }
  it("the route discriminator the code accepts is Anchor's global:route", () => {
    assert.equal(anchorDiscriminator("route").toString("hex"), "e517cb977ae3ad2a");
  });
  it("refuses a Jupiter instruction with a 7-byte prefix of the route discriminator", async () => {
    const t = rebuild(decompiled().instructions.map((ix) => (isJup(ix) ? cloneIx(ix, () => {}, anchorDiscriminator("route").subarray(0, 7)) : ix)));
    assert.match(String(await verdict(t)), /unsupported Jupiter instruction/);
  });
  it("refuses a second Jupiter instruction, even a harmless-looking one", async () => {
    const ixs = decompiled().instructions;
    const t = rebuild([...ixs, new TransactionInstruction({ programId: JUP, keys: [], data: anchorDiscriminator("create_token_ledger") })]);
    assert.match(String(await verdict(t)), /not a single Jupiter swap/);
  });
});

describe("B1 adversary: Associated Token creates", () => {
  const stranger = Keypair.generate().publicKey;
  const create = (payer: PublicKey, account: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey, idempotent: boolean, extra: PublicKey[] = []) =>
    new TransactionInstruction({
      programId: ATA_PROGRAM,
      keys: [
        { pubkey: payer, isSigner: payer.equals(USER), isWritable: true },
        { pubkey: account, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SYSTEM, isSigner: false, isWritable: false },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
        ...extra.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
      ],
      data: idempotent ? Buffer.from([1]) : Buffer.alloc(0),
    });
  const withCreate = (c: TransactionInstruction) => rebuild([c, ...decompiled().instructions]);

  it("accepts the buyer's own USDC input ATA create, idempotent or not", async () => {
    assert.equal(await verdict(withCreate(create(USER, ata(USER, USDC, TOKEN), USER, USDC, TOKEN, true))), null);
    assert.equal(await verdict(withCreate(create(USER, ata(USER, USDC, TOKEN), USER, USDC, TOKEN, false))), null);
  });
  it("refuses the output ATA created under classic SPL Token", async () => {
    assert.match(String(await verdict(withCreate(create(USER, ata(USER, QQQX, TOKEN), USER, QQQX, TOKEN, true)))), /other than the buyer's input or output ATA/);
  });
  it("refuses the USDC ATA created under Token-2022", async () => {
    assert.match(String(await verdict(withCreate(create(USER, ata(USER, USDC, TOKEN_2022), USER, USDC, TOKEN_2022, true)))), /other than the buyer's input or output ATA/);
  });
  it("refuses a create for another owner's QQQx ATA", async () => {
    assert.match(String(await verdict(withCreate(create(USER, ata(stranger, QQQX, TOKEN_2022), stranger, QQQX, TOKEN_2022, true)))), /other than the buyer's input or output ATA/);
  });
  it("refuses a create paid by someone other than the buyer", async () => {
    assert.match(String(await verdict(withCreate(create(stranger, ata(USER, QQQX, TOKEN_2022), USER, QQQX, TOKEN_2022, true)))), /other than the buyer's input or output ATA/);
  });
  it("refuses the buyer's ATA address with a different owner field", async () => {
    assert.match(String(await verdict(withCreate(create(USER, ata(USER, QQQX, TOKEN_2022), stranger, QQQX, TOKEN_2022, true)))), /other than the buyer's input or output ATA/);
  });
  it("refuses a create for an unrelated mint, and one with a seventh account", async () => {
    assert.match(String(await verdict(withCreate(create(USER, ata(USER, NVDAX, TOKEN_2022), USER, NVDAX, TOKEN_2022, true)))), /other than the buyer's input or output ATA/);
    assert.match(String(await verdict(withCreate(create(USER, ata(USER, USDC, TOKEN), USER, USDC, TOKEN, true, [stranger])))), /other than the buyer's input or output ATA/);
  });
  it("refuses RecoverNested (2) and trailing bytes after the create tag", async () => {
    const c = create(USER, ata(USER, USDC, TOKEN), USER, USDC, TOKEN, true);
    assert.match(String(await verdict(withCreate(new TransactionInstruction({ programId: ATA_PROGRAM, keys: c.keys, data: Buffer.from([2]) })))), /does more than a Jupiter swap/);
    assert.match(String(await verdict(withCreate(new TransactionInstruction({ programId: ATA_PROGRAM, keys: c.keys, data: Buffer.from([1, 0]) })))), /does more than a Jupiter swap/);
  });
});

describe("B1 adversary: lookup-table resolution order", () => {
  it("resolveKeys matches web3.js's own v0 key order across two tables (writable of all tables, then readonly)", async () => {
    const { resolveKeys } = await lib();
    const payer = Keypair.generate();
    const mk = (n: number) => Array.from({ length: n }, () => Keypair.generate().publicKey);
    const addrA = mk(6);
    const addrB = mk(6);
    const lut = (key: PublicKey, addresses: PublicKey[]) => {
      const bytes = Buffer.alloc(56 + 32 * addresses.length);
      bytes.writeUInt32LE(1, 0);
      bytes.writeBigUInt64LE(0xffffffffffffffffn, 4);
      addresses.forEach((a, i) => a.toBuffer().copy(bytes, 56 + 32 * i));
      return { bytes: Uint8Array.from(bytes), account: new AddressLookupTableAccount({ key, state: AddressLookupTableAccount.deserialize(Uint8Array.from(bytes)) }) };
    };
    const A = lut(Keypair.generate().publicKey, addrA);
    const B = lut(Keypair.generate().publicKey, addrB);
    const ix = new TransactionInstruction({
      programId: JUP,
      keys: [addrA[4]!, addrB[0]!, addrA[1]!, addrB[5]!, addrA[2]!, addrB[3]!].map((pubkey, i) => ({ pubkey, isSigner: false, isWritable: i % 2 === 0 })),
      data: Buffer.from([0]),
    });
    const t = new VersionedTransaction(MessageV0.compile({ payerKey: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [ix], addressLookupTableAccounts: [A.account, B.account] }));
    assert.equal(t.message.addressTableLookups.length, 2);
    const ours = resolveKeys(t, { [A.account.key.toBase58()]: A.bytes, [B.account.key.toBase58()]: B.bytes });
    const theirs = t.message.getAccountKeys({ addressLookupTableAccounts: [A.account, B.account] });
    assert.deepEqual(ours, [...theirs.staticAccountKeys, ...theirs.accountKeysFromLookups!.writable, ...theirs.accountKeysFromLookups!.readonly].map((k) => k.toBase58()));
  });
  it("resolveKeys refuses a table that is missing or shorter than an index it needs", async () => {
    const { resolveKeys } = await lib();
    assert.equal(resolveKeys(original, {}), null);
    const [k, v] = Object.entries(tableBytes)[0]!;
    assert.equal(resolveKeys(original, { [k]: v.subarray(0, 56 + 32 * 20) }), null);
  });
});

describe("B1 adversary: signature derivation", () => {
  it("signedTransactionSignature is canonical base58 for random 64-byte signatures, with and without leading zero bytes", async () => {
    const { signedTransactionSignature } = await lib();
    const payer = Keypair.generate();
    const msg = MessageV0.compile({ payerKey: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [] });
    for (let lead = 0; lead <= 3; lead++) {
      for (let n = 0; n < 50; n++) {
        const sig = Uint8Array.from(randomBytes(64));
        for (let i = 0; i < lead; i++) sig[i] = 0;
        if (sig.every((b) => b === 0)) continue;
        const t = new VersionedTransaction(msg, [sig]);
        assert.equal(signedTransactionSignature(t), anchor.utils.bytes.bs58.encode(sig));
      }
    }
    assert.equal(signedTransactionSignature(new VersionedTransaction(msg, [new Uint8Array(64)])), null);
  });
});

/* ------------------------------------------------------------------------- *
 * The relay route, with the RPC mocked.
 * ------------------------------------------------------------------------- */

type Answer = { status?: number; body: unknown };
async function withFetch<T>(answers: (method: string) => Answer, run: () => Promise<T>): Promise<{ out: T; methods: string[] }> {
  const methods: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const method = JSON.parse(String(init?.body ?? "{}")).method as string;
    methods.push(method);
    const a = answers(method);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return { out: await run(), methods };
  } finally {
    globalThis.fetch = real;
  }
}
const post = (body: unknown) => ({ json: async () => body }) as never;

/** A statically keyed `route` for NVDAx, bound to the buyer, signed by the buyer (no lookup table). */
function signedRoute(buyer: Keypair, sign = true): VersionedTransaction {
  const route = new TransactionInstruction({
    programId: JUP,
    keys: [
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
      { pubkey: buyer.publicKey, isSigner: true, isWritable: false },
      { pubkey: ata(buyer.publicKey, USDC, TOKEN), isSigner: false, isWritable: true },
      { pubkey: ata(buyer.publicKey, NVDAX, TOKEN_2022), isSigner: false, isWritable: true },
      { pubkey: JUP, isSigner: false, isWritable: false },
      { pubkey: NVDAX, isSigner: false, isWritable: false },
      { pubkey: JUP, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([anchorDiscriminator("route"), Buffer.alloc(4), realTail()]),
  });
  const t = new VersionedTransaction(MessageV0.compile({ payerKey: buyer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [route] }));
  if (sign) t.sign([buyer]);
  return t;
}

describe("B1 adversary: /api/swap/send signature handling", () => {
  const buyer = Keypair.generate();
  const send = async (t: VersionedTransaction, rpc: (method: string) => Answer) => {
    const route = await import(pathToFileURL(resolve(SRC, "app/api/swap/send/route.ts")).href);
    return withFetch(rpc, async () => {
      // B1: the relay now also requires /api/swap's seal over this exact message; these attacks are about
      // what happens after that check, so each transaction carries a valid seal.
      const { sealSwap } = (await import(pathToFileURL(resolve(SRC, "lib/swapSeal.ts")).href)) as typeof import("../app/src/lib/swapSeal.ts");
      const seal = sealSwap({ message: t.message.serialize(), buyer: buyer.publicKey.toBase58(), symbol: "NVDAx" }, Math.floor(Date.now() / 1000));
      const res = await route.POST(post({ tx: Buffer.from(t.serialize()).toString("base64"), seal, user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx" }));
      return { status: res.status as number, body: (await res.json()) as Record<string, unknown> };
    });
  };
  const derived = (t: VersionedTransaction) => anchor.utils.bytes.bs58.encode(t.signatures[0]!);

  for (const [label, result] of [
    ["a number", 42],
    ["null", null],
    ["an object carrying the right signature", { signature: "X" }],
    ["the right signature with trailing whitespace", " "],
    ["another valid-looking signature", anchor.utils.bytes.bs58.encode(randomBytes(64))],
  ] as const) {
    it(`returns only fixed words when the RPC answers ${label}`, async () => {
      const t = signedRoute(buyer);
      const sig = derived(t);
      const reply = label === "an object carrying the right signature" ? { signature: sig } : label === "the right signature with trailing whitespace" ? `${sig} ` : result;
      const { out, methods } = await send(t, () => ({ body: { result: reply } }));
      assert.equal(out.status, 502);
      assert.deepEqual(out.body, { error: "sendTransaction: the network returned a different signature" });
      assert.deepEqual(methods, ["sendTransaction"], "no status polling after a mismatch");
    });
  }

  it("on success returns exactly { signature, status } with the signature derived from the bytes", async () => {
    const t = signedRoute(buyer);
    const sig = derived(t);
    const { out } = await send(t, (m) => (m === "sendTransaction" ? { body: { result: sig } } : m === "getSignatureStatuses" ? { body: { result: { value: [{ err: null, confirmationStatus: "finalized", extra: "PROVIDER" }] } } } : { body: { result: 1 } }));
    assert.deepEqual(out.body, { signature: sig, status: "confirmed" });
  });

  it("relays nothing with an all-zero fee-payer signature", async () => {
    const t = signedRoute(buyer, false);
    const { out, methods } = await send(t, () => ({ body: { result: "x" } }));
    assert.equal(out.status, 400);
    assert.equal(methods.length, 0);
  });

  it("relays nothing when only a second signer signed and the fee payer's slot is zero", async () => {
    const other = Keypair.generate();
    const route = new TransactionInstruction({
      programId: JUP,
      keys: [...signedRoute(buyer, false).message.compiledInstructions[0]!.accountKeyIndexes.map(() => ({ pubkey: JUP, isSigner: false, isWritable: false })), { pubkey: other.publicKey, isSigner: true, isWritable: false }],
      data: Buffer.concat([anchorDiscriminator("route"), Buffer.alloc(4), realTail()]),
    });
    const t = new VersionedTransaction(MessageV0.compile({ payerKey: buyer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [route] }));
    t.sign([other]);
    assert.ok(t.signatures[1]!.some((b) => b !== 0) && t.signatures[0]!.every((b) => b === 0));
    const { out, methods } = await send(t, () => ({ body: { result: "x" } }));
    assert.equal(out.status, 400);
    assert.equal(methods.length, 0);
  });

  it("relays nothing whose route sends the output to another owner's account via destinationTokenAccount", async () => {
    const thief = Keypair.generate().publicKey;
    const base = signedRoute(buyer, false);
    const ix = TransactionMessage.decompile(base.message).instructions[0]!;
    const redirected = cloneIx(ix, (k) => { k[4] = { pubkey: ata(thief, NVDAX, TOKEN_2022), isSigner: false, isWritable: true }; });
    const t = new VersionedTransaction(MessageV0.compile({ payerKey: buyer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [redirected] }));
    t.sign([buyer]);
    const { out, methods } = await send(t, (m) => (m === "sendTransaction" ? { body: { result: derived(t) } } : { body: { result: { value: [{ err: null, confirmationStatus: "confirmed" }] } } }));
    assert.equal(out.status, 400, `relay answered ${JSON.stringify(out.body)}`);
    assert.equal(methods.includes("sendTransaction"), false, "the redirected swap reached sendTransaction");
  });

  it("never echoes RPC error text, including a planted sentinel", async () => {
    const t = signedRoute(buyer);
    const { out } = await send(t, () => ({ body: { error: { message: `SENTINEL_b1adv ${derived(t)}` } } }));
    assert.doesNotMatch(JSON.stringify(out.body), /SENTINEL_b1adv/);
    assert.match(String(out.body.error), /^sendTransaction: /);
  });

  it("never echoes a status error object's text", async () => {
    const t = signedRoute(buyer);
    const sig = derived(t);
    const { out } = await send(t, (m) => (m === "sendTransaction" ? { body: { result: sig } } : { body: { result: { value: [{ err: { SENTINEL_b1adv: "leak" } }] } } }));
    assert.doesNotMatch(JSON.stringify(out.body), /SENTINEL_b1adv|leak/);
    assert.deepEqual(out.body, { signature: sig, status: "failed", error: "the swap failed on chain" });
  });
});
