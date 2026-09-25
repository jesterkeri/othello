/**
 * T14: init_pool and seed_pool, and the admin root they and init_price_feed
 * now share.
 *
 * TASKS T14's done-when is "unauthorized and invalid_params tested". Two
 * findings recorded in OPEN-QUESTIONS were owed to this task as well, and each
 * has its attack here:
 *
 *   Oracle takeover (BLOCKING before T23). init_price_feed made its first
 *   caller the feed's authority for good. The admin is now the program's
 *   upgrade authority, read from the loader's ProgramData account. The
 *   stranger who took over NFLXx's feed in the T04 adversary pass is refused,
 *   and so is a stranger who brings a ProgramData account of their own.
 *
 *   USDC mint unconstrained (T09 adversary). A Token-2022 "USDC" could carry
 *   TransferFeeConfig and make the reserve larger than the money behind it.
 *   init_pool refuses anything that is not a plain SPL Token mint.
 */
import assert from "node:assert/strict";

import * as anchor from "@coral-xyz/anchor";

import {
  ASSOCIATED_TOKEN_PROGRAM,
  BEFORE_SPLIT,
  BN,
  CURRENT,
  FIXTURE_MINTS,
  ONE_X,
  SPL_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  UPGRADEABLE_LOADER,
  USDC,
  ataAddress,
  call,
  circleAddress,
  decodeEvent,
  fetchAccount,
  harness,
  initFeed,
  initPoolIx,
  poolAddress,
  priceFeedAddress,
  programDataAddress,
  seedPoolIx,
  send,
  setPrices,
  splMintAccount,
  tokenAccount,
  tokenAmount,
  upgradeableProgram,
  type Harness,
} from "./harness.ts";

type Pool = { authority: anchor.web3.PublicKey; bump: number; discountBps: number };

const DEMO_DISCOUNT = 2000;

describe("T14 admin root, init_pool and seed_pool", () => {
  let h: Harness;
  let stockMint: anchor.web3.PublicKey;
  let usdcMint: anchor.web3.PublicKey;

  const newUsdcMint = (tokenProgram = SPL_TOKEN_PROGRAM): anchor.web3.PublicKey => {
    const mint = anchor.web3.Keypair.generate().publicKey;
    const m = splMintAccount(6);
    // The same 82 bytes are a valid Token-2022 mint with no extensions, so
    // only the owning program differs between the accepted and refused case.
    h.putAccount(mint, m.data, new anchor.web3.PublicKey(tokenProgram));
    return mint;
  };

  const giveUsdc = (owner: anchor.web3.PublicKey, amount: bigint) => {
    const u = tokenAccount({ mint: usdcMint, owner, amount, tokenProgram: SPL_TOKEN_PROGRAM });
    h.putAccount(ataAddress(usdcMint, owner, SPL_TOKEN_PROGRAM), u.data, u.owner);
  };

  const balance = async (address: anchor.web3.PublicKey) => {
    const info = await h.context.banksClient.getAccount(address);
    return info ? tokenAmount(Buffer.from(info.data)) : null;
  };

  beforeEach(async () => {
    h = await harness(["NFLXx", "AAPLx"]);
    stockMint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);
    usdcMint = newUsdcMint();
    await h.setClock(BEFORE_SPLIT);
  });

  describe("the admin is the program's upgrade authority", () => {
    it("refuses init_price_feed from a stranger, the T04 takeover, and the admin can still create the feed", async () => {
      const stranger = h.fund();

      assert.equal(await h.refusal(initFeed(h, stockMint, stranger)), "Unauthorized");

      // Refused, not squatted: the admin's feed still goes in and is the admin's.
      await initFeed(h, stockMint);
      const feed = await fetchAccount<{ authority: anchor.web3.PublicKey }>(
        h.program,
        "priceFeed",
        priceFeedAddress(h.program, stockMint),
      );
      assert.ok(feed.authority.equals(h.authority.publicKey));
    });

    it("refuses a stranger who brings a ProgramData account naming themselves", async () => {
      // A real attacker can deploy a program of their own and be its upgrade
      // authority, so that ProgramData account is genuine and loader-owned. It
      // is simply not Othello's.
      const stranger = h.fund();
      const theirs = anchor.web3.Keypair.generate().publicKey;
      for (const a of upgradeableProgram(theirs, stranger.publicKey)) {
        h.context.setAccount(a.address, a.info);
      }

      const ix = call(h.program, "initPriceFeed").accounts({
        authority: stranger.publicKey,
        program: h.program.programId,
        programData: programDataAddress(theirs),
        stockMint,
        feed: priceFeedAddress(h.program, stockMint),
      });

      assert.equal(await h.refusal(ix.signers([stranger]).rpc()), "Unauthorized");
      assert.equal(
        await h.refusal(initPoolIx(h, { usdcMint, stockMint, discountBps: DEMO_DISCOUNT, signer: stranger, programData: programDataAddress(theirs) }).rpc()),
        "Unauthorized",
      );
    });

    it("refuses everyone once the program is immutable, because nobody is the admin", async () => {
      const programData = programDataAddress(h.program.programId);
      const info = await h.context.banksClient.getAccount(programData);
      assert.ok(info);
      const data = Buffer.from(info.data);
      assert.equal(data[12], 1, "the harness deploys with an upgrade authority");
      data[12] = 0; // Option<Pubkey>::None: what `solana program set-upgrade-authority --final` leaves
      h.putAccount(programData, data, UPGRADEABLE_LOADER);

      assert.equal(await h.refusal(initFeed(h, stockMint)), "Unauthorized");
      assert.equal(await h.refusal(initPoolIx(h, { usdcMint, stockMint, discountBps: DEMO_DISCOUNT }).rpc()), "Unauthorized");
    });
  });

  describe("init_pool", () => {
    it("creates the pool and both vaults, owned by the pool, and says so in an event", async () => {
      const ix = await initPoolIx(h, { usdcMint, stockMint, discountBps: DEMO_DISCOUNT }).instruction();
      const meta = await send(h, ix, h.authority);

      const [pool, bump] = poolAddress(h.program, usdcMint, stockMint);
      const state = await fetchAccount<Pool>(h.program, "liquidationPool", pool);
      assert.ok(state.authority.equals(h.authority.publicKey));
      assert.equal(state.bump, bump);
      assert.equal(state.discountBps, DEMO_DISCOUNT);

      for (const [mint, program] of [
        [usdcMint, SPL_TOKEN_PROGRAM],
        [stockMint, TOKEN_2022_PROGRAM],
      ] as const) {
        const vault = await h.context.banksClient.getAccount(ataAddress(mint, pool, program));
        assert.ok(vault, `the pool's ${program === SPL_TOKEN_PROGRAM ? "USDC" : "stock"} vault exists`);
        assert.ok(vault.owner.equals(new anchor.web3.PublicKey(program)));
        const data = Buffer.from(vault.data);
        assert.ok(new anchor.web3.PublicKey(data.subarray(0, 32)).equals(mint));
        assert.ok(new anchor.web3.PublicKey(data.subarray(32, 64)).equals(pool), "owned by the pool PDA");
      }

      const event = decodeEvent<{ discountBps: number; authority: anchor.web3.PublicKey }>(h.program, "poolInitialized", meta.logMessages);
      assert.ok(event, "PoolInitialized was emitted");
      assert.equal(event.discountBps, DEMO_DISCOUNT);
      assert.ok(event.authority.equals(h.authority.publicKey));
    });

    it("refuses a stranger", async () => {
      const stranger = h.fund();
      assert.equal(
        await h.refusal(initPoolIx(h, { usdcMint, stockMint, discountBps: DEMO_DISCOUNT, signer: stranger }).rpc()),
        "Unauthorized",
      );
    });

    it("refuses a discount of 100% and accepts 99.99%", async () => {
      assert.equal(await h.refusal(initPoolIx(h, { usdcMint, stockMint, discountBps: 10_000 }).rpc()), "InvalidParams");

      await initPoolIx(h, { usdcMint, stockMint, discountBps: 9_999 }).rpc();
      const state = await fetchAccount<Pool>(h.program, "liquidationPool", poolAddress(h.program, usdcMint, stockMint)[0]);
      assert.equal(state.discountBps, 9_999);
    });

    it("refuses a Token-2022 USDC mint, the fee-on-transfer route to a reserve bigger than its money", async () => {
      const t22Usdc = newUsdcMint(TOKEN_2022_PROGRAM);
      assert.equal(
        await h.refusal(initPoolIx(h, { usdcMint: t22Usdc, stockMint, discountBps: DEMO_DISCOUNT, usdcTokenProgram: TOKEN_2022_PROGRAM }).rpc()),
        "InvalidParams",
      );
    });

    it("refuses a stock mint outside the allowlist, byte-identical or not", async () => {
      const counterfeit = anchor.web3.Keypair.generate().publicKey;
      h.placeMint("NFLXx", counterfeit);
      assert.equal(
        await h.refusal(initPoolIx(h, { usdcMint, stockMint: counterfeit, discountBps: DEMO_DISCOUNT }).rpc()),
        "MintNotAllowed",
      );
    });

    it("still succeeds when a stranger created the pool's vault first", async () => {
      // Anyone may create an associated token account for any owner. With a
      // plain `init` on the vault, this one transaction would block init_pool
      // for this pair forever.
      const stranger = h.fund();
      const [pool] = poolAddress(h.program, usdcMint, stockMint);
      const vault = ataAddress(usdcMint, pool, SPL_TOKEN_PROGRAM);
      const create = new anchor.web3.TransactionInstruction({
        programId: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
        keys: [
          { pubkey: stranger.publicKey, isSigner: true, isWritable: true },
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: pool, isSigner: false, isWritable: false },
          { pubkey: usdcMint, isSigner: false, isWritable: false },
          { pubkey: anchor.web3.SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM), isSigner: false, isWritable: false },
        ],
        data: Buffer.alloc(0),
      });
      await send(h, create, stranger);
      assert.ok(await h.context.banksClient.getAccount(vault), "the stranger's vault exists before init_pool");

      await initPoolIx(h, { usdcMint, stockMint, discountBps: DEMO_DISCOUNT }).rpc();
      assert.ok(await h.context.banksClient.getAccount(pool));
    });

    it("binds create_circle: a circle is created against the pool init_pool made, and a discount above its haircut is refused", async () => {
      await initFeed(h, stockMint);
      await setPrices(h, stockMint, { wrapper: 150 * USDC, share: 150 * USDC, stamp: CURRENT, expected: ONE_X });
      await initPoolIx(h, { usdcMint, stockMint, discountBps: DEMO_DISCOUNT }).rpc();
      const [pool] = poolAddress(h.program, usdcMint, stockMint);

      const creator = h.fund();
      const members = [creator.publicKey, ...Array.from({ length: 4 }, () => anchor.web3.Keypair.generate().publicKey)];
      const create = (id: bigint, haircutBps: number) =>
        call(h.program, "createCircle", [
          {
            circleId: new BN(Number(id)),
            contribution: new BN(50 * USDC),
            roundSecs: new BN(120),
            graceSecs: new BN(60),
            haircutBps,
            coverageBps: 13_000,
            warnBps: 11_000,
            guaranteePerMember: new BN(35 * USDC),
            minStockCover: new BN(120 * USDC),
            maxPriceAge: new BN(691_200),
          },
          members,
        ])
          .accounts({
            creator: creator.publicKey,
            circle: circleAddress(h.program, creator.publicKey, id),
            stockMint,
            usdcMint,
            priceFeed: priceFeedAddress(h.program, stockMint),
            pool,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([creator])
          .rpc();

      // SPEC §5: pool.discount_bps <= haircut_bps, so H never exceeds what a
      // liquidation actually returns. 2000 against 1999 is one basis point over.
      assert.equal(await h.refusal(create(1n, 1_999)), "InvalidParams");

      await create(2n, 2_000);
      const circle = await fetchAccount<{ pool: anchor.web3.PublicKey; usdcMint: anchor.web3.PublicKey }>(
        h.program,
        "circle",
        circleAddress(h.program, creator.publicKey, 2n),
      );
      assert.ok(circle.pool.equals(pool));
      assert.ok(circle.usdcMint.equals(usdcMint));
    });
  });

  describe("seed_pool", () => {
    let pool: anchor.web3.PublicKey;
    let vault: anchor.web3.PublicKey;

    beforeEach(async () => {
      await initPoolIx(h, { usdcMint, stockMint, discountBps: DEMO_DISCOUNT }).rpc();
      [pool] = poolAddress(h.program, usdcMint, stockMint);
      vault = ataAddress(usdcMint, pool, SPL_TOKEN_PROGRAM);
    });

    it("moves the authority's own USDC into the pool and reports the new balance", async () => {
      giveUsdc(h.authority.publicKey, 1_000n * BigInt(USDC));

      const ix = await seedPoolIx(h, { usdcMint, stockMint, amount: 400n * BigInt(USDC) }).instruction();
      const meta = await send(h, ix, h.authority);

      assert.equal(await balance(vault), 400n * BigInt(USDC));
      assert.equal(await balance(ataAddress(usdcMint, h.authority.publicKey, SPL_TOKEN_PROGRAM)), 600n * BigInt(USDC));

      const event = decodeEvent<{ amount: { toString(): string }; poolUsdc: { toString(): string } }>(h.program, "poolSeeded", meta.logMessages);
      assert.ok(event, "PoolSeeded was emitted");
      assert.equal(event.amount.toString(), String(400 * USDC));
      assert.equal(event.poolUsdc.toString(), String(400 * USDC));
    });

    it("refuses a stranger, even one seeding with their own money", async () => {
      const stranger = h.fund();
      giveUsdc(stranger.publicKey, 100n * BigInt(USDC));
      assert.equal(
        await h.refusal(seedPoolIx(h, { usdcMint, stockMint, amount: 10n * BigInt(USDC), signer: stranger }).rpc()),
        "Unauthorized",
      );
      assert.equal(await balance(vault), 0n);
    });

    it("refuses zero and refuses more than the authority holds", async () => {
      giveUsdc(h.authority.publicKey, 5n * BigInt(USDC));
      assert.equal(await h.refusal(seedPoolIx(h, { usdcMint, stockMint, amount: 0n }).rpc()), "InvalidParams");
      assert.equal(
        await h.refusal(seedPoolIx(h, { usdcMint, stockMint, amount: 5n * BigInt(USDC) + 1n }).rpc()),
        "InsufficientBalance",
      );
      assert.equal(await balance(vault), 0n);
    });
  });
});
