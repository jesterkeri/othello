/**
 * T18 adversary: app/src/lib/live.ts's decodeLive against what the program
 * itself decides, for a real allowlisted xStock whose multiplier is not a
 * round number.
 *
 * Requirement under test: SPEC.md I5, "mult_fixed = floor(true_value x 1e9)
 * exactly; vectors 1002664207, 1003269012", and app/src/lib/circle.ts's
 * header, the app only LABELS what the chain decided. The chain stamps and
 * quotes AAPLx's real multiplier 1.0026642075893797 as 1002664207; the live
 * reader must show that same number, and must not call the circle Repricing
 * while the program says its prices are current.
 *
 * Mint bytes: tests/fixtures/AAPLx.json (real mainnet account, T00 provenance),
 * placed by the shared harness. Feed bytes: written by the program's own
 * set_prices in bankrun. Circle bytes: encoded with the deployed IDL's coder.
 */
import assert from "node:assert/strict";

import * as anchor from "@coral-xyz/anchor";

import {
  BN,
  CURRENT,
  FIXTURE_MINTS,
  USDC,
  decodeValuation,
  harness,
  initFeed,
  priceFeedAddress,
  quoteIx,
  send,
  setPrices,
  type Harness,
} from "./harness.ts";
import { derive } from "../app/src/lib/circle.ts";
import { accountsCoder, decodeLive } from "../app/src/lib/live.ts";

/** AAPLx's scheduled change on the real mint (DONE.md:585). */
const AAPLX_EFFECTIVE_AT = 1_786_149_000;
const BEFORE = AAPLX_EFFECTIVE_AT - 1_000;

describe("T18 adversary: the live reader's multiplier against the program's", () => {
  let h: Harness;
  const mint = new anchor.web3.PublicKey(FIXTURE_MINTS.AAPLx);

  beforeEach(async () => {
    h = await harness(["AAPLx"]);
    await h.setClock(BEFORE);
    await initFeed(h, mint);
  });

  it("shows the multiplier the chain stamped for AAPLx, and no Repricing the program does not see", async () => {
    // The program accepts 1002664207 as the multiplier in force (I5 vector).
    await setPrices(h, mint, { wrapper: 230 * USDC, share: 229 * USDC, stamp: CURRENT, expected: 1_002_664_207 });

    // And quote_valuation, which refuses a feed priced for another multiplier,
    // answers with that same number.
    const quoted = decodeValuation(await send(h, await quoteIx(h, mint, { raw: 100_000_000, haircutBps: 2000, maxPriceAge: 691_200 })));
    assert.equal(quoted.multFixed, 1_002_664_207n, "the program's own effective multiplier");

    const coder = accountsCoder();
    const pk = () => anchor.web3.Keypair.generate().publicKey;
    const wallets = Array.from({ length: 5 }, pk);
    const circle = await coder.encode("circle", {
      creator: wallets[0], circleId: new BN(0), bump: 255,
      stockMint: mint, usdcMint: pk(), priceFeed: priceFeedAddress(h.program, mint), pool: pk(),
      n: 5, members: [...wallets, ...Array.from({ length: 3 }, () => anchor.web3.PublicKey.default)],
      contribution: new BN(50 * USDC), roundSecs: new BN(120), graceSecs: new BN(60),
      haircutBps: 2000, coverageBps: 13000, warnBps: 11000,
      guaranteePerMember: new BN(35 * USDC), minStockCover: new BN(120 * USDC), maxPriceAge: new BN(691_200),
      status: { forming: {} }, round: 0, roundDeadline: new BN(0),
      paidBitmap: 0, joinedBitmap: 0, withdrawnBitmap: 0, receivedBitmap: 0, defaultedBitmap: 0,
      reserveTotal: new BN(0), reserveLosses: new BN(0), reserveAllocated: new BN(0),
      escrow: new BN(0), escrowDeficit: new BN(0), withdrawnUsdc: new BN(0), depositsTotal: new BN(0),
      forfeitedTotal: new BN(0), nextGateShortBy: new BN(0), heldContributions: new BN(0), lastCoverageAt: new BN(0),
    });

    const feedBytes = Buffer.from((await h.context.banksClient.getAccount(priceFeedAddress(h.program, mint)))!.data);
    const mintBytes = Buffer.from((await h.context.banksClient.getAccount(mint))!.data);

    const view = decodeLive({ circle, feed: feedBytes, mint: mintBytes, members: [null, null, null, null, null] }, "AAPLx", BEFORE);

    assert.equal(view.feed.pricedForMultiplier, 1_002_664_207, "the feed stamp as the chain wrote it");
    assert.equal(view.effectiveMultiplier, 1_002_664_207, "SPEC I5: floor(true_value x 1e9), as the program quotes it");
    assert.equal(derive(view, BEFORE).repricing, false, "the program quotes this feed, so the screen must not say Repricing");
  });
});
