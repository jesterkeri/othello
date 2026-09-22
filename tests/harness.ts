/**
 * Shared bankrun harness for the gate-1 instruction tests.
 *
 * bankrun rather than LiteSVM, per P1: the npm `litesvm` bindings abort this
 * install with std::bad_alloc shortly after the first transaction that invokes
 * a loaded program. See DONE.md P1 for the measurements.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as anchor from "@coral-xyz/anchor";

import { assertFresh, DEPLOY_DIR, PROGRAM_IDL, PROGRAM_SO, REPO } from "./artifacts.ts";

// Read inside startAnchor, so setting them at import time is early enough.
process.env.BPF_OUT_DIR = resolve(REPO, DEPLOY_DIR);
process.env.RUST_LOG = process.env.RUST_LOG ?? "off";

const { startAnchor, Clock } = await import("solana-bankrun");
const { BankrunProvider } = await import("anchor-bankrun");

export { Clock };

/**
 * `BN` is re-exported from bn.js and the ESM interop does not surface it as a
 * named export, only on the CJS default. bn.js is not a direct dependency, so
 * reaching it through the default is the honest route rather than adding one.
 *
 * Exported from here because four specs had their own copy and they had already
 * drifted: two typed the argument `number`, two `number | string`.
 */
export const { BN } = (
  anchor as unknown as { default: { BN: new (value: number | string) => unknown } }
).default;

/** SPEC §9b.1: NFLXx multiplier 1 -> newMultiplier 10 at this second. */
export const SPLIT_AT = 1_763_337_300;
export const BEFORE_SPLIT = SPLIT_AT - 1;

/** Multipliers, fixed x1e9 (SPEC §4). */
export const ONE_X = 1_000_000_000;
export const TEN_X = 10_000_000_000;

/** USDC base units, 6 dp. */
export const USDC = 1_000_000;
/** Raw base units in one whole token, 8 dp (SPEC §4). */
export const RAW_PER_TOKEN = 100_000_000n;

/** `PriceStamp`, as the Anchor client encodes a Rust enum variant. */
export const CURRENT = { current: {} };
export const SCHEDULED = { scheduled: {} };

export type BigNumber = { toNumber(): number };

export type PriceFeedState = {
  authority: anchor.web3.PublicKey;
  stockMint: anchor.web3.PublicKey;
  wrapperPrice: BigNumber;
  sharePrice: BigNumber;
  pricedForMultiplier: BigNumber;
  updatedAt: BigNumber;
};

export type QuotedValuation = {
  multFixed: bigint;
  fund: bigint;
  exec: bigint;
  h: bigint;
  computeUnits: bigint;
};

/** SPEC §9b.1. The real mint, at its real mainnet address. */
export const FIXTURE_MINTS = {
  AAPLx: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
  NFLXx: "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL",
  SPYx: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
  NVDAx: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
} as const;

export type FixtureSymbol = keyof typeof FIXTURE_MINTS;

export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

type Fixture = { address: string; owner: string; dataLen: number; dataBase64: string };

export function fixture(symbol: FixtureSymbol): Fixture {
  const parsed = JSON.parse(
    readFileSync(resolve(REPO, `tests/fixtures/${symbol}.json`), "utf8"),
  ) as Fixture;

  assert.equal(parsed.address, FIXTURE_MINTS[symbol], `${symbol} fixture is not the SPEC 9b.1 mint`);
  assert.equal(parsed.owner, TOKEN_2022_PROGRAM, `${symbol} fixture is not owned by Token-2022`);

  return parsed;
}

export type Harness = {
  context: Awaited<ReturnType<typeof startAnchor>>;
  program: anchor.Program<anchor.Idl>;
  authority: anchor.web3.Keypair;
  setClock: (unixTimestamp: number) => Promise<void>;
  fund: (lamports?: number) => anchor.web3.Keypair;
  placeMint: (symbol: FixtureSymbol, at?: anchor.web3.PublicKey) => void;
  /** The refusal code name a rejected instruction carried. */
  refusal: (promise: Promise<unknown>) => Promise<string>;
};

/** Starts bankrun with the program loaded and the named real mints in place. */
export async function harness(mints: FixtureSymbol[]): Promise<Harness> {
  // bankrun loads target/deploy/othello.so, so these specs are exactly as
  // trustworthy as that file is current. Running one spec on its own used to
  // skip this and could test bytes that no longer matched the source.
  assertFresh(PROGRAM_SO);
  assertFresh(PROGRAM_IDL);

  const context = await startAnchor(REPO, [], []);
  const provider = new BankrunProvider(context);
  const idl = JSON.parse(readFileSync(resolve(REPO, PROGRAM_IDL), "utf8")) as anchor.Idl & {
    address: string;
  };
  const program = new anchor.Program(idl, provider);

  /**
   * Places a fixture's real bytes at an address.
   *
   * `at` defaults to the mint's own mainnet address. Passing a different one is
   * how the counterfeit case is built: byte-identical to a real xStock, sitting
   * somewhere else, which is exactly what ADR-012's allowlist exists to refuse.
   */
  const placeMint = (symbol: FixtureSymbol, at?: anchor.web3.PublicKey): void => {
    const source = fixture(symbol);
    const data = Buffer.from(source.dataBase64, "base64");

    assert.equal(data.length, source.dataLen, `${symbol}: dataBase64 does not decode to dataLen`);

    context.setAccount(at ?? new anchor.web3.PublicKey(source.address), {
      lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
      data,
      owner: new anchor.web3.PublicKey(source.owner),
      executable: false,
    });
  };

  for (const symbol of mints) {
    placeMint(symbol);
  }

  const fund = (lamports = anchor.web3.LAMPORTS_PER_SOL): anchor.web3.Keypair => {
    const keypair = anchor.web3.Keypair.generate();

    context.setAccount(keypair.publicKey, {
      lamports,
      data: Buffer.alloc(0),
      owner: anchor.web3.SystemProgram.programId,
      executable: false,
    });

    return keypair;
  };

  const setClock = async (unixTimestamp: number): Promise<void> => {
    const current = await context.banksClient.getClock();

    context.setClock(
      new Clock(
        current.slot,
        current.epochStartTimestamp,
        current.epoch,
        current.leaderScheduleEpoch,
        BigInt(unixTimestamp),
      ),
    );
  };

  // Resolved from the BUILT IDL, not from a hand-written table, so a renamed or
  // renumbered refusal shows up as a test failure rather than as a silent pass.
  const errorNames = new Map<number, string>(
    ((idl as { errors?: { code: number; name: string }[] }).errors ?? []).map((e) => [
      e.code,
      e.name,
    ]),
  );

  const refusal = async (promise: Promise<unknown>): Promise<string> => {
    try {
      await promise;
    } catch (thrown) {
      // `.rpc()` through the provider throws a decoded AnchorError.
      const decoded = (thrown as { error?: { errorCode?: { code?: string } } }).error?.errorCode
        ?.code;

      if (decoded) {
        return decoded;
      }

      // banksClient.processTransaction throws the raw program error instead.
      const raw = /custom program error: 0x([0-9a-f]+)/i.exec(String(thrown));

      if (raw?.[1]) {
        const code = Number.parseInt(raw[1], 16);

        return errorNames.get(code) ?? `unmapped custom program error ${code}`;
      }

      return String(thrown);
    }

    throw new Error("expected the instruction to be refused, but it succeeded");
  };

  return {
    context,
    program,
    authority: fund(100 * anchor.web3.LAMPORTS_PER_SOL),
    setClock,
    fund,
    placeMint,
    refusal,
  };
}

/**
 * A typed way into a `Program<Idl>` whose IDL is only known at runtime.
 *
 * The generated types are not imported, so `program.methods.setPrices` is not a
 * known property and strict mode refuses to index it. These two helpers do the
 * cast once, in one place, and assert the instruction or account actually
 * exists rather than failing later with `undefined is not a function`.
 */
export type Callable = {
  accounts(accounts: Record<string, anchor.web3.PublicKey>): Callable;
  signers(signers: anchor.web3.Keypair[]): Callable;
  rpc(): Promise<string>;
  instruction(): Promise<anchor.web3.TransactionInstruction>;
};

/** Transaction metadata bankrun returns, narrowed to what the tests read. */
export type SentMeta = {
  returnData: { data: Uint8Array } | null;
  computeUnitsConsumed: bigint;
  logMessages: string[];
};

export function call(
  program: anchor.Program<anchor.Idl>,
  instruction: string,
  args: unknown[] = [],
): Callable {
  const methods = program.methods as unknown as Record<string, (...a: unknown[]) => Callable>;
  const method = methods[instruction];

  assert.ok(method, `the built IDL has no instruction ${instruction}`);

  return method(...args);
}

export async function fetchAccount<T>(
  program: anchor.Program<anchor.Idl>,
  namespace: string,
  address: anchor.web3.PublicKey,
): Promise<T> {
  const accounts = program.account as unknown as Record<
    string,
    { fetch(address: anchor.web3.PublicKey): Promise<unknown> }
  >;
  const account = accounts[namespace];

  assert.ok(account, `the built IDL has no account ${namespace}`);

  return (await account.fetch(address)) as T;
}

/**
 * Sends one instruction and hands back its metadata.
 *
 * `.rpc()` throws away the return data and the compute units, and T05 needs
 * both: the quote's answer comes back as return data, and SPEC §10 asks for the
 * instruction's CU to be recorded.
 */
export async function send(
  h: Harness,
  instruction: anchor.web3.TransactionInstruction,
  payer = h.fund(),
): Promise<SentMeta> {
  const tx = new anchor.web3.Transaction();

  tx.recentBlockhash = h.context.lastBlockhash;
  tx.feePayer = payer.publicKey;
  tx.add(instruction);
  tx.sign(payer);

  return (await h.context.banksClient.processTransaction(tx)) as unknown as SentMeta;
}

/**
 * Decodes `quote_valuation`'s return data: four u64s, little-endian.
 *
 * The length assertion is here rather than in one spec, because it was in one
 * spec and missing from another.
 */
export function decodeValuation(meta: SentMeta): QuotedValuation {
  assert.ok(meta.returnData, "the instruction returned no data");

  const bytes = Buffer.from(meta.returnData.data);

  assert.equal(bytes.length, 32, "expected four u64s of return data");

  return {
    multFixed: bytes.readBigUInt64LE(0),
    fund: bytes.readBigUInt64LE(8),
    exec: bytes.readBigUInt64LE(16),
    h: bytes.readBigUInt64LE(24),
    computeUnits: meta.computeUnitsConsumed,
  };
}

/**
 * The three instruction builders the specs share.
 *
 * Everything each spec varies stays a parameter: the signer, the mint, the
 * prices, the stamp and the quote's own arguments. Only the shape is shared.
 */
export function initFeed(h: Harness, mint: anchor.web3.PublicKey, signer = h.authority) {
  return call(h.program, "initPriceFeed")
    .accounts({
      authority: signer.publicKey,
      stockMint: mint,
      feed: priceFeedAddress(h.program, mint),
    })
    .signers([signer])
    .rpc();
}

export function setPrices(
  h: Harness,
  mint: anchor.web3.PublicKey,
  prices: {
    wrapper: number;
    share: number;
    stamp: unknown;
    expected: number | string;
    signer?: anchor.web3.Keypair;
  },
) {
  const signer = prices.signer ?? h.authority;

  return call(h.program, "setPrices", [
    new BN(prices.wrapper),
    new BN(prices.share),
    prices.stamp,
    new BN(prices.expected),
  ])
    .accounts({
      authority: signer.publicKey,
      stockMint: mint,
      feed: priceFeedAddress(h.program, mint),
    })
    .signers([signer])
    .rpc();
}

export function quoteIx(
  h: Harness,
  mint: anchor.web3.PublicKey,
  quote: { raw: number | string; haircutBps: number; maxPriceAge: number },
) {
  return call(h.program, "quoteValuation", [
    new BN(quote.raw),
    quote.haircutBps,
    new BN(quote.maxPriceAge),
  ])
    .accounts({ stockMint: mint, feed: priceFeedAddress(h.program, mint) })
    .instruction();
}

export function readFeed(h: Harness, mint: anchor.web3.PublicKey): Promise<PriceFeedState> {
  return fetchAccount<PriceFeedState>(h.program, "priceFeed", priceFeedAddress(h.program, mint));
}

export function priceFeedAddress(
  program: anchor.Program<anchor.Idl>,
  stockMint: anchor.web3.PublicKey,
): anchor.web3.PublicKey {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("price"), stockMint.toBuffer()],
    program.programId,
  )[0];
}

