/**
 * The two devnet stand-in mints (S2), and the instructions that make them.
 *
 * Why stand-ins exist at all: the real xStocks live on mainnet only, so a devnet
 * deploy cannot hold them (ADR-012). Othello's devnet build therefore accepts
 * exactly two mints of its own, and nothing else:
 *
 *   NFLXx devnet mirror  Token-2022, 8 decimals, with ScaledUiAmountConfig so
 *                        the demo can replay NFLXx's real 10-for-1 split.
 *                        Always labelled a mirror; never shown as the real one.
 *   Othello test USDC    CLASSIC SPL Token, 6 decimals, so it passes init_pool's
 *                        classic-SPL guard. Never presented as real USDC
 *                        (Joshua, 2026-09-25). Replaced by Circle's USDC after
 *                        the hackathon (TASKS.md).
 *
 * Both addresses are DERIVED from the admin's public key with createWithSeed
 * (Joshua's decision), so no extra keypair file exists to create or protect,
 * and the program can be built with the addresses before either mint exists.
 *
 * The instruction bytes are built by hand rather than with @solana/spl-token,
 * to avoid a new dependency the night before a deadline. Each builder is
 * exercised against the real Token-2022 and SPL Token programs in bankrun by
 * tests/s2-devnet-mints.spec.ts, which is what makes hand-built bytes safe.
 */
import * as anchor from "@coral-xyz/anchor";

const { PublicKey, SystemProgram, TransactionInstruction } = anchor.web3;
type PublicKeyT = anchor.web3.PublicKey;

export const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** createWithSeed seeds. Changing either changes both addresses, and the program. */
export const NFLXX_MIRROR_SEED = "othello-nflxx-mirror";
export const TEST_USDC_SEED = "othello-test-usdc";

export const NFLXX_MIRROR_DECIMALS = 8;
export const TEST_USDC_DECIMALS = 6;

/**
 * Token-2022 mint with one extension, ScaledUiAmountConfig: the 165-byte base
 * (82 of mint, zero padding to the account length), one account-type byte, and
 * one TLV entry of type 25, length 56 (authority 32, multiplier 8, new
 * multiplier's timestamp 8, new multiplier 8). Token-2022 refuses InitializeMint2
 * on an account of any other size, so a wrong figure here fails loudly.
 */
export const NFLXX_MIRROR_SPACE = 165 + 1 + 4 + 56;
/** A classic SPL mint is exactly 82 bytes. */
export const TEST_USDC_SPACE = 82;

export async function devnetMintAddresses(admin: PublicKeyT) {
  return {
    nflxxMirror: await PublicKey.createWithSeed(admin, NFLXX_MIRROR_SEED, TOKEN_2022),
    testUsdc: await PublicKey.createWithSeed(admin, TEST_USDC_SEED, SPL_TOKEN),
  };
}

/**
 * Makes the mint's account at its createWithSeed address, as three System
 * instructions rather than createAccountWithSeed.
 *
 * S2 adversary: the addresses are public before the mints exist, and anyone
 * can send lamports to one. createAccountWithSeed refuses any address that
 * already holds lamports ("already in use"), so a stranger's 0.0009 SOL would
 * have blocked the devnet deploy's mints for good. A transfer tops the account
 * up whether or not it exists, and allocate/assign with seed still need the
 * admin's signature as the base, so only the admin can give it data or an
 * owner. The stranger's lamports simply end up in the mint's rent.
 */
export function createMintAccountIxs(
  admin: PublicKeyT,
  address: PublicKeyT,
  seed: string,
  space: number,
  lamports: number,
  owner: PublicKeyT,
) {
  return [
    SystemProgram.transfer({ fromPubkey: admin, toPubkey: address, lamports }),
    SystemProgram.allocate({ accountPubkey: address, basePubkey: admin, seed, space, programId: owner }),
    SystemProgram.assign({ accountPubkey: address, basePubkey: admin, seed, programId: owner }),
  ];
}

/**
 * Token-2022 ScaledUiAmountExtension (43) / Initialize (0):
 * authority OptionalNonZeroPubkey (32 bytes, zeros meaning none), multiplier
 * f64 little-endian. Must come BEFORE InitializeMint2.
 */
export function initializeScaledUiAmountIx(mint: PublicKeyT, authority: PublicKeyT, multiplier: number) {
  const data = Buffer.alloc(1 + 1 + 32 + 8);
  data[0] = 43;
  data[1] = 0;
  authority.toBuffer().copy(data, 2);
  data.writeDoubleLE(multiplier, 34);
  return new TransactionInstruction({
    programId: TOKEN_2022,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  });
}

/**
 * Token-2022 ScaledUiAmountExtension (43) / UpdateMultiplier (1):
 * multiplier f64 LE, effective_timestamp i64 LE. Signed by the extension's
 * authority. This is how the demo schedules its split (T24).
 */
export function updateMultiplierIx(
  mint: PublicKeyT,
  authority: PublicKeyT,
  multiplier: number,
  effectiveTimestamp: bigint,
) {
  const data = Buffer.alloc(1 + 1 + 8 + 8);
  data[0] = 43;
  data[1] = 1;
  data.writeDoubleLE(multiplier, 2);
  data.writeBigInt64LE(effectiveTimestamp, 10);
  return new TransactionInstruction({
    programId: TOKEN_2022,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/**
 * InitializeMint2 (20), the same bytes in SPL Token and Token-2022: decimals,
 * mint authority, then a COption freeze authority (1-byte tag, 0 = none). No
 * freeze authority on either mint: nothing in the demo should be able to
 * freeze a member's tokens.
 */
export function initializeMint2Ix(mint: PublicKeyT, decimals: number, mintAuthority: PublicKeyT, tokenProgram: PublicKeyT) {
  const data = Buffer.alloc(1 + 1 + 32 + 1);
  data[0] = 20;
  data[1] = decimals;
  mintAuthority.toBuffer().copy(data, 2);
  data[34] = 0;
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  });
}

export function ataAddress(mint: PublicKeyT, owner: PublicKeyT, tokenProgram: PublicKeyT) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN,
  )[0];
}

/** Associated Token CreateIdempotent (1): safe to repeat. */
export function createAtaIdempotentIx(payer: PublicKeyT, owner: PublicKeyT, mint: PublicKeyT, tokenProgram: PublicKeyT) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataAddress(mint, owner, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** MintToChecked (14): amount u64, decimals u8. */
export function mintToCheckedIx(
  mint: PublicKeyT,
  destination: PublicKeyT,
  authority: PublicKeyT,
  amount: bigint,
  decimals: number,
  tokenProgram: PublicKeyT,
) {
  const data = Buffer.alloc(1 + 8 + 1);
  data[0] = 14;
  data.writeBigUInt64LE(amount, 1);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** Every instruction that creates the NFLXx mirror, in order. */
export async function createNflxxMirrorIxs(admin: PublicKeyT, rent: number) {
  const { nflxxMirror } = await devnetMintAddresses(admin);
  return [
    ...createMintAccountIxs(admin, nflxxMirror, NFLXX_MIRROR_SEED, NFLXX_MIRROR_SPACE, rent, TOKEN_2022),
    initializeScaledUiAmountIx(nflxxMirror, admin, 1.0),
    initializeMint2Ix(nflxxMirror, NFLXX_MIRROR_DECIMALS, admin, TOKEN_2022),
  ];
}

/** Every instruction that creates the test USDC, in order. */
export async function createTestUsdcIxs(admin: PublicKeyT, rent: number) {
  const { testUsdc } = await devnetMintAddresses(admin);
  return [
    ...createMintAccountIxs(admin, testUsdc, TEST_USDC_SEED, TEST_USDC_SPACE, rent, SPL_TOKEN),
    initializeMint2Ix(testUsdc, TEST_USDC_DECIMALS, admin, SPL_TOKEN),
  ];
}

/** Every instruction that creates both mints, in order. */
export async function createDevnetMintsIxs(
  admin: PublicKeyT,
  rent: { nflxxMirror: number; testUsdc: number },
) {
  return [...(await createNflxxMirrorIxs(admin, rent.nflxxMirror)), ...(await createTestUsdcIxs(admin, rent.testUsdc))];
}

/**
 * What is at a stand-in address. "absent" includes a stranger's pre-funded,
 * empty, System-owned account: the create instructions above handle it.
 * Anything else that is not the expected mint is refused, never overwritten.
 */
export function standInState(
  info: { owner: PublicKeyT; data: Uint8Array } | null,
  expect: { owner: PublicKeyT; space: number; decimals: number; admin: PublicKeyT },
): "absent" | "ready" | { refused: string } {
  if (!info || (info.owner.equals(SystemProgram.programId) && info.data.length === 0)) return "absent";
  const data = Buffer.from(info.data);
  if (!info.owner.equals(expect.owner)) return { refused: `owned by ${info.owner.toBase58()}, expected ${expect.owner.toBase58()}` };
  if (data.length !== expect.space) return { refused: `${data.length} bytes, expected ${expect.space}` };
  if (data[45] !== 1) return { refused: "not an initialized mint" };
  if (data.readUInt32LE(0) !== 1 || !new PublicKey(data.subarray(4, 36)).equals(expect.admin)) return { refused: "its mint authority is not the admin" };
  if (data[44] !== expect.decimals) return { refused: `${data[44]} decimals, expected ${expect.decimals}` };
  return "ready";
}
