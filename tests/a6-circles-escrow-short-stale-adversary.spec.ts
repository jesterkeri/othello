/**
 * A6 adversary (on e8b9c40, PR #25, the shared circles list). Spec rule 1: "a step is offered only when the chain would
 * accept it from this wallet and would do what the card says it does (a top-up offered to release a pot must, at the
 * amount named, make the release pass as of the read)". SPEC.md instruction table, release_pot (SPEC.md:109): the
 * preconditions include "price fresh; not repricing", and a stale feed is refused with price_stale.
 *
 * e8b9c40 (app/src/lib/core/circle-card.ts, the escrow-short branch) tells the recipient "top up {short_by} to release
 * your pot" whenever every seat is paid or settled and the escrow is short, without asking whether the chain would
 * release at all. lib/circle.ts releaseBlock returns "escrow-short" before it looks at the price, so a stale feed never
 * reaches the card. The Paused branch is guarded by `releasable`, which includes freshness; this branch is not.
 *
 * Same circle as a6-circles-escrow-short-gate-adversary (the t15-declare-default harness, real program in bankrun):
 * seat 1 is declared in default in round 2 and the escrow is short. Then the chain clock moves past max_price_age with
 * no price update (nobody has to do anything for this; a keeper simply has not pushed a price). The card for seat 2
 * (this round's recipient) still says to top up and release; seat 2 tops up exactly that; release_pot is refused.
 *
 *   anchor build && npx mocha --import=tsx --timeout 300000 tests/a6-circles-escrow-short-stale-adversary.spec.ts
 */
import assert from "node:assert/strict";

import * as anchor from "@coral-xyz/anchor";

import {
  ASSOCIATED_TOKEN_PROGRAM, BEFORE_SPLIT, BN, CURRENT, FIXTURE_MINTS, ONE_X, SPL_TOKEN_PROGRAM, TEN_X, TOKEN_2022_PROGRAM,
  ataAddress, call, circleAddress, fetchAccount, harness, initFeed, initPoolIx, poolAddress, priceFeedAddress, seedPoolIx,
  send, setPrices, splMintAccount, tokenAccount, type Harness,
  APPROVED_USDC,
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

describe("A6 adversary: an escrow-short round with a stale price is offered a top-up to release a pot the chain will not release", function () {
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

  it("seat 2 tops up exactly what its card names while the price is stale, and release_pot then releases the pot", async () => {
    h = await harness(["NFLXx"]);
    stockMint = new anchor.web3.PublicKey(FIXTURE_MINTS.NFLXx);
    usdcMint = APPROVED_USDC; // SPEC §4b: create_circle takes only the approved USDC mint
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
    // a card that does not promise the release with a top-up claims nothing this test checks
    if (card.action !== "Top up" || !/release your pot/i.test(card.headline)) return;
    const m = card.headline.match(/tops? up ([\d,.]+) USDC/i);
    assert.ok(m, `a Top up card names its amount: "${card.headline}"`);
    const [whole, frac = ""] = m[1]!.replace(/,/g, "").split(".");
    const named = BigInt(whole!) * BigInt(USDC) + BigInt(frac.padEnd(6, "0"));

    // seat 2 does exactly what the card says
    await topUp(recipient, named);
    const after = await readCircle();
    assert.ok(big(after.escrow) >= BigInt(C), `precondition: the top-up refilled the escrow (${after.escrow})`);

    const caller = h.fund();
    const sent = (await releaseIx(caller)).rpc();
    // h.refusal names the refusal code, and throws when the instruction succeeds: that is the outcome the card promised
    const refused = await h.refusal(sent).catch((e: unknown) => {
      if (String(e).includes("expected the instruction to be refused, but it succeeded")) return "";
      throw e;
    });
    if (refused === "") assert.equal((await readCircle()).round, 2, "the pot was released: round 3 is open");
    assert.equal(
      refused, "",
      `card "${card.headline}" (${card.group}, ${card.action}); after seat 2 topped up ${named} base units the program refused ` +
        `release_pot with ${refused} (the price is stale, SPEC.md:109 "price fresh")`,
    );
  });
});
