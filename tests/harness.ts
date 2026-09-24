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
  fund: (lamports?: number, keypair?: anchor.web3.Keypair) => anchor.web3.Keypair;
  placeMint: (symbol: FixtureSymbol, at?: anchor.web3.PublicKey) => void;
  putAccount: (address: anchor.web3.PublicKey, data: Buffer, owner: anchor.web3.PublicKey) => void;
  /** The refusal code name a rejected instruction carried. */
  refusal: (promise: Promise<unknown>) => Promise<string>;
  /**
   * The program logs a FAILED transaction produced.
   *
   * SPEC.md:204 has refusal payloads emitted as events before the error
   * returns. The transaction fails, so nothing lands on chain, but the logs
   * come back either way, which is how FLOWS §9's "every tx previewed by
   * simulation" reads them.
   */
  failedLogs: (promise: Promise<unknown>) => Promise<string[]>;
  /**
   * Advances the slot so the next transaction gets a fresh blockhash.
   *
   * Call this between two OTHERWISE IDENTICAL transactions. Without it the
   * runtime rejects the second by signature, "This transaction has already been
   * processed", and the program is never reached: a test asserting a refusal
   * would pass just as happily against a program that had no such check. One
   * test in T09 was doing exactly that.
   */
  nextSlot: () => Promise<void>;
};

/** Starts bankrun with the program loaded and the named real mints in place. */
export async function harness(mints: FixtureSymbol[]): Promise<Harness> {
  // bankrun loads target/deploy/othello.so, so these specs are exactly as
  // trustworthy as that file is current. Running one spec on its own used to
  // skip this and could test bytes that no longer matched the source.
  assertFresh(PROGRAM_SO);
  assertFresh(PROGRAM_IDL);

  // The bundled Token-2022 is too old to parse a real xStock. bankrun 0.4.0
  // predates ScaledUiAmountConfig (extension 25) and Pausable (26), and the
  // TLV walk errors on an unknown discriminant, so the program's own
  // GetAccountDataSize returns InvalidAccountData against the real mint bytes.
  // Proved by probe: a bare Token-2022 mint got an ATA, NFLXx did not.
  //
  // Our decoder reads those extensions, which is why T05 and T06 pass on the
  // same bytes; it is the on-chain program that could not. So the real one is
  // loaded from tests/fixtures/spl_token_2022.so, dumped from devnet with
  // `solana program dump`, the same provenance rule the mint fixtures follow.
  const idl = JSON.parse(readFileSync(resolve(REPO, PROGRAM_IDL), "utf8")) as anchor.Idl & {
    address: string;
  };

  // T14: the admin is the program's upgrade authority, read from the loader's
  // ProgramData account. startAnchor loads the program through the old
  // non-upgradeable loader, which has no ProgramData, so every admin
  // instruction would refuse. The program is placed again here the way a real
  // deploy leaves it: a program account owned by the upgradeable loader,
  // pointing at a ProgramData account that holds the ELF and names `authority`
  // as the upgrade authority. bankrun logs "Overriding account" for it.
  const authority = anchor.web3.Keypair.generate();
  const context = await startAnchor(
    REPO,
    [{ name: "spl_token_2022", programId: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM) }],
    upgradeableProgram(new anchor.web3.PublicKey(idl.address), authority.publicKey),
  );
  const provider = new BankrunProvider(context);
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

  /** Writes any account straight into the harness. */
  const putAccount = (
    address: anchor.web3.PublicKey,
    data: Buffer,
    owner: anchor.web3.PublicKey,
  ): void => {
    context.setAccount(address, {
      lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
      data,
      owner,
      executable: false,
    });
  };

  const fund = (
    lamports = anchor.web3.LAMPORTS_PER_SOL,
    keypair = anchor.web3.Keypair.generate(),
  ): anchor.web3.Keypair => {

    context.setAccount(keypair.publicKey, {
      lamports,
      data: Buffer.alloc(0),
      owner: anchor.web3.SystemProgram.programId,
      executable: false,
    });

    return keypair;
  };

  const nextSlot = async (): Promise<void> => {
    const before = await context.banksClient.getClock();
    context.warpToSlot(before.slot + 1n);

    // warpToSlot recomputes the clock from the bank, which throws away any
    // timestamp setClock had put there. Restoring it keeps this a change of
    // blockhash ONLY: a helper meant to let a duplicate transaction through
    // must not also move the wall clock, or a test asserting one refusal
    // silently starts asserting PriceStale instead. That happened.
    const after = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        after.slot,
        after.epochStartTimestamp,
        after.epoch,
        after.leaderScheduleEpoch,
        before.unixTimestamp,
      ),
    );
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

  const failedLogs = async (promise: Promise<unknown>): Promise<string[]> => {
    try {
      await promise;
    } catch (thrown) {
      const withLogs = thrown as { logs?: string[]; transactionLogs?: string[] };
      const logs = withLogs.logs ?? withLogs.transactionLogs;
      if (logs) {
        return logs;
      }

      // bankrun stringifies the logs into the message instead of attaching
      // them, so pull them back out of the array it prints.
      const inline = /Logs:\s*\n?\[([\s\S]*?)\]\./.exec(String(thrown));
      if (inline?.[1]) {
        return inline[1]
          .split("\n")
          .map((line) => line.trim().replace(/^["']|["'],?$/g, ""))
          .filter(Boolean);
      }

      throw new Error(`no logs on the failure: ${String(thrown)}`);
    }

    throw new Error("expected the instruction to be refused, but it succeeded");
  };

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
    authority: fund(100 * anchor.web3.LAMPORTS_PER_SOL, authority),
    setClock,
    fund,
    placeMint,
    putAccount,
    refusal,
    failedLogs,
    nextSlot,
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
  /** The n Member accounts the gate instructions take, in turn order. */
  remainingAccounts(accounts: anchor.web3.AccountMeta[]): Callable;
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
      program: h.program.programId,
      programData: programDataAddress(h.program.programId),
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

/** SPL Token, for the USDC side. Token-2022 is the stock side. */
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/**
 * Writes a plain SPL mint by hand, because gate 1 committed no USDC fixture and
 * `create_circle` needs a real one to bind to.
 *
 * The 82-byte layout, from the SPL Token program:
 * mint_authority COption<Pubkey> (4 + 32), supply u64, decimals u8,
 * is_initialized bool, freeze_authority COption<Pubkey> (4 + 32).
 */
export function splMintAccount(decimals = 6): { data: Buffer; owner: anchor.web3.PublicKey } {
  const data = Buffer.alloc(82);

  data.writeUInt32LE(0, 0); // mint_authority: None
  data.writeBigUInt64LE(0n, 36); // supply
  data[44] = decimals;
  data[45] = 1; // is_initialized
  data.writeUInt32LE(0, 46); // freeze_authority: None

  return { data, owner: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM) };
}

/** PDA helpers for the accounts gate 2 introduces. */
export function circleAddress(
  program: anchor.Program<anchor.Idl>,
  creator: anchor.web3.PublicKey,
  circleId: bigint,
): anchor.web3.PublicKey {
  const id = Buffer.alloc(8);
  id.writeBigUInt64LE(circleId);

  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("circle"), creator.toBuffer(), id],
    program.programId,
  )[0];
}

export function poolAddress(
  program: anchor.Program<anchor.Idl>,
  usdcMint: anchor.web3.PublicKey,
  stockMint: anchor.web3.PublicKey,
): [anchor.web3.PublicKey, number] {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), usdcMint.toBuffer(), stockMint.toBuffer()],
    program.programId,
  );
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

export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** The ATA the Associated Token program derives for (owner, tokenProgram, mint). */
export function ataAddress(
  mint: anchor.web3.PublicKey,
  owner: anchor.web3.PublicKey,
  tokenProgram: string,
): anchor.web3.PublicKey {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [owner.toBuffer(), new anchor.web3.PublicKey(tokenProgram).toBuffer(), mint.toBuffer()],
    new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
  )[0];
}

/**
 * A token account holding `amount`, written by hand.
 *
 * The base layout is 165 bytes: mint(32) owner(32) amount(8) delegate(4+32)
 * state(1) is_native(4+8) delegated_amount(8) close_authority(4+32).
 *
 * For Token-2022 the ATA program appends the account-type discriminant and an
 * ImmutableOwner extension, so the account is 170 bytes and byte 165 is 2. A
 * 165-byte account under Token-2022 would be read as a MINT, not an account,
 * which is the same length confusion that stopped T08 creating vaults.
 */
export function tokenAccount(args: {
  mint: anchor.web3.PublicKey;
  owner: anchor.web3.PublicKey;
  amount: bigint;
  tokenProgram: string;
}): { data: Buffer; owner: anchor.web3.PublicKey } {
  const token2022 = args.tokenProgram === TOKEN_2022_PROGRAM;
  const data = Buffer.alloc(token2022 ? 170 : 165);

  args.mint.toBuffer().copy(data, 0);
  args.owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(args.amount, 64);
  data.writeUInt32LE(0, 72); // delegate: None
  data[108] = 1; // AccountState::Initialized, so DefaultAccountState cannot freeze it
  data.writeUInt32LE(0, 109); // is_native: None
  data.writeBigUInt64LE(0n, 121); // delegated_amount
  data.writeUInt32LE(0, 129); // close_authority: None

  if (token2022) {
    data[165] = 2; // AccountType::Account
    data.writeUInt16LE(7, 166); // ExtensionType::ImmutableOwner
    data.writeUInt16LE(0, 168); // length 0
  }

  return { data, owner: new anchor.web3.PublicKey(args.tokenProgram) };
}

/** Reads the `amount` field back out of a token account. */
export function tokenAmount(data: Buffer): bigint {
  return data.readBigUInt64LE(64);
}

/**
 * Decodes one Anchor event out of a transaction's program logs.
 *
 * Anchor writes events as base64 behind "Program data:", with the event's
 * 8-byte discriminator first. This is the decoding a client library does for
 * you, and doing it here is the point: it proves the payload is a TYPED event
 * rather than a msg! line that happens to contain the same numbers.
 */
export function decodeEvent<T>(
  program: anchor.Program<anchor.Idl>,
  name: string,
  logs: string[],
): T | null {
  const coder = new anchor.BorshEventCoder(program.idl);

  for (const line of logs) {
    const match = /Program data: (.+)/.exec(line);
    if (!match?.[1]) continue;

    const decoded = coder.decode(match[1].trim());
    if (decoded?.name === name) {
      return decoded.data as T;
    }
  }

  return null;
}

export const UPGRADEABLE_LOADER = new anchor.web3.PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** The loader's ProgramData address for a program: `[program_id]` under the loader. */
export function programDataAddress(programId: anchor.web3.PublicKey): anchor.web3.PublicKey {
  return anchor.web3.PublicKey.findProgramAddressSync([programId.toBuffer()], UPGRADEABLE_LOADER)[0];
}

/**
 * The two accounts an upgradeable deploy leaves behind, as bincode
 * UpgradeableLoaderState:
 * - Program: tag 2 (u32), then the ProgramData address.
 * - ProgramData: tag 3 (u32), slot (u64), upgrade authority as Option<Pubkey>
 *   (1 byte + 32), then the ELF from byte 45.
 * `upgradeAuthority` null is a program deployed immutable (Option None).
 */
export function upgradeableProgram(
  programId: anchor.web3.PublicKey,
  upgradeAuthority: anchor.web3.PublicKey | null,
): { address: anchor.web3.PublicKey; info: { lamports: number; data: Buffer; owner: anchor.web3.PublicKey; executable: boolean } }[] {
  const programData = programDataAddress(programId);
  const elf = readFileSync(resolve(REPO, PROGRAM_SO));

  const program = Buffer.alloc(36);
  program.writeUInt32LE(2, 0);
  programData.toBuffer().copy(program, 4);

  const data = Buffer.alloc(45 + elf.length);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(0n, 4);
  if (upgradeAuthority) {
    data[12] = 1;
    upgradeAuthority.toBuffer().copy(data, 13);
  }
  elf.copy(data, 45);

  return [
    { address: programId, info: { lamports: anchor.web3.LAMPORTS_PER_SOL, data: program, owner: UPGRADEABLE_LOADER, executable: true } },
    { address: programData, info: { lamports: 10 * anchor.web3.LAMPORTS_PER_SOL, data, owner: UPGRADEABLE_LOADER, executable: false } },
  ];
}

/** `init_pool` with every account named, so a spec can swap any one of them. */
export function initPoolIx(
  h: Harness,
  args: {
    usdcMint: anchor.web3.PublicKey;
    stockMint: anchor.web3.PublicKey;
    discountBps: number;
    signer?: anchor.web3.Keypair;
    usdcTokenProgram?: string;
    programData?: anchor.web3.PublicKey;
  },
) {
  const signer = args.signer ?? h.authority;
  const usdcTokenProgram = args.usdcTokenProgram ?? SPL_TOKEN_PROGRAM;
  const [pool] = poolAddress(h.program, args.usdcMint, args.stockMint);

  return call(h.program, "initPool", [args.discountBps])
    .accounts({
      authority: signer.publicKey,
      program: h.program.programId,
      programData: args.programData ?? programDataAddress(h.program.programId),
      usdcMint: args.usdcMint,
      stockMint: args.stockMint,
      pool,
      poolUsdcVault: ataAddress(args.usdcMint, pool, usdcTokenProgram),
      poolStockVault: ataAddress(args.stockMint, pool, TOKEN_2022_PROGRAM),
      usdcTokenProgram: new anchor.web3.PublicKey(usdcTokenProgram),
      stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
      associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .signers([signer]);
}

/** `seed_pool` from the signer's own USDC associated token account. */
export function seedPoolIx(
  h: Harness,
  args: {
    usdcMint: anchor.web3.PublicKey;
    stockMint: anchor.web3.PublicKey;
    amount: bigint;
    signer?: anchor.web3.Keypair;
  },
) {
  const signer = args.signer ?? h.authority;
  const [pool] = poolAddress(h.program, args.usdcMint, args.stockMint);

  return call(h.program, "seedPool", [new BN(args.amount.toString())])
    .accounts({
      authority: signer.publicKey,
      pool,
      usdcMint: args.usdcMint,
      stockMint: args.stockMint,
      authorityUsdc: ataAddress(args.usdcMint, signer.publicKey, SPL_TOKEN_PROGRAM),
      poolUsdcVault: ataAddress(args.usdcMint, pool, SPL_TOKEN_PROGRAM),
      usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
    })
    .signers([signer]);
}
