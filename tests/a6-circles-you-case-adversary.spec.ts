/**
 * A6 adversary on b1cb461 (PR #25, the shared circles list). Spec 1: "Each card's figures ... match the chain for that
 * wallet". lib/core/circle-list.ts compares base58 addresses exactly (092c768: "Base58 addresses compare exactly (EVM
 * ones still ignore case)"), but the ring the shared tiles draw (lib/core/ring.ts ringOf, `same`) and the seat dots
 * (components/circles/CircleCard.tsx, `same`) still lower-case both sides, as they did when they served Robinhood only.
 * Base58 is case-sensitive: two addresses that differ only in case are two different keys. create_circle
 * (programs/othello/src/instructions/create_circle.rs) checks members only for the default key and duplicates, so a
 * creator may name any 32 bytes, including the case-swapped twin of the wallet's address.
 *
 * Attack: a stranger's Forming circle naming the stranger, the wallet, and the wallet's case-swapped twin; the stranger
 * and the wallet have joined (so it is a circle the wallet chose, drawn as a running tile). The hero tile marks both
 * the wallet's seat and its twin's seat "(you)".
 *
 * The chain side is the real solanaCirclesOf over account bytes built with the deployed program's own IDL coder
 * (accountsCoder), in the shape tests/a6-circles-failed-count-adversary.spec.ts uses; the Connection is a stub that
 * answers the three read calls from those bytes and sends nothing. The page side is solToList and the real
 * CirclesBoard rendered with react-dom/server.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a6-circles-you-case-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as anchor from "@coral-xyz/anchor";

import { REPO } from "./artifacts.ts";
import { IDL, accountsCoder, memberAddress } from "../app/src/lib/live.ts";
import { solanaCirclesOf } from "../app/src/lib/solana-circles.ts";
import { solToList } from "../app/src/lib/to-list-solana.ts";
import { circleCard } from "../app/src/lib/core/circle-card.ts";
import { mySeat } from "../app/src/lib/core/circle-list.ts";

const SRC = resolve(REPO, "app/src");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".module.css")) {
      return { url: `data:text/javascript,${encodeURIComponent("export default new Proxy({}, { get: (_, k) => String(k) });")}`, shortCircuit: true };
    }
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

const { BN } = (anchor as unknown as { default: { BN: new (v: number | string) => unknown } }).default;
const PublicKey = anchor.web3.PublicKey;
type Key = InstanceType<typeof PublicKey>;
const USDC = 1_000_000;

/** The wallet's address with one lower-case letter upper-cased: a different, valid 32-byte key. */
function caseTwin(addr: string): Key {
  for (let i = 1; i < addr.length; i++) {
    const ch = addr[i]!;
    const up = ch.toUpperCase();
    if (up === ch || up === "I" || up === "O") continue;
    const twin = addr.slice(0, i) + up + addr.slice(i + 1);
    try {
      const k = new PublicKey(twin);
      if (k.toBase58() === twin) return k;
    } catch {
      /* try the next letter */
    }
  }
  throw new Error("no case twin");
}

describe("A6 adversary: a case-swapped twin of the wallet's address is drawn as the wallet's own seat", () => {
  const coder = accountsCoder();
  const programId = new PublicKey(IDL.address);
  const pk = () => anchor.web3.Keypair.generate().publicKey;
  const me = pk();
  const stranger = pk();
  const twin = caseTwin(me.toBase58());
  const feedKey = pk();
  const mintKey = pk();
  const poolKey = pk();

  it("marks only the wallet's own seat as (you)", async () => {
    assert.notEqual(twin.toBase58(), me.toBase58());
    assert.equal(twin.toBase58().toLowerCase(), me.toBase58().toLowerCase(), "precondition: the twin differs only in case");

    const circle = pk();
    const members = [stranger, me, twin];
    const joined = 0b011; // the stranger and the wallet have joined; the twin never will
    const circleBytes = await coder.encode("circle", {
      creator: stranger, circleId: new BN("7"), bump: 255,
      stockMint: mintKey, usdcMint: pk(), priceFeed: feedKey, pool: poolKey,
      n: 3, members: [...members, ...Array.from({ length: 5 }, () => PublicKey.default)],
      contribution: new BN(50 * USDC), roundSecs: new BN(120), graceSecs: new BN(60),
      haircutBps: 2000, coverageBps: 13000, warnBps: 11000,
      guaranteePerMember: new BN(35 * USDC), minStockCover: new BN(120 * USDC), maxPriceAge: new BN(691_200),
      status: { forming: {} }, round: 0, roundDeadline: new BN(0),
      paidBitmap: 0, joinedBitmap: joined, withdrawnBitmap: 0, receivedBitmap: 0, defaultedBitmap: 0,
      reserveTotal: new BN(70 * USDC), reserveLosses: new BN(0), reserveAllocated: new BN(0),
      escrow: new BN(0), escrowDeficit: new BN(0), withdrawnUsdc: new BN(0), depositsTotal: new BN(70 * USDC),
      forfeitedTotal: new BN(0), nextGateShortBy: new BN(0), heldContributions: new BN(0), lastCoverageAt: new BN(0),
    });
    const memberAccounts = new Map<string, Buffer>();
    for (const [t, w] of members.entries()) {
      if (!(joined & (1 << t))) continue;
      memberAccounts.set(memberAddress(programId, circle, w).toBase58(), await coder.encode("member", {
        circle, wallet: w, turn: t, bump: 255, stockRaw: new BN(110_000_000), guarantee: new BN(35 * USDC),
        topUps: new BN(0), forfeited: new BN(0), roundsPaid: 0, allocated: new BN(0), lastCoverageBps: 0,
      }));
    }
    const feed = await coder.encode("priceFeed", {
      authority: pk(), stockMint: mintKey, bump: 255, wrapperPrice: new BN(150 * USDC), sharePrice: new BN(150 * USDC),
      pricedForMultiplier: new BN("1000000000"), updatedAt: new BN(900),
    });
    const pool = await coder.encode("liquidationPool", { authority: pk(), bump: 255, discountBps: 500 });
    // a Token-2022 mint with only ScaledUiAmountConfig, the devnet mirror's exact layout (226 bytes), multiplier 1
    const mint = Buffer.alloc(226);
    mint[44] = 8;
    mint[45] = 1;
    mint[165] = 1;
    mint.writeUInt16LE(25, 166);
    mint.writeUInt16LE(56, 168);
    mint.writeDoubleLE(1, 170 + 32);
    mint.writeBigInt64LE(0n, 170 + 40);
    mint.writeDoubleLE(1, 170 + 48);
    const info = (data: Buffer) => ({ data, owner: programId, lamports: 1, executable: false });
    const connection = {
      getProgramAccounts: async () => [{ pubkey: circle, account: info(circleBytes) }],
      getAccountInfo: async (k: Key) => (k.equals(circle) ? info(circleBytes) : null),
      getMultipleAccountsInfo: async (keys: Key[]) => {
        const [, , , , ...seats] = keys;
        return [info(feed), info(mint), info(pool), info(Buffer.alloc(165)),
          ...seats.map((s) => (memberAccounts.has(s.toBase58()) ? info(memberAccounts.get(s.toBase58())!) : null))];
      },
    };

    const body = JSON.parse(JSON.stringify(await solanaCirclesOf(connection as never, me.toBase58())));
    assert.equal(body.circles.length, 1, "the circle is listed for the wallet");
    const wallet = me.toBase58();
    const v = solToList(body.circles[0], wallet);
    assert.equal(mySeat(v, wallet)?.turn, 1, "the list's own rule finds the wallet's seat (seat 2) exactly");
    const card = circleCard(v, wallet);

    const React = appRequire("react");
    (globalThis as { React?: unknown }).React = React;
    const { renderToStaticMarkup } = appRequire("react-dom/server");
    const { default: CirclesBoard } = await import(pathToFileURL(resolve(SRC, "components/circles/CirclesBoard.tsx")).href);
    const html: string = renderToStaticMarkup(React.createElement(CirclesBoard, { items: [{ v, card }], me: wallet, side: "solana" }));
    const yours = [...html.matchAll(/aria-label="(Seat \d \(you\)[^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(yours, ["Seat 2 (you): joined"], `the hero tile marks these seats as the wallet's: ${JSON.stringify(yours)}`);
  });
});
