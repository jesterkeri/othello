/**
 * A6 adversary (on 7a9ded2, PR #25, the shared circles list). Spec rule 1: "a step the chain would accept is not hidden
 * behind a wrong state", and the card's figures "match the chain for that wallet". SPEC.md:129 (payout gate): "Paused is
 * defined on-chain as next_gate_short_by > 0; the UI never computes it". SPEC.md:113 top_up_reserve needs only Active and
 * a seat not in default (no price check); SPEC.md:226 ("Payout gate: reserve") names "Top up {short_by}".
 *
 * app/src/lib/core/circle-card.ts shows the Paused figure and its Top up only when `v.releasable`, and on Solana
 * releasable (releaseBlock) is false whenever the price is stale or repricing. So a round where every seat has paid and
 * the chain's stored next_gate_short_by says Paused, read while the price is stale, falls through to the plain
 * "Round 2 of 4: Seat 2 receives 200 USDC" (band Active, nothing in Needs-you): the recipient is not told that the
 * pot is paused, nor offered the top-up the chain accepts now and the release needs. 7a9ded2 fixed exactly this for
 * an escrow-short round ("top up X, then the pot can move once the price is updated"); the Paused round is not.
 *
 * Real program in bankrun: round 1 pays out, the price falls, update_coverage stores Paused, every seat pays round 2,
 * then the feed goes stale. The test does what the card implies is all that is left (a fresh price, same values and
 * stamp) and tries the release: it is refused (reserve_overcommitted), so the card must name the top-up.
 *
 *   anchor build && npx mocha --import=tsx --timeout 300000 tests/a6-circles-paused-stale-adversary.spec.ts
 */
import assert from "node:assert/strict";

import * as anchor from "@coral-xyz/anchor";

import {
  ASSOCIATED_TOKEN_PROGRAM, BEFORE_SPLIT, BN, CURRENT, FIXTURE_MINTS, ONE_X, SPL_TOKEN_PROGRAM, TEN_X, TOKEN_2022_PROGRAM,
  ataAddress, call, circleAddress, fetchAccount, harness, initFeed, initPoolIx, poolAddress, priceFeedAddress, seedPoolIx,
  send, setPrices, SPLIT_AT, splMintAccount, tokenAccount, type Harness,
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

describe("A6 adversary: a Paused round read while the price is stale shows as an ordinary running round", function () {
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
  const updateCoverage = (caller: anchor.web3.Keypair) =>
    call(h.program, "updateCoverage", [])
      .accounts({ caller: caller.publicKey, circle, stockMint, priceFeed: priceFeedAddress(h.program, stockMint) })
      .remainingAccounts(memberMetas()).signers([caller]).rpc();

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

  it("a recipient whose round the chain stores as Paused is told so and offered the top-up, even while the price is stale", async () => {
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

    // round 1, paid and released to seat 1
    for (const w of wallets) await contribute(w);
    await send(h, await (await releaseIx(creator)).instruction(), creator);
    // the price falls (stamped after the fixture's split, as the escrow-short specs do); update_coverage stores Paused
    await h.setClock(SPLIT_AT + 10);
    await setPrices(h, stockMint, { wrapper: 10 * USDC, share: 1 * USDC, stamp: CURRENT, expected: TEN_X });
    await updateCoverage(h.fund());
    // round 2: every seat pays, so nothing but the gate stands in the way
    for (const w of wallets) await contribute(w);

    const c = await readCircle();
    assert.equal(c.round, 1, "precondition: round 2, which seat 2 receives");
    assert.ok(big(c.escrow) >= 0n && big(c.escrowDeficit) === 0n, "precondition: no default, no escrow deficit");
    assert.ok(big(c.nextGateShortBy) > 0n, `precondition: the chain stores Paused (next_gate_short_by ${c.nextGateShortBy})`);

    // no price update for longer than max_price_age: the feed is stale by the chain's clock
    const checkedAt = Number((await h.context.banksClient.getClock()).unixTimestamp);
    await h.setClock(checkedAt + PARAMS.maxPriceAge + 1);
    const now = Number((await h.context.banksClient.getClock()).unixTimestamp);
    const recipient = wallets[1]!;
    const me = recipient.publicKey.toBase58();
    const live = await appView(now);
    assert.ok(isStale(live.view, now), "precondition: the app itself reads the price as stale");
    const card = circleCard(solToList(live, me), me);
    const said = `card "${card.headline}" (${card.band}, ${card.group}, ${card.action})`;

    // do what that card leaves as the only thing to happen: the price is updated, fresh, same values and stamp (one
    // base unit above, so the transaction is not a byte-for-byte repeat)
    await setPrices(h, stockMint, { wrapper: 10 * USDC + 1, share: 1 * USDC, stamp: CURRENT, expected: TEN_X });
    const caller = h.fund();
    const refused = await h.refusal((await releaseIx(caller)).rpc()).catch((e: unknown) => {
      if (String(e).includes("expected the instruction to be refused, but it succeeded")) return "";
      throw e;
    });
    // the pot moved after the price update alone: the card told the truth
    if (refused === "") return;
    // it did not: the card must say the round is paused and name the top-up the chain accepts now (SPEC.md:113, :226)
    assert.ok(
      card.action === "Top up" && /paused|short/i.test(card.headline),
      `${said}; the chain stores next_gate_short_by ${c.nextGateShortBy} (Paused, SPEC.md:129) and, after the price ` +
        `was updated, release_pot refused with ${refused}, but the card neither says Paused nor offers the top-up ` +
        `that top_up_reserve accepts now (no price check, SPEC.md:113)`,
    );
  });
});
