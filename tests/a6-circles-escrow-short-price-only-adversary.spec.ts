/**
 * A6 adversary (on 21ed54f, PR #25, the shared circles list). Spec rule 1: "a step is offered only when the chain would
 * accept it from this wallet and would do what the card says it does", and "a step the chain would accept is not
 * hidden behind a wrong state". SPEC.md:109 release_pot needs "every seat paid OR defaulted; escrow >= k x c" as well as
 * "price fresh; not repricing"; SPEC.md:113 top_up_reserve needs only Active and a seat not in default (no price check),
 * and SPEC.md:228 ("Round not funded: escrow short") says any member tops up {short_by}.
 *
 * 21ed54f (app/src/lib/core/circle-card.ts, the escrow-short branch with !priceReady) tells the recipient "Missed
 * payments left the pot short (...): X. The pot can move once the {stock} price is updated", with no Top up step. The
 * escrow is still short after a price update, so release_pot still refuses (RoundNotFunded); the top-up the chain
 * would accept now, and that the release needs, is hidden behind a state that names the price as the only blocker.
 *
 * Same circle as a6-circles-escrow-short-stale-adversary (real program in bankrun): seat 1 is declared in default in
 * round 2, the escrow is short, then the feed goes stale. The test does what the card waits for (a fresh price at the
 * same values and stamp) and tries the release: it is refused RoundNotFunded. A card that names the top-up passes.
 *
 *   anchor build && npx mocha --import=tsx --timeout 300000 tests/a6-circles-escrow-short-price-only-adversary.spec.ts
 */
import assert from "node:assert/strict";

import * as anchor from "@coral-xyz/anchor";

import {
  ASSOCIATED_TOKEN_PROGRAM, BEFORE_SPLIT, BN, CURRENT, FIXTURE_MINTS, ONE_X, SPL_TOKEN_PROGRAM, TEN_X, TOKEN_2022_PROGRAM,
  ataAddress, call, circleAddress, fetchAccount, harness, initFeed, initPoolIx, poolAddress, priceFeedAddress, seedPoolIx,
  send, setPrices, splMintAccount, tokenAccount, type Harness,
} from "./harness.ts";
import { decodeLive, type LiveCircle } from "../app/src/lib/live.ts";
import { solToList } from "../app/src/lib/to-list-solana.ts";
import { circleCard } from "../app/src/lib/core/circle-card.ts";
import { isStale } from "../app/src/lib/circle.ts";

const USDC = 1_000_000;
const N = 4;
const C = 50 * USDC;
const PARAMS = {
  contribution: C, roundSecs: 120, graceSecs: 60, haircutBps: 2000, coverageBps: 13_000, warnBps: 11_000,
  guaranteePerMember: 1, minStockCover: 195 * USDC, maxPriceAge: 691_200,
};
const LOCK_RAW = 200_000_000n; // 2 tokens: EXEC 300 at 150, H 240 >= 195
const PRICE = 150 * USDC;
const DISCOUNT = 2000;
const POOL_SEED = 1_000n * BigInt(USDC);

type Big = { toString(): string };
const big = (v: Big) => BigInt(v.toString());

describe("A6 adversary: an escrow-short round with a stale price says a price update will move the pot, but the escrow still blocks it", function () {
  this.timeout(300_000);
  let h: Harness;
  let stockMint: anchor.web3.PublicKey;
  let usdcMint: anchor.web3.PublicKey;
  let pool: anchor.web3.PublicKey;
  let wallets: anchor.web3.Keypair[];
  let circle: anchor.web3.PublicKey;

  const memberAddress = (wallet: anchor.web3.PublicKey) =>
    anchor.web3.PublicKey.findProgramAddressSync([Buffer.from("member"), circle.toBuffer(), wallet.toBuffer()], h.program.programId)[0];
  const memberMetas = () => wallets.map((w) => ({ pubkey: memberAddress(w.publicKey), isWritable: true, isSigner: false }));
  const put = (mint: anchor.web3.PublicKey, owner: anchor.web3.PublicKey, amount: bigint, program: string) => {
    const t = tokenAccount({ mint, owner, amount, tokenProgram: program });
    h.putAccount(ataAddress(mint, owner, program), t.data, t.owner);
  };
  const raw = async (k: anchor.web3.PublicKey) => Buffer.from((await h.context.banksClient.getAccount(k))!.data);
  const readCircle = () => fetchAccount<{ round: number; roundDeadline: Big; escrow: Big; escrowDeficit: Big; nextGateShortBy: Big }>(h.program, "circle", circle);

  const join = (w: anchor.web3.Keypair) =>
    call(h.program, "joinAndLock", [new BN(LOCK_RAW.toString())])
      .accounts({
        wallet: w.publicKey, circle, member: memberAddress(w.publicKey), stockMint, usdcMint,
        priceFeed: priceFeedAddress(h.program, stockMint),
        memberStockAta: ataAddress(stockMint, w.publicKey, TOKEN_2022_PROGRAM),
        memberUsdcAta: ataAddress(usdcMint, w.publicKey, SPL_TOKEN_PROGRAM),
        circleStockVault: ataAddress(stockMint, circle, TOKEN_2022_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
        associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([w]).rpc();
  const contribute = (w: anchor.web3.Keypair) =>
    call(h.program, "contribute", [])
      .accounts({
        wallet: w.publicKey, circle, member: memberAddress(w.publicKey), usdcMint,
        memberUsdcAta: ataAddress(usdcMint, w.publicKey, SPL_TOKEN_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
      })
      .signers([w]).rpc();
  const releaseIx = async (caller: anchor.web3.Keypair) => {
    const recipient = wallets[(await readCircle()).round]!.publicKey;
    return call(h.program, "releasePot", [])
      .accounts({
        caller: caller.publicKey, circle, stockMint, usdcMint, priceFeed: priceFeedAddress(h.program, stockMint), recipient,
        recipientUsdcAta: ataAddress(usdcMint, recipient, SPL_TOKEN_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
        associatedTokenProgram: new anchor.web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM),
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .remainingAccounts(memberMetas()).signers([caller]);
  };
  const declare = async (turn: number) => {
    const caller = h.fund();
    const ix = await call(h.program, "declareDefault", [turn])
      .accounts({
        caller: caller.publicKey, circle, stockMint, usdcMint, priceFeed: priceFeedAddress(h.program, stockMint), pool,
        circleStockVault: ataAddress(stockMint, circle, TOKEN_2022_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        poolStockVault: ataAddress(stockMint, pool, TOKEN_2022_PROGRAM),
        poolUsdcVault: ataAddress(usdcMint, pool, SPL_TOKEN_PROGRAM),
        stockTokenProgram: new anchor.web3.PublicKey(TOKEN_2022_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
      })
      .remainingAccounts(memberMetas()).signers([caller]).instruction();
    await send(h, ix, caller);
  };
  const topUp = (w: anchor.web3.Keypair, amount: bigint) =>
    call(h.program, "topUpReserve", [new BN(amount.toString())])
      .accounts({
        wallet: w.publicKey, circle, member: memberAddress(w.publicKey), usdcMint,
        memberUsdcAta: ataAddress(usdcMint, w.publicKey, SPL_TOKEN_PROGRAM),
        circleUsdcVault: ataAddress(usdcMint, circle, SPL_TOKEN_PROGRAM),
        usdcTokenProgram: new anchor.web3.PublicKey(SPL_TOKEN_PROGRAM),
      })
      .signers([w]).rpc();

  async function appView(now: number): Promise<LiveCircle> {
    const view = decodeLive(
      {
        circle: await raw(circle),
        feed: await raw(priceFeedAddress(h.program, stockMint)),
        mint: await raw(stockMint),
        members: await Promise.all(wallets.map((w) => raw(memberAddress(w.publicKey)))),
      },
      "NFLXx",
      now,
    );
    return {
      view,
      accounts: { circle: circle.toBase58(), usdcMint: usdcMint.toBase58(), stockMint: stockMint.toBase58() },
      split: { multiplier: 1e9, newMultiplier: 1e9, effectiveAt: 0 },
      pool: { discountBps: DISCOUNT, usdc: 0 },
      readAt: now,
    };
  }

  it("after only the price update the card waits for, release_pot releases the pot (or the card names the top-up the chain still needs)", async () => {
    h = await harness(["NFLXx"]);
    stockMint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);
    usdcMint = anchor.web3.Keypair.generate().publicKey;
    const mint = splMintAccount(6);
    h.putAccount(usdcMint, mint.data, mint.owner);
    await h.setClock(BEFORE_SPLIT);
    await initFeed(h, stockMint);
    await setPrices(h, stockMint, { wrapper: PRICE, share: PRICE, stamp: CURRENT, expected: ONE_X });
    await initPoolIx(h, { usdcMint, stockMint, discountBps: DISCOUNT }).rpc();
    [pool] = poolAddress(h.program, usdcMint, stockMint);
    put(usdcMint, h.authority.publicKey, POOL_SEED, SPL_TOKEN_PROGRAM);
    await seedPoolIx(h, { usdcMint, stockMint, amount: POOL_SEED }).rpc();

    wallets = Array.from({ length: N }, () => h.fund(100 * anchor.web3.LAMPORTS_PER_SOL));
    const creator = wallets[0]!;
    circle = circleAddress(h.program, creator.publicKey, 0n);
    await call(h.program, "createCircle", [
      {
        circleId: new BN(0), contribution: new BN(PARAMS.contribution), roundSecs: new BN(PARAMS.roundSecs),
        graceSecs: new BN(PARAMS.graceSecs), haircutBps: PARAMS.haircutBps, coverageBps: PARAMS.coverageBps,
        warnBps: PARAMS.warnBps, guaranteePerMember: new BN(PARAMS.guaranteePerMember),
        minStockCover: new BN(PARAMS.minStockCover), maxPriceAge: new BN(PARAMS.maxPriceAge),
      },
      wallets.map((w) => w.publicKey),
    ])
      .accounts({
        creator: creator.publicKey, circle, stockMint, usdcMint, priceFeed: priceFeedAddress(h.program, stockMint), pool,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([creator]).rpc();
    for (const w of wallets) {
      put(stockMint, w.publicKey, LOCK_RAW, TOKEN_2022_PROGRAM);
      put(usdcMint, w.publicKey, 1_000n * BigInt(USDC), SPL_TOKEN_PROGRAM);
    }
    for (const w of wallets) await join(w);
    await call(h.program, "activate", []).accounts({ creator: creator.publicKey, circle }).signers([creator]).rpc();

    // round 0, paid and released to seat 1
    for (const w of wallets) await contribute(w);
    await send(h, await (await releaseIx(creator)).instruction(), creator);
    // round 1: seats 2 to 4 pay; seat 1 does not; the price falls; seat 1 is declared in default
    for (const w of wallets.slice(1)) await contribute(w);
    await h.setClock(Number(big((await readCircle()).roundDeadline)) + PARAMS.graceSecs + 1);
    await setPrices(h, stockMint, { wrapper: 10 * USDC, share: 1 * USDC, stamp: CURRENT, expected: TEN_X });
    await declare(0);

    const c = await readCircle();
    assert.equal(c.round, 1, "precondition: round 2, which seat 2 receives");
    assert.ok(big(c.escrow) < BigInt(C), `precondition: escrow ${c.escrow} is below the 50 owed for seat 1 (RoundNotFunded)`);
    // no price update for longer than max_price_age: the feed is stale by the chain's clock
    const declaredAt = Number((await h.context.banksClient.getClock()).unixTimestamp);
    await h.setClock(declaredAt + PARAMS.maxPriceAge + 1);
    const now = Number((await h.context.banksClient.getClock()).unixTimestamp);
    const recipient = wallets[1]!;
    const me = recipient.publicKey.toBase58();
    const live = await appView(now);
    assert.ok(isStale(live.view, now), "precondition: the app itself reads the price as stale");
    const card = circleCard(solToList(live, me), me);
    const said = `card "${card.headline}" (${card.group}, ${card.action})`;

    // the chain would take seat 2's top-up right now (no price check), which the release needs before anything else
    assert.ok(big(c.escrowDeficit) > 0n, "precondition: the escrow deficit a top-up fills first is above 0");

    // do exactly what the card waits for: the price is updated, fresh by the chain's clock, same stamp (one base unit
    // above the last wrapper price, so the transaction is not a byte-for-byte repeat of the earlier one)
    await setPrices(h, stockMint, { wrapper: 10 * USDC + 1, share: 1 * USDC, stamp: CURRENT, expected: TEN_X });
    const fresh = await appView(Number((await h.context.banksClient.getClock()).unixTimestamp));
    assert.ok(!isStale(fresh.view, fresh.readAt), "precondition: the price is fresh again");
    assert.ok(big((await readCircle()).escrow) < BigInt(C), "precondition: the escrow is still short of the 50 owed for seat 1");

    const caller = h.fund();
    const refused = await h.refusal((await releaseIx(caller)).rpc()).catch((e: unknown) => {
      if (String(e).includes("expected the instruction to be refused, but it succeeded")) return "";
      throw e;
    });
    // the pot moved after the price update alone: the card told the truth
    if (refused === "") return;
    // it did not: the card must then name the top-up the chain still needs (SPEC.md:228 "Any member tops up {short_by}")
    assert.ok(
      card.action === "Top up" || /top up/i.test(card.headline),
      `${said}; after the price was updated, release_pot still refused with ${refused} (escrow short, SPEC.md:109), ` +
        `so the pot cannot move on the price update the card names, and the top-up that SPEC.md:113 accepts now is not named`,
    );
  });
});
