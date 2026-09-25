/**
 * T09 adversary pass: the attacks tests/t09-join-and-lock.spec.ts does not run.
 *
 * Three of the seven refusal codes SPEC.md:102 names for `join_and_lock` have no
 * test in the T09 suite: `price_stale`, `multiplier_price_mismatch` and
 * `multiplier_invalid`. The second of those is INVARIANTS.md I13, which names
 * `join_and_lock` by instruction. This file asserts the first two on the real
 * NFLXx bytes, in both directions of the split, and at the exact freshness
 * boundary. `multiplier_invalid` is not reachable through an allowlisted mint,
 * so it is not attempted here.
 *
 * It also pins the two ends of `activate`'s full-bitmap arithmetic. The T09
 * suite only exercises n = 5, and lifecycle.rs takes a different branch at
 * n = 8, where `1u8 << n` would overflow.
 *
 * The clock sits well before the real NFLXx split for every case that is not
 * about the split, so that warping the clock to age a price cannot change the
 * mint's effective multiplier by accident.
 *
 * Every case here PASSES against f9cf11f. This is coverage the suite was
 * missing, not a defect.
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
  TOKEN_2022_PROGRAM,
  CURRENT,
  SCHEDULED,
  ONE_X,
  TEN_X,
  SPLIT_AT,
  type Harness,
} from "./harness.ts";

const USDC = 1_000_000;

/** Far enough before SPEC §9b.1's split that ageing a price stays at 1x. */
const BEFORE_ANY_SPLIT = SPLIT_AT - 1_000_000;

/** SPEC.md:134, with a price age short enough to cross inside one test. */
const DEMO = {
  contribution: 50 * USDC,
  roundSecs: 120,
  graceSecs: 60,
  haircutBps: 2000,
  coverageBps: 13_000,
  warnBps: 11_000,
  guaranteePerMember: 35 * USDC,
  minStockCover: 120 * USDC,
  maxPriceAge: 3600,
};

/** SPEC.md:134: 1.1 token, EXEC = FUND = 165, H = 132. */
const LOCK_RAW = 110_000_000n;
const PRICE = 150 * USDC;
/** The share price the demo's split script stamps for the 10x multiplier. */
const SPLIT_SHARE_PRICE = 15 * USDC;

type CircleState = {
  status: Record<string, unknown>;
  joinedBitmap: number;
  round: number;
  roundDeadline: { toNumber(): number };
};

describe("T09 adversary", () => {
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

  function fundWallet(wallet: anchor.web3.PublicKey, stock: bigint, usdc: bigint) {
    const s = tokenAccount({
      mint: stockMint,
      owner: wallet,
      amount: stock,
      tokenProgram: TOKEN_2022_PROGRAM,
    });
    h.putAccount(ataAddress(stockMint, wallet, TOKEN_2022_PROGRAM), s.data, s.owner);

    const u = tokenAccount({
      mint: usdcMint,
      owner: wallet,
      amount: usdc,
      tokenProgram: SPL_TOKEN_PROGRAM,
    });
    h.putAccount(ataAddress(usdcMint, wallet, SPL_TOKEN_PROGRAM), u.data, u.owner);
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

  const activate = (signer: anchor.web3.Keypair) =>
    call(h.program, "activate", [])
      .accounts({ creator: signer.publicKey, circle })
      .signers([signer])
      .rpc();

  const readCircle = () => fetchAccount<CircleState>(h.program, "circle", circle);

  /**
   * A Forming circle of `n` seats, every seat funded.
   *
   * The guarantee scales with n because create_circle's peak check does: at
   * n = 8 the demo's 35 USDC no longer reaches the worst round.
   */
  async function makeCircle(n: number, guaranteePerMember = DEMO.guaranteePerMember) {
    creator = h.fund();
    wallets = [creator, ...Array.from({ length: n - 1 }, () => h.fund())];

    const id = circleId++;
    circle = circleAddress(h.program, creator.publicKey, id);
    const [pool] = poolAddress(h.program, usdcMint, stockMint);

    await call(h.program, "createCircle", [
      {
        circleId: new BN(Number(id)),
        contribution: new BN(DEMO.contribution),
        roundSecs: new BN(DEMO.roundSecs),
        graceSecs: new BN(DEMO.graceSecs),
        haircutBps: DEMO.haircutBps,
        coverageBps: DEMO.coverageBps,
        warnBps: DEMO.warnBps,
        guaranteePerMember: new BN(guaranteePerMember),
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
      fundWallet(w.publicKey, LOCK_RAW * 2n, BigInt(guaranteePerMember) * 2n);
    }
  }

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

    await h.setClock(BEFORE_ANY_SPLIT);
    await initFeed(h, stockMint);
    await setPrices(h, stockMint, {
      wrapper: PRICE,
      share: PRICE,
      stamp: CURRENT,
      expected: ONE_X,
    });
  });

  it("SPEC §5 price_stale: fresh at exactly max_price_age, stale one second later", async () => {
    await makeCircle(5);

    // SPEC.md:140, "fresh iff now - updated_at <= max_price_age". The boundary
    // itself must still value collateral, which pins the comparison as <=.
    await h.setClock(BEFORE_ANY_SPLIT + DEMO.maxPriceAge);
    await join(wallets[0]!, LOCK_RAW);

    await h.setClock(BEFORE_ANY_SPLIT + DEMO.maxPriceAge + 1);
    assert.equal(await h.refusal(join(wallets[1]!, LOCK_RAW)), "PriceStale");
  });

  it("I13: a price quoted for the old multiplier refuses once the split is effective", async () => {
    await makeCircle(5);

    // Stamp the price fresh one second before the split, so staleness cannot be
    // what refuses this, and then cross the effective second. The mint now says
    // 10x while the feed still says its share price was quoted at 1x, and FUND
    // would come out ten times the truth if the stamp were ignored.
    await h.setClock(SPLIT_AT - 1);
    await setPrices(h, stockMint, {
      wrapper: PRICE,
      share: PRICE,
      stamp: CURRENT,
      expected: ONE_X,
    });

    await h.setClock(SPLIT_AT);
    assert.equal(await h.refusal(join(wallets[0]!, LOCK_RAW)), "MultiplierPriceMismatch");
  });

  it("I13: a price quoted for the scheduled multiplier refuses before it is effective", async () => {
    await makeCircle(5);

    // The demo's own sequence in the other direction (SPEC.md:134): the script
    // schedules 10x and stamps the new share price for it, and until the
    // effective second the mint still reports 1x. Joining in that window would
    // value the position at a tenth.
    await setPrices(h, stockMint, {
      wrapper: PRICE,
      share: SPLIT_SHARE_PRICE,
      stamp: SCHEDULED,
      expected: TEN_X,
    });

    assert.equal(await h.refusal(join(wallets[0]!, LOCK_RAW)), "MultiplierPriceMismatch");
  });

  it("activate: the full bitmap is right at both ends of 3..=8", async () => {
    // n = 3 is the smallest circle SPEC §5 allows, 0b111.
    await makeCircle(3);
    for (const w of wallets) await join(w, LOCK_RAW);
    await activate(creator);

    let c = await readCircle();
    assert.ok("active" in c.status, "n = 3 activates");
    assert.equal(c.joinedBitmap, 0b111);

    // n = 8 is the branch where 1u8 << n would overflow. Seven joined must
    // still refuse, and the eighth must let it through.
    await makeCircle(8, 80 * USDC);
    for (const w of wallets.slice(0, 7)) await join(w, LOCK_RAW);
    assert.equal(await h.refusal(activate(creator)), "NotAllJoined", "seven of eight");

    await join(wallets[7]!, LOCK_RAW);
    await activate(creator);

    c = await readCircle();
    assert.ok("active" in c.status, "n = 8 activates");
    assert.equal(c.joinedBitmap, 0xff);
    assert.equal(c.round, 0);
    assert.equal(c.roundDeadline.toNumber(), BEFORE_ANY_SPLIT + DEMO.roundSecs);
  });

  it("the seat is the creator's index even when everyone joins in reverse", async () => {
    await makeCircle(8, 80 * USDC);

    for (const w of [...wallets].reverse()) await join(w, LOCK_RAW);

    for (const [index, w] of wallets.entries()) {
      const m = await fetchAccount<{ turn: number }>(h.program, "member", memberAddress(w.publicKey));

      assert.equal(m.turn, index, `seat ${index} kept its turn`);
    }
  });
});
