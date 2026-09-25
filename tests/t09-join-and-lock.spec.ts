/**
 * T09: join_and_lock, cancel_circle, activate.
 *
 * Two things are being proved here beyond the refusal codes.
 *
 * I4, "stock vault balance = sum of member.stock_raw". The vault is the only
 * place the circle's collateral exists, and every later instruction reasons
 * about it through the Member accounts, so the moment those two disagree every
 * coverage number in the protocol is fiction.
 *
 * And that the vault can be created at all. T08 could not: Anchor's `init`
 * allocates a token account's base 165 bytes, and a Token-2022 account for a
 * mint carrying extensions needs more, so InitializeAccount3 returned
 * InvalidAccountData against the real mint. These tests run against the real
 * NFLXx bytes at the real mainnet address, so if the ATA route did not solve
 * the sizing, nothing in this file would pass.
 *
 * The real mint carries TransferHook with its program id unset, Pausable
 * unpaused, and DefaultAccountState thawed, which is why a plain
 * transfer_checked is enough. See OPEN-QUESTIONS for what changes if the issuer
 * ever sets the hook.
 */
import assert from "node:assert/strict";

import * as anchor from "@coral-xyz/anchor";

import {
  ASSOCIATED_TOKEN_PROGRAM,
  BN,
  ataAddress,
  call,
  circleAddress,
  fetchAccount,
  FIXTURE_MINTS,
  harness,
  initFeed,
  poolAddress,
  priceFeedAddress,
  setPrices,
  splMintAccount,
  SPL_TOKEN_PROGRAM,
  tokenAccount,
  tokenAmount,
  TOKEN_2022_PROGRAM,
  CURRENT,
  ONE_X,
  BEFORE_SPLIT,
  type Harness,
} from "./harness.ts";

const USDC = 1_000_000;

/** SPEC.md:134, the seeded demo circle. */
const DEMO = {
  contribution: 50 * USDC,
  roundSecs: 120,
  graceSecs: 60,
  haircutBps: 2000,
  coverageBps: 13_000,
  warnBps: 11_000,
  guaranteePerMember: 35 * USDC,
  minStockCover: 120 * USDC,
  maxPriceAge: 691_200,
};

/** SPEC.md:134: each member locks 1.1 token, EXEC = FUND = 165, H = 132. */
const LOCK_RAW = 110_000_000n;
/** 1.0 token counts for exactly min_stock_cover, so this is the boundary. */
const EXACTLY_MINIMUM_RAW = 100_000_000n;
const BELOW_MINIMUM_RAW = EXACTLY_MINIMUM_RAW - 1n;

const PRICE = 150 * USDC;

type CircleState = {
  n: number;
  status: Record<string, unknown>;
  joinedBitmap: number;
  reserveTotal: { toNumber(): number };
  depositsTotal: { toNumber(): number };
  round: number;
  roundDeadline: { toNumber(): number };
};

type MemberState = {
  circle: anchor.web3.PublicKey;
  wallet: anchor.web3.PublicKey;
  turn: number;
  stockRaw: { toString(): string };
  guarantee: { toNumber(): number };
  roundsPaid: number;
  allocated: { toNumber(): number };
  lastCoverageBps: number;
};

describe("T09 join_and_lock, cancel_circle, activate", () => {
  let h: Harness;
  let stockMint: anchor.web3.PublicKey;
  let usdcMint: anchor.web3.PublicKey;
  let creator: anchor.web3.Keypair;
  let wallets: anchor.web3.Keypair[];
  let circle: anchor.web3.PublicKey;
  let circleId = 0n;

  const memberAddress = (wallet: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("member"), circle.toBuffer(), wallet.toBuffer()],
      h.program.programId,
    )[0];

  /** Gives a wallet the stock and USDC a join needs, as real ATAs. */
  function fundWallet(wallet: anchor.web3.PublicKey, stock: bigint, usdc: bigint) {
    const stockAta = ataAddress(stockMint, wallet, TOKEN_2022_PROGRAM);
    const usdcAta = ataAddress(usdcMint, wallet, SPL_TOKEN_PROGRAM);

    const s = tokenAccount({ mint: stockMint, owner: wallet, amount: stock, tokenProgram: TOKEN_2022_PROGRAM });
    h.putAccount(stockAta, s.data, s.owner);

    const u = tokenAccount({ mint: usdcMint, owner: wallet, amount: usdc, tokenProgram: SPL_TOKEN_PROGRAM });
    h.putAccount(usdcAta, u.data, u.owner);

    return { stockAta, usdcAta };
  }

  function join(wallet: anchor.web3.Keypair, stockRaw: bigint) {
    return call(h.program, "joinAndLock", [new BN(stockRaw.toString())])
      .accounts({
        wallet: wallet.publicKey,
        circle,
        member: memberAddress(wallet.publicKey),
        stockMint,
        usdcMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
        memberStockAta: ataAddress(stockMint, wallet.publicKey, TOKEN_2022_PROGRAM),
        memberUsdcAta: ataAddress(usdcMint, wallet.publicKey, SPL_TOKEN_PROGRAM),
        circleStockVault: ataAddress(stockMint, circle, TOKEN_2022_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
        associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();
  }

  const creatorOnly = (name: "cancelCircle" | "activate", signer: anchor.web3.Keypair) =>
    call(h.program, name, [])
      .accounts({ creator: signer.publicKey, circle })
      .signers([signer])
      .rpc();

  const readCircle = () => fetchAccount<CircleState>(h.program, "circle", circle);
  const readMember = (wallet: anchor.web3.PublicKey) =>
    fetchAccount<MemberState>(h.program, "member", memberAddress(wallet));
  const vaultAmount = async (mint: anchor.web3.PublicKey, program: string) => {
    const info = await h.context.banksClient.getAccount(ataAddress(mint, circle, program));
    return info ? tokenAmount(Buffer.from(info.data)) : null;
  };

  beforeEach(async () => {
    h = await harness(["NFLXx"]);
    stockMint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);

    usdcMint = anchor.web3.Keypair.generate().publicKey;
    const mint = splMintAccount(6);
    h.putAccount(usdcMint, mint.data, mint.owner);

    const [pool, poolBump] = poolAddress(h.program, usdcMint, stockMint);
    h.putAccount(
      pool,
      await h.program.coder.accounts.encode("liquidationPool", {
        authority: h.authority.publicKey,
        bump: poolBump,
        discountBps: 2000,
      }),
      h.program.programId,
    );

    // Before the split, so the stamp matches and the join is not Repricing.
    await h.setClock(BEFORE_SPLIT);
    await initFeed(h, stockMint);
    await setPrices(h, stockMint, { wrapper: PRICE, share: PRICE, stamp: CURRENT, expected: ONE_X });

    creator = h.fund();
    wallets = [creator, ...Array.from({ length: 4 }, () => h.fund())];

    const id = circleId++;
    circle = circleAddress(h.program, creator.publicKey, id);

    await call(h.program, "createCircle", [
      {
        circleId: new BN(Number(id)),
        contribution: new BN(DEMO.contribution),
        roundSecs: new BN(DEMO.roundSecs),
        graceSecs: new BN(DEMO.graceSecs),
        haircutBps: DEMO.haircutBps,
        coverageBps: DEMO.coverageBps,
        warnBps: DEMO.warnBps,
        guaranteePerMember: new BN(DEMO.guaranteePerMember),
        minStockCover: new BN(DEMO.minStockCover),
        maxPriceAge: new BN(DEMO.maxPriceAge),
      },
      wallets.map((w) => w.publicKey),
    ])
      .accounts({
        creator: creator.publicKey,
        circle,
        stockMint,
        usdcMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
        pool,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    for (const w of wallets) {
      fundWallet(w.publicKey, LOCK_RAW * 2n, BigInt(DEMO.guaranteePerMember) * 2n);
    }
  });

  it("creates the circle's Token-2022 vault that T08 could not, and locks into it", async () => {
    assert.equal(await vaultAmount(stockMint, TOKEN_2022_PROGRAM), null, "no vault before the first join");

    await join(wallets[0]!, LOCK_RAW);

    assert.equal(
      await vaultAmount(stockMint, TOKEN_2022_PROGRAM),
      LOCK_RAW,
      "the stock reached a vault for a mint with a permanent delegate",
    );
    assert.equal(
      await vaultAmount(usdcMint, SPL_TOKEN_PROGRAM),
      BigInt(DEMO.guaranteePerMember),
      "the guarantee reached the usdc vault",
    );
  });

  it("records the seat the CREATOR fixed, not one the joiner chose", async () => {
    // Seat 3 joins first. Turn order is the creator's list, so joining early
    // must not move anyone forward in the payout order.
    await join(wallets[2]!, LOCK_RAW);

    const m = await readMember(wallets[2]!.publicKey);

    assert.equal(m.turn, 2, "turn comes from the member list, not from arrival order");
    assert.equal(m.circle.toBase58(), circle.toBase58());
    assert.equal(m.wallet.toBase58(), wallets[2]!.publicKey.toBase58());
    assert.equal(m.stockRaw.toString(), LOCK_RAW.toString());
    assert.equal(m.guarantee.toNumber(), DEMO.guaranteePerMember);
    assert.equal(m.roundsPaid, 0);
    assert.equal(m.allocated.toNumber(), 0);
    assert.equal(
      m.lastCoverageBps,
      0xffffffff,
      "coverage saturates while nothing is owed, per SPEC.md:70",
    );

    const c = await readCircle();
    assert.equal(c.joinedBitmap, 0b00100, "only seat 3's bit is set");
    assert.equal(c.reserveTotal.toNumber(), DEMO.guaranteePerMember);
    assert.equal(c.depositsTotal.toNumber(), DEMO.guaranteePerMember);
  });

  it("I4: the stock vault equals the sum of member.stock_raw, member by member", async () => {
    let expected = 0n;

    for (const [i, w] of wallets.entries()) {
      // Deliberately different amounts, so a vault that tracked a count or the
      // last value rather than the sum would diverge.
      const raw = LOCK_RAW + BigInt(i) * 1_000_000n;
      await join(w, raw);
      expected += raw;

      const vault = await vaultAmount(stockMint, TOKEN_2022_PROGRAM);
      let sum = 0n;
      for (const seen of wallets.slice(0, i + 1)) {
        sum += BigInt((await readMember(seen.publicKey)).stockRaw.toString());
      }

      assert.equal(vault, expected, `vault after ${i + 1} joins`);
      assert.equal(sum, expected, `sum of member.stock_raw after ${i + 1} joins`);
    }
  });

  it("refuses a wallet the creator never named", async () => {
    const stranger = h.fund();
    fundWallet(stranger.publicKey, LOCK_RAW, BigInt(DEMO.guaranteePerMember));

    assert.equal(await h.refusal(join(stranger, LOCK_RAW)), "NotAMember");
  });

  it("refuses stock worth less cover than the minimum, at the exact boundary", async () => {
    assert.equal(
      await h.refusal(join(wallets[0]!, BELOW_MINIMUM_RAW)),
      "CollateralBelowMinimum",
      "one base unit under the minimum is refused",
    );

    // And the boundary itself is accepted, which pins the comparison as >=.
    await join(wallets[0]!, EXACTLY_MINIMUM_RAW);
    assert.equal(await vaultAmount(stockMint, TOKEN_2022_PROGRAM), EXACTLY_MINIMUM_RAW);
  });

  it("refuses a wallet that does not hold the stock or the guarantee", async () => {
    const poor = wallets[1]!;
    fundWallet(poor.publicKey, LOCK_RAW - 1n, BigInt(DEMO.guaranteePerMember));
    assert.equal(await h.refusal(join(poor, LOCK_RAW)), "InsufficientBalance");

    fundWallet(poor.publicKey, LOCK_RAW, BigInt(DEMO.guaranteePerMember) - 1n);
    assert.equal(await h.refusal(join(poor, LOCK_RAW)), "InsufficientBalance");
  });

  it("refuses a second join from the same wallet", async () => {
    await join(wallets[0]!, LOCK_RAW);
    await h.nextSlot();
    // The Member PDA already exists, so this is Anchor's own refusal rather
    // than ours. What matters is that it cannot succeed and double the reserve.
    await assert.rejects(join(wallets[0]!, LOCK_RAW));

    const c = await readCircle();
    assert.equal(c.reserveTotal.toNumber(), DEMO.guaranteePerMember, "the reserve counted one join");
  });

  it("refuses joining a circle that is no longer Forming", async () => {
    for (const w of wallets) await join(w, LOCK_RAW);
    await creatorOnly("activate", creator);

    const late = h.fund();
    fundWallet(late.publicKey, LOCK_RAW, BigInt(DEMO.guaranteePerMember));
    assert.equal(await h.refusal(join(late, LOCK_RAW)), "CircleNotForming");
  });

  it("activate refuses until every seat has joined, then sets round 0 and the deadline", async () => {
    for (const w of wallets.slice(0, 4)) await join(w, LOCK_RAW);
    assert.equal(await h.refusal(creatorOnly("activate", creator)), "NotAllJoined");

    await join(wallets[4]!, LOCK_RAW);
    await creatorOnly("activate", creator);

    const c = await readCircle();
    assert.ok("active" in c.status, "status is Active");
    assert.equal(c.round, 0);
    assert.equal(
      c.roundDeadline.toNumber(),
      BEFORE_SPLIT + DEMO.roundSecs,
      "the first deadline is now + round_secs",
    );
    assert.equal(c.joinedBitmap, 0b11111);
  });

  it("activate and cancel are the creator's alone", async () => {
    for (const w of wallets) await join(w, LOCK_RAW);

    assert.equal(await h.refusal(creatorOnly("activate", wallets[1]!)), "Unauthorized");
    assert.equal(await h.refusal(creatorOnly("cancelCircle", wallets[1]!)), "Unauthorized");
  });

  it("cancel_circle moves a Forming circle to Cancelled and refuses twice", async () => {
    await join(wallets[0]!, LOCK_RAW);
    await creatorOnly("cancelCircle", creator);

    const c = await readCircle();
    assert.ok("cancelled" in c.status, "status is Cancelled");
    assert.equal(
      c.reserveTotal.toNumber(),
      DEMO.guaranteePerMember,
      "cancelling moves no tokens; withdraw does the refunds (SPEC §7)",
    );
    assert.equal(
      await vaultAmount(usdcMint, SPL_TOKEN_PROGRAM),
      BigInt(DEMO.guaranteePerMember),
      "the guarantee is still in the vault after cancelling",
    );

    // The second cancel must be a DIFFERENT transaction, or the runtime
    // rejects it by signature as "already processed" and the program is never
    // reached. A test that accepted that would be asserting a refusal it cannot
    // observe: it would pass just as happily against a program with no status
    // check at all. Warping the slot changes the blockhash, so this really is a
    // second transaction arriving at the program.
    await h.nextSlot();

    assert.equal(await h.refusal(creatorOnly("cancelCircle", creator)), "CircleNotForming");
  });

  it("cannot activate a cancelled circle", async () => {
    for (const w of wallets) await join(w, LOCK_RAW);
    await creatorOnly("cancelCircle", creator);

    assert.equal(await h.refusal(creatorOnly("activate", creator)), "CircleNotForming");
  });
});
