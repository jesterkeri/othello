/**
 * A6 adversary (on 8c00fff, PR #25, the shared circles list). Spec rule 1: "every amount, count, time and seat marking
 * shown agrees with the chain and with every other place on the page that shows the same thing".
 *
 * 8c00fff added a headline for a round blocked only by the price: "Round N is paid: X moves to Seat K once the ...
 * price is updated" (app/src/lib/core/circle-card.ts, the `!v.priceReady` line). It is reached whenever every seat has
 * paid OR been settled in default, so a round with a seat settled in default is called "paid" while that seat's paid
 * bit is clear (release_pot sets it only when it pays that seat's share from the escrow, SPEC.md:109). The same hero
 * tile counts the chain's paid bits ("3 of 4 paid this round · 1 settled in default", HeroSeats; "✓ 3 of 4 paid",
 * HeroStickers), and the phone card says "3 of 4 paid": the page says both "the round is paid" and "3 of 4 paid".
 *
 * Real program in bankrun: round 1 pays out; in round 2 seat 1 misses its payment and is declared in default with its
 * stock covering everything it owes (escrow 150, no deficit, not Paused); seats 2 to 4 pay; then the feed goes stale.
 * The real CircleCard (hero) is rendered with react-dom/server from solToList of that read.
 *
 *   anchor build && npx mocha --import=tsx --timeout 300000 tests/a6-circles-paid-wording-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as anchor from "@coral-xyz/anchor";

import {
  ASSOCIATED_TOKEN_PROGRAM, BEFORE_SPLIT, BN, CURRENT, FIXTURE_MINTS, ONE_X, SPL_TOKEN_PROGRAM, TEN_X, TOKEN_2022_PROGRAM,
  ataAddress, call, circleAddress, fetchAccount, harness, initFeed, initPoolIx, poolAddress, priceFeedAddress, seedPoolIx,
  send, setPrices, splMintAccount, tokenAccount, type Harness,
} from "./harness.ts";
import { REPO } from "./artifacts.ts";
import { decodeLive, type LiveCircle } from "../app/src/lib/live.ts";
import { solToList } from "../app/src/lib/to-list-solana.ts";
import { circleCard } from "../app/src/lib/core/circle-card.ts";
import { isStale } from "../app/src/lib/circle.ts";

const SRC = resolve(REPO, "app/src");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));

registerHooks({
  resolve(specifier, context, next) {
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    if (specifier.endsWith(".module.css")) return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
    if (specifier.startsWith("@/")) {
      const base = resolve(SRC, specifier.slice(2));
      for (const ext of [".ts", ".tsx", "/index.ts", ""]) {
        try {
          readFileSync(base + ext);
          return next(pathToFileURL(base + ext).href, context);
        } catch {
          /* try the next extension */
        }
      }
    }
    return next(specifier, context);
  },
});

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

describe("A6 adversary: a round with a seat settled in default is called paid while the same tile says 3 of 4 paid", function () {
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

  it("the headline does not call the round paid while the tile counts a seat as not paid", async () => {
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
    // round 2: seats 2 to 4 pay; seat 1 does not and is declared in default after the grace period. The price is
    // restamped for the fixture mint's 10x split at the same value per position (FUND = EXEC = 300 for 2 tokens), so
    // the sale covers all 150 seat 1 still owes: no deficit, no Paused
    for (const w of wallets.slice(1)) await contribute(w);
    await h.setClock(Number(big((await readCircle()).roundDeadline)) + PARAMS.graceSecs + 1);
    await setPrices(h, stockMint, { wrapper: PRICE, share: PRICE / 10, stamp: CURRENT, expected: TEN_X });
    await declare(0);

    const c = await readCircle();
    assert.equal(c.round, 1, "precondition: round 2, which seat 2 receives");
    assert.ok(big(c.escrow) >= BigInt(C), `precondition: escrow ${c.escrow} covers the 50 owed for seat 1`);
    assert.equal(big(c.escrowDeficit), 0n, "precondition: no escrow deficit");
    assert.equal(big(c.nextGateShortBy), 0n, "precondition: not Paused");

    // no price update for longer than max_price_age: the feed is stale by the chain's clock
    const declaredAt = Number((await h.context.banksClient.getClock()).unixTimestamp);
    await h.setClock(declaredAt + PARAMS.maxPriceAge + 1);
    const now = Number((await h.context.banksClient.getClock()).unixTimestamp);
    const live = await appView(now);
    assert.ok(isStale(live.view, now), "precondition: the app itself reads the price as stale");

    const me = wallets[2]!.publicKey.toBase58();
    const v = solToList(live, me);
    const paidBits = v.seats.filter((s) => s.paid).length;
    assert.equal(paidBits, 3, "precondition: the chain has three paid bits this round");
    assert.ok(v.seats[0]!.defaulted && !v.seats[0]!.paid, "precondition: seat 1 is settled in default, not paid");
    const card = circleCard(v, me);

    const React = appRequire("react");
    (globalThis as { React?: unknown }).React = React;
    const { renderToStaticMarkup } = appRequire("react-dom/server");
    const { default: CircleCard } = await import(pathToFileURL(resolve(SRC, "components/circles/CircleCard.tsx")).href);
    const html: string = renderToStaticMarkup(React.createElement(CircleCard, { v, me, card, design: "hero", area: "a", tone: "" }));
    const text = html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const counts = [...text.matchAll(/\d+ of 4 paid(?: this round)?/g)].map((m) => m[0]);
    assert.ok(counts.length > 0, "precondition: the hero shows its paid counts");

    // one tile, one round: it is either paid (every seat's paid bit set) or "3 of 4 paid", not both
    assert.ok(
      !/\bis paid\b/i.test(card.headline) || paidBits === v.n,
      `the hero tile's headline says "${card.headline}" while the same tile says ${counts.map((x) => `"${x}"`).join(" and ")}; ` +
        `the chain has ${paidBits} of ${v.n} paid bits set (seat 1 is settled in default, paid from the escrow only by release_pot)`,
    );
  });
});
