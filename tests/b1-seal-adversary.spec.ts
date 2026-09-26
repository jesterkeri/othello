/**
 * B1 seal adversary pass: attacks on app/src/lib/swapSeal.ts, the fee-payer signature check in
 * app/src/lib/swap.ts (feePayerSignatureValid) and their use in app/src/app/api/swap/route.ts and
 * app/src/app/api/swap/send/route.ts. Transactions are built with web3.js's own compiler (the same
 * shape tests/app-swap.spec.ts uses for a Jupiter V6 `route`); the RPC is a local fetch stub.
 * Nothing is sent to any cluster.
 *
 * Contract used (the B1 brief):
 * 1. The relay sends only the exact message /api/swap sealed, for that buyer and symbol, within 120 s;
 *    a seal is not forgeable, not reusable for another buyer, symbol or message, and cannot extend
 *    its own lifetime.
 * 2. No SWAP_BINDING_SECRET (or one shorter than 32 characters): both routes refuse.
 * 3. "Signed by this wallet" means a valid Ed25519 signature by the fee payer over the message;
 *    anything else is refused before any RPC call.
 * 4. Fixed error words only; no provider text or key material echoed.
 */
import assert from "node:assert/strict";
import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as anchor from "@coral-xyz/anchor";

const { AddressLookupTableAccount, Keypair, MessageV0, PublicKey, TransactionInstruction, VersionedTransaction, Transaction } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

import { REPO } from "./artifacts.ts";

// B1: the Buy routes refuse to run without a binding key; this fixed value exists only in tests.
const TEST_SECRET = "test-only-binding-key-never-used-outside-tests-0000";
process.env.SWAP_BINDING_SECRET = TEST_SECRET;

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

const seal = () => import(pathToFileURL(resolve(SRC, "lib/swapSeal.ts")).href) as Promise<typeof import("../app/src/lib/swapSeal.ts")>;
const lib = () => import(pathToFileURL(resolve(SRC, "lib/swap.ts")).href) as Promise<typeof import("../app/src/lib/swap.ts")>;

const JUP = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const buyer = Keypair.generate();

function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA)[0];
}

/** Jupiter V6 `route` shaped like tests/app-swap.spec.ts approvedTx (IDL discriminator, empty plan, fixed tail). */
function routeIx(payer: PublicKey): InstanceType<typeof TransactionInstruction> {
  const tail = Buffer.alloc(19);
  tail.writeBigUInt64LE(1_000_000n, 0);
  tail.writeBigUInt64LE(133_885n, 8);
  tail.writeUInt16LE(100, 16);
  return new TransactionInstruction({
    programId: JUP,
    keys: [
      { pubkey: TOKEN_2022, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: ata(payer, USDC, TOKEN), isSigner: false, isWritable: true },
      { pubkey: ata(payer, new PublicKey(NVDAX), TOKEN_2022), isSigner: false, isWritable: true },
      { pubkey: JUP, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(NVDAX), isSigner: false, isWritable: false },
      { pubkey: JUP, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([229, 23, 203, 151, 122, 227, 173, 42]), Buffer.alloc(4), tail]),
  });
}

function v0(payer: PublicKey, blockhash = Keypair.generate().publicKey.toBase58(), tables: InstanceType<typeof AddressLookupTableAccount>[] = []) {
  return MessageV0.compile({ payerKey: payer, recentBlockhash: blockhash, instructions: [routeIx(payer)], addressLookupTableAccounts: tables });
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

type Answer = { status?: number; body: unknown };
async function withFetch<T>(answers: (method: string, url: string) => Answer, run: () => Promise<T>): Promise<{ out: T; asked: string[] }> {
  const asked: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    asked.push(`${String(url)} ${init?.body ?? ""}`);
    const a = answers(JSON.parse(String(init?.body ?? "{}")).method as string, String(url));
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    return { out: await run(), asked };
  } finally {
    globalThis.fetch = real;
  }
}
const post = (body: unknown) => ({ json: async () => body }) as never;
const confirmedAs = (sig: string) => (m: string): Answer =>
  m === "sendTransaction" ? { body: { result: sig } } : m === "getSignatureStatuses" ? { body: { result: { value: [{ err: null, confirmationStatus: "confirmed" }] } } } : { body: { result: 1 } };

async function relay(body: Record<string, unknown>, sig = "unused") {
  const route = await import(pathToFileURL(resolve(SRC, "app/api/swap/send/route.ts")).href);
  return withFetch(confirmedAs(sig), async () => {
    const res = await route.POST(post({ user: buyer.publicKey.toBase58(), lastValidBlockHeight: 999, symbol: "NVDAx", ...body }));
    return { status: res.status as number, body: (await res.json()) as Record<string, unknown> };
  });
}

async function sealFor(message: Uint8Array, who = buyer.publicKey.toBase58(), symbol = "NVDAx", now = Math.floor(Date.now() / 1000)) {
  return (await seal()).sealSwap({ message, buyer: who, symbol }, now)!;
}

const refusedUnbuilt = /not the swap Othello built for you, or it expired/;

describe("B1 seal adversary: seal string parsing", () => {
  const now = 1_800_000_000;
  const facts = () => ({ message: v0(buyer.publicKey, "11111111111111111111111111111111").serialize(), buyer: buyer.publicKey.toBase58(), symbol: "NVDAx" });

  it("refuses every malformed or non-string seal shape, without throwing", async () => {
    const { sealSwap, verifySeal } = await seal();
    const f = facts();
    const good = sealSwap(f, now)!;
    const [v, exp, mac] = good.split(".") as [string, string, string];
    const bad: unknown[] = [
      undefined, null, 0, 1, true, [], [good], { seal: good }, { toString: () => good }, "", ".", "..", "...",
      `${good}.`, `.${good}`, `${v}.${exp}.${mac}.${mac}`, `${v}..${exp}.${mac}`, `${v}.${exp}`, `${v}.${mac}`,
      `V1.${exp}.${mac}`, `v2.${exp}.${mac}`, ` ${v}.${exp}.${mac}`, `${v}. ${exp}.${mac}`, `${v}.${exp} .${mac}`,
      `${v}.-${exp}.${mac}`, `${v}.+${exp}.${mac}`, `${v}.${exp}.0.${mac}`, `${v}.${Number(exp)}e0.${mac}`, `${v}.0x${Number(exp).toString(16)}.${mac}`,
      `${v}.${exp.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)))}.${mac}`, // Arabic-Indic digits
      `${v}.${exp.replace(/\d/g, (d) => String.fromCharCode(0xff10 + Number(d)))}.${mac}`, // fullwidth digits
      `${v}.1${"0".repeat(12)}.${mac}`, `${v}.99999999999999999999.${mac}`, `${v}.${exp}.`, `${v}.${exp}.${mac.slice(0, -1)}`,
      `${v}.${exp}.${mac}AAAA`, `${v}.${exp}.${mac.slice(0, 20)}`, `${v}.${exp}.${"A".repeat(43)}`, `${v}.${exp}.${Buffer.from(mac, "base64url").toString("hex")}`,
      `${v}.${exp}.${mac.toUpperCase()}`, `${v}.${exp}.${mac.toLowerCase()}`, `${v}​.${exp}.${mac}`,
    ];
    for (const s of bad) {
      if (s === good) continue;
      // Case changes of the mac only matter if they change the bytes; skip a no-op variant.
      if (typeof s === "string" && s !== good && Buffer.from(s.split(".")[2] ?? "", "base64url").equals(Buffer.from(mac, "base64url")) && s.split(".")[1] === exp && s.split(".")[0] === v && s.split(".").length === 3) continue;
      assert.doesNotThrow(() => verifySeal(s, f, now));
      assert.equal(verifySeal(s, f, now), false, `accepted ${typeof s === "string" ? JSON.stringify(s) : typeof s}`);
    }
  });

  it("a textual variant of a real seal (leading zeros, base64 padding) authorises nothing beyond the original facts", async () => {
    const { sealSwap, verifySeal } = await seal();
    const f = facts();
    const good = sealSwap(f, now)!;
    const [v, exp, mac] = good.split(".") as [string, string, string];
    // Written against b0ba647, where Buffer.from(_, "base64url") let these variants verify. The seal now has
    // one exact spelling (verifySeal's regex), so each variant is refused even for the original facts.
    const variants = [`${v}.00${exp}.${mac}`, `${v}.${exp}.${mac}=`, `${v}.${exp}.${mac}\n`, `${v}.${exp}.${Buffer.from(mac, "base64url").toString("base64")}`];
    for (const s of variants) {
      if (s === good) continue; // the plain base64 form can coincide with base64url when the mac has no "-" or "_"
      assert.equal(verifySeal(s, f, now), false, `variant ${JSON.stringify(s)} still verifies`);
    }
    const other = Keypair.generate().publicKey.toBase58();
    for (const s of variants) {
      assert.equal(verifySeal(s, { ...f, buyer: other }, now), false);
      assert.equal(verifySeal(s, { ...f, symbol: "TSLAx" }, now), false);
      assert.equal(verifySeal(s, { ...f, message: v0(buyer.publicKey).serialize() }, now), false);
      assert.equal(verifySeal(s, f, now + 121), false);
    }
  });

  it("different-length macs are refused without timingSafeEqual throwing", async () => {
    const { sealSwap, verifySeal } = await seal();
    const f = facts();
    const [v, exp, mac] = sealSwap(f, now)!.split(".") as [string, string, string];
    for (const m of ["", "AA", mac.slice(0, 42), `${mac}AA`, Buffer.alloc(64).toString("base64url"), Buffer.alloc(31).toString("base64url")]) {
      assert.doesNotThrow(() => verifySeal(`${v}.${exp}.${m}`, f, now));
      assert.equal(verifySeal(`${v}.${exp}.${m}`, f, now), false);
    }
  });
});

describe("B1 seal adversary: expiry boundary and lifetime", () => {
  it("valid at issue and at issue+120, refused at issue+121 and before issue", async () => {
    const { sealSwap, verifySeal } = await seal();
    const now = 1_800_000_000;
    const f = { message: v0(buyer.publicKey).serialize(), buyer: buyer.publicKey.toBase58(), symbol: "NVDAx" };
    const s = sealSwap(f, now)!;
    assert.equal(verifySeal(s, f, now), true);
    assert.equal(verifySeal(s, f, now + 120), true);
    assert.equal(verifySeal(s, f, now + 121), false);
    assert.equal(verifySeal(s, f, now - 1), false, "a seal claiming more than 120 s of life (clock ran backwards) is refused");
    assert.equal(verifySeal(s, f, 0), false);
  });
  it("a seal cannot be re-dated: changing its expiry breaks the mac, even inside the window", async () => {
    const { sealSwap, verifySeal } = await seal();
    const now = 1_800_000_000;
    const f = { message: v0(buyer.publicKey).serialize(), buyer: buyer.publicKey.toBase58(), symbol: "NVDAx" };
    const [v, exp, mac] = sealSwap(f, now)!.split(".") as [string, string, string];
    for (const e of [Number(exp) - 1, Number(exp) + 1, Number(exp) + 60]) assert.equal(verifySeal(`${v}.${e}.${mac}`, f, now + 100), false);
  });
});

describe("B1 seal adversary: the message binding", () => {
  it("a v0 message differing only in its lookup-table section or header bytes has a different seal", async () => {
    const { sealSwap, verifySeal } = await seal();
    const now = Math.floor(Date.now() / 1000);
    const bh = Keypair.generate().publicKey.toBase58();
    const table = (key: PublicKey, addrs: PublicKey[]) => new AddressLookupTableAccount({ key, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addrs } });
    const lutAddrs = [new PublicKey(NVDAX), TOKEN_2022];
    const a = v0(buyer.publicKey, bh, [table(Keypair.generate().publicKey, lutAddrs)]).serialize();
    const b = v0(buyer.publicKey, bh, [table(Keypair.generate().publicKey, lutAddrs)]).serialize();
    const c = v0(buyer.publicKey, bh).serialize();
    assert.notDeepEqual(Buffer.from(a), Buffer.from(b));
    const f = { buyer: buyer.publicKey.toBase58(), symbol: "NVDAx" };
    const s = sealSwap({ ...f, message: a }, now)!;
    assert.equal(verifySeal(s, { ...f, message: a }, now), true);
    assert.equal(verifySeal(s, { ...f, message: b }, now), false, "other lookup table key");
    assert.equal(verifySeal(s, { ...f, message: c }, now), false, "no lookup table");
    for (const at of [1, 2, 3]) {
      const h = Buffer.from(a);
      h[at] = h[at]! ^ 1; // numRequiredSignatures / numReadonlySigned / numReadonlyUnsigned
      assert.equal(verifySeal(s, { ...f, message: h }, now), false, `header byte ${at}`);
    }
    const tail = Buffer.from(a);
    tail[tail.length - 1] = tail[tail.length - 1]! ^ 1; // last readonly lookup index
    assert.equal(verifySeal(s, { ...f, message: tail }, now), false, "lookup index");
  });

  it("the relay refuses a sealed lookup-table swap re-pointed at another table, before any RPC call", async () => {
    const bh = Keypair.generate().publicKey.toBase58();
    const table = (key: PublicKey) => new AddressLookupTableAccount({ key, state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [new PublicKey(NVDAX), TOKEN_2022] } });
    const sealed = v0(buyer.publicKey, bh, [table(Keypair.generate().publicKey)]);
    const swapped = new VersionedTransaction(v0(buyer.publicKey, bh, [table(Keypair.generate().publicKey)]));
    swapped.sign([buyer]);
    const { out, asked } = await relay({ tx: b64(swapped.serialize()), seal: await sealFor(sealed.serialize()) });
    assert.equal(out.status, 400);
    assert.match(String(out.body.error), refusedUnbuilt);
    assert.equal(asked.length, 0);
  });

  it("legacy and v0 messages round-trip byte for byte through deserialize and serialize", () => {
    const leg = new Transaction({ feePayer: buyer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(routeIx(buyer.publicKey));
    const legBytes = leg.serializeMessage();
    const legTx = VersionedTransaction.deserialize(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), legBytes]));
    assert.deepEqual(Buffer.from(legTx.message.serialize()), Buffer.from(legBytes));
    const m = v0(buyer.publicKey);
    assert.deepEqual(Buffer.from(VersionedTransaction.deserialize(new VersionedTransaction(m).serialize()).message.serialize()), Buffer.from(m.serialize()));
  });

  it("a legacy seal does not cover the same instructions re-encoded as v0, and vice versa", async () => {
    const bh = Keypair.generate().publicKey.toBase58();
    const leg = new Transaction({ feePayer: buyer.publicKey, recentBlockhash: bh }).add(routeIx(buyer.publicKey));
    leg.sign(buyer);
    const legB64 = b64(leg.serialize());
    const v = new VersionedTransaction(v0(buyer.publicKey, bh));
    v.sign([buyer]);
    const legSeal = await sealFor(leg.serializeMessage());
    const v0Seal = await sealFor(v.message.serialize());
    for (const [tx, s] of [[b64(v.serialize()), legSeal], [legB64, v0Seal]] as const) {
      const { out, asked } = await relay({ tx, seal: s });
      assert.equal(out.status, 400);
      assert.match(String(out.body.error), refusedUnbuilt);
      assert.equal(asked.length, 0);
    }
    // The legacy transaction relays under its own seal.
    const sig = anchor.utils.bytes.bs58.encode(leg.signature!);
    const { out } = await relay({ tx: legB64, seal: legSeal }, sig);
    assert.deepEqual(out.body, { signature: sig, status: "confirmed" });
  });
});

describe("B1 seal adversary: signature slots", () => {
  /** An Ed25519 signature by `kp` over `msg`, made with node:crypto from the keypair's 32-byte seed. */
  const signBy = (kp: Keypair, msg: Uint8Array) =>
    Uint8Array.from(cryptoSign(null, Buffer.from(msg), createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(kp.secretKey.slice(0, 32))]), format: "der", type: "pkcs8" })));

  it("refuses a valid signature by a different key in slot zero, before any RPC call", async () => {
    const t = new VersionedTransaction(v0(buyer.publicKey));
    const s = await sealFor(t.message.serialize());
    t.signatures[0] = signBy(Keypair.generate(), t.message.serialize());
    const { out, asked } = await relay({ tx: b64(t.serialize()), seal: s });
    assert.equal(out.status, 400);
    assert.match(String(out.body.error), /not signed by this wallet/);
    assert.equal(asked.length, 0);
  });

  it("refuses the buyer's signature over a different message (another blockhash), before any RPC call", async () => {
    const t = new VersionedTransaction(v0(buyer.publicKey));
    const s = await sealFor(t.message.serialize());
    t.signatures[0] = signBy(buyer, v0(buyer.publicKey).serialize());
    const { out, asked } = await relay({ tx: b64(t.serialize()), seal: s });
    assert.equal(out.status, 400);
    assert.match(String(out.body.error), /not signed by this wallet/);
    assert.equal(asked.length, 0);
  });

  it("refuses a signed transaction with an extra signature appended (count no longer matches the header)", async () => {
    const t = new VersionedTransaction(v0(buyer.publicKey));
    t.sign([buyer]);
    const s = await sealFor(t.message.serialize());
    const extra = Buffer.concat([Buffer.from([2]), Buffer.from(t.signatures[0]!), Buffer.from(signBy(buyer, t.message.serialize())), Buffer.from(t.message.serialize())]);
    const { out, asked } = await relay({ tx: b64(extra), seal: s });
    assert.equal(out.status, 400);
    assert.equal(asked.length, 0);
  });

  it("a seal for a one-signer message does not cover a two-signer version of it", async () => {
    const co = Keypair.generate();
    const one = v0(buyer.publicKey);
    const ix = routeIx(buyer.publicKey);
    ix.keys.push({ pubkey: co.publicKey, isSigner: true, isWritable: false });
    const two = new VersionedTransaction(MessageV0.compile({ payerKey: buyer.publicKey, recentBlockhash: one.recentBlockhash, instructions: [ix] }));
    two.sign([buyer, co]);
    const { out, asked } = await relay({ tx: b64(two.serialize()), seal: await sealFor(one.serialize()) });
    assert.equal(out.status, 400);
    assert.match(String(out.body.error), refusedUnbuilt);
    assert.equal(asked.length, 0);
  });

  it("refuses a keyless 'signature' for a small-order fee payer (no private key made it; Solana's verify_strict rejects it) before any RPC call", async () => {
    // The Ed25519 identity point, encoded as y = 1: a valid 32-byte Solana address with no usable private key.
    const identity = new PublicKey(Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]));
    // /api/swap itself issues the seal for this wallet (Jupiter stubbed with the documented route shape).
    const buildRoute = await import(pathToFileURL(resolve(SRC, "app/api/swap/route.ts")).href);
    const quote = { outputMint: NVDAX, outAmount: "220000000", otherAmountThreshold: "217800000", priceImpactPct: "0.001", routePlan: [] };
    const built = await withFetch(
      (_m, url) => (url.includes("/quote?") ? { body: quote } : { body: { swapTransaction: b64(new VersionedTransaction(v0(identity)).serialize()), lastValidBlockHeight: 123 } }),
      async () => (await buildRoute.POST(post({ symbol: "NVDAx", usdc: "50", user: identity.toBase58() }))).json() as Promise<{ tx: string; seal: string }>,
    );
    assert.equal(typeof built.out.seal, "string", "the build route sealed a swap for this wallet");
    const t = VersionedTransaction.deserialize(Buffer.from(built.out.tx, "base64"));
    // R = identity point, S = 0. The cofactorless equation [S]B = R + [k]A holds for every message
    // when A is the identity, so this "signature" needs no key and fits any message.
    t.signatures[0] = Uint8Array.from(Buffer.concat([Buffer.from([1]), Buffer.alloc(63)]));
    const s = built.out.seal;
    const sig = anchor.utils.bytes.bs58.encode(t.signatures[0]!);
    const { out, asked } = await relay({ tx: b64(t.serialize()), seal: s, user: identity.toBase58() }, sig);
    assert.equal(out.status, 400, `relayed a keyless signature: ${JSON.stringify(out.body)}; RPC calls: ${asked.map((a) => JSON.parse(a.slice(a.indexOf(" ") + 1)).method).join(",")}`);
    assert.match(String(out.body.error), /not signed by this wallet/);
    assert.equal(asked.length, 0);
  });
});

describe("B1 seal adversary: JSON body tricks on the relay", () => {
  it("refuses a seal passed as array, object, number or null, and a user or symbol spelled differently", async () => {
    const t = new VersionedTransaction(v0(buyer.publicKey));
    t.sign([buyer]);
    const tx = b64(t.serialize());
    const good = await sealFor(t.message.serialize());
    for (const body of [
      { tx, seal: [good] },
      { tx, seal: { seal: good } },
      { tx, seal: 1 },
      { tx, seal: null },
      { tx, seal: ` ${good}` },
      { tx, seal: good, user: ` ${buyer.publicKey.toBase58()}` },
      { tx, seal: good, user: `${buyer.publicKey.toBase58()} ` },
      { tx, seal: good, user: buyer.publicKey.toBase58().toLowerCase() },
      { tx, seal: good, symbol: "nvdax" },
      { tx, seal: good, symbol: "NVDAx " },
      { tx, seal: good, symbol: ["NVDAx"] },
    ]) {
      const { out, asked } = await relay(body);
      assert.equal(out.status, 400, `accepted ${JSON.stringify({ ...body, tx: undefined })}`);
      assert.equal(asked.length, 0);
    }
  });
});

describe("B1 seal adversary: the binding key", () => {
  const withSecret = async <T>(value: string | undefined, run: () => Promise<T>) => {
    const saved = process.env.SWAP_BINDING_SECRET;
    if (value === undefined) delete process.env.SWAP_BINDING_SECRET;
    else process.env.SWAP_BINDING_SECRET = value;
    try {
      return await run();
    } finally {
      process.env.SWAP_BINDING_SECRET = saved;
    }
  };

  it("both routes refuse with no key, an empty key, or a 31-character key, and echo no key", async () => {
    const t = new VersionedTransaction(v0(buyer.publicKey));
    t.sign([buyer]);
    const tx = b64(t.serialize());
    const good = await sealFor(t.message.serialize());
    const buildRoute = await import(pathToFileURL(resolve(SRC, "app/api/swap/route.ts")).href);
    for (const k of [undefined, "", "a".repeat(31), "SENTINELKEY".padEnd(31, "z")]) {
      await withSecret(k, async () => {
        const { sealConfigured, sealSwap, verifySeal } = await seal();
        assert.equal(sealConfigured(), false);
        assert.equal(sealSwap({ message: t.message.serialize(), buyer: buyer.publicKey.toBase58(), symbol: "NVDAx" }, Math.floor(Date.now() / 1000)), null);
        assert.equal(verifySeal(good, { message: t.message.serialize(), buyer: buyer.publicKey.toBase58(), symbol: "NVDAx" }, Math.floor(Date.now() / 1000)), false);
        const r = await relay({ tx, seal: good });
        assert.equal(r.out.status, 503);
        assert.equal(r.asked.length, 0);
        const b = await withFetch(() => ({ body: {} }), async () => {
          const res = await buildRoute.POST(post({ symbol: "NVDAx", usdc: "50", user: buyer.publicKey.toBase58() }));
          return { status: res.status as number, body: await res.json() };
        });
        assert.equal(b.out.status, 503);
        assert.equal(b.asked.length, 0);
        for (const body of [r.out.body, b.out.body]) assert.doesNotMatch(JSON.stringify(body), /SENTINEL|test-only-binding/);
      });
    }
  });

  it("refuses a key of 31 characters even when one of them is outside the Basic Multilingual Plane", async () => {
    // 30 ASCII characters and one emoji: 31 characters (code points), but String.length counts 32 UTF-16 units.
    const key = `${"k".repeat(30)}\u{1F511}`;
    assert.equal([...key].length, 31);
    await withSecret(key, async () => {
      const { sealConfigured } = await seal();
      assert.equal(sealConfigured(), false, "a 31-character key was accepted as a binding key");
    });
  });

  it("a seal made under one key is refused under another", async () => {
    const t = new VersionedTransaction(v0(buyer.publicKey));
    t.sign([buyer]);
    const good = await sealFor(t.message.serialize());
    await withSecret("another-test-only-binding-key-0000000000", async () => {
      const { out, asked } = await relay({ tx: b64(t.serialize()), seal: good });
      assert.equal(out.status, 400);
      assert.equal(asked.length, 0);
    });
  });

  it("a seal carries no key material, and a refused relay echoes neither the key nor the seal", async () => {
    const t = new VersionedTransaction(v0(buyer.publicKey));
    t.sign([buyer]);
    const good = await sealFor(t.message.serialize());
    assert.doesNotMatch(good, /test-only|binding/);
    const [v, exp, mac] = good.split(".") as [string, string, string];
    const { out } = await relay({ tx: b64(t.serialize()), seal: `${v}.${exp}.${mac.slice(1)}A` });
    assert.equal(out.status, 400);
    assert.doesNotMatch(JSON.stringify(out.body), new RegExp(`${TEST_SECRET}|${mac.slice(2, 20).replace(/[-_]/g, ".")}|${exp}`));
  });
});
