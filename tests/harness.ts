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

import { DEPLOY_DIR, PROGRAM_IDL, PROGRAM_NAME, REPO } from "./artifacts.ts";

// Read inside startAnchor, so setting them at import time is early enough.
process.env.BPF_OUT_DIR = resolve(REPO, DEPLOY_DIR);
process.env.RUST_LOG = process.env.RUST_LOG ?? "off";

const { startAnchor, Clock } = await import("solana-bankrun");
const { BankrunProvider } = await import("anchor-bankrun");

export { Clock };

/** SPEC §9b.1. The real mint, at its real mainnet address. */
export const FIXTURE_MINTS = {
  AAPLx: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
  NFLXx: "XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL",
} as const;

export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

type Fixture = { address: string; owner: string; dataLen: number; dataBase64: string };

export function fixture(symbol: keyof typeof FIXTURE_MINTS): Fixture {
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
};

/** Starts bankrun with the program loaded and the named real mints in place. */
export async function harness(mints: (keyof typeof FIXTURE_MINTS)[]): Promise<Harness> {
  const context = await startAnchor(REPO, [], []);
  const provider = new BankrunProvider(context);
  const idl = JSON.parse(readFileSync(resolve(REPO, PROGRAM_IDL), "utf8")) as anchor.Idl & {
    address: string;
  };
  const program = new anchor.Program(idl, provider);

  for (const symbol of mints) {
    const source = fixture(symbol);
    const data = Buffer.from(source.dataBase64, "base64");

    assert.equal(data.length, source.dataLen, `${symbol}: dataBase64 does not decode to dataLen`);

    context.setAccount(new anchor.web3.PublicKey(source.address), {
      lamports: 10 * anchor.web3.LAMPORTS_PER_SOL,
      data,
      owner: new anchor.web3.PublicKey(source.owner),
      executable: false,
    });
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

  return { context, program, authority: fund(100 * anchor.web3.LAMPORTS_PER_SOL), setClock, fund };
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

export function priceFeedAddress(
  program: anchor.Program<anchor.Idl>,
  stockMint: anchor.web3.PublicKey,
): anchor.web3.PublicKey {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("price"), stockMint.toBuffer()],
    program.programId,
  )[0];
}

/** The Anchor error name a rejected instruction carried, or the raw message. */
export async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (thrown) {
    const anchorError = thrown as { error?: { errorCode?: { code?: string } } };

    return anchorError.error?.errorCode?.code ?? String(thrown);
  }

  throw new Error("expected the instruction to be refused, but it succeeded");
}
