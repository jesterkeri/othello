/**
 * A6 adversary on 5c308b7: CirclesBoard (app/src/components/circles/CirclesBoard.tsx) draws only the first three
 * running circles (`running.slice(0, SHOWN)`), on desktop and on the phone (CirclesPhone gets the same `shown`). A
 * fourth running circle with nothing for the wallet to do is not "needs" (so not in the Needs-you pop-up), not finished
 * (so not in the pile), not failed and not counted in notShown (the server read it). It is nowhere on the page. The
 * board's "a member is in at most three at a time" is not enforced: no instruction under programs/othello/src limits how
 * many circles one wallet creates or joins, and the comment itself says "the join/create limit that enforces it is its
 * own change". Spec 3: "Every circle the server found is either on the page (a tile, the Needs-you pop-up, the finished
 * pile or its pop-up), a failed row with a link, or counted in "Showing N of M"".
 *
 * The chain side is the real solanaCirclesOf over account bytes built with the deployed program's own IDL coder
 * (accountsCoder), in the shape tests/a6-circles-board-invites-adversary.spec.ts uses; the Connection is a stub that
 * answers the three read calls from those bytes and sends nothing. Each circle goes through the real solToList, and the
 * real CirclesHome is rendered with react-dom/server from the source useSolanaCircles would build from that answer.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a6-circles-fourth-running-adversary.spec.ts
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

const { BN } = (anchor as unknown as { default: { BN: new (v: number | string) => unknown } }).default;
const PublicKey = anchor.web3.PublicKey;
type Key = InstanceType<typeof PublicKey>;
const USDC = 1_000_000;

describe("A6 adversary: a fourth running circle the wallet is in appears nowhere on the page", () => {
  const coder = accountsCoder();
  const programId = new PublicKey(IDL.address);
  const pk = () => anchor.web3.Keypair.generate().publicKey;
  const me = pk();
  const feedKey = pk();
  const mintKey = pk();
  const poolKey = pk();

  type Bits = { joined: number; paid: number };
  const circleBytes = (creator: Key, circleId: string, members: Key[], status: Record<string, unknown>, b: Bits) =>
    coder.encode("circle", {
      creator, circleId: new BN(circleId), bump: 255,
      stockMint: mintKey, usdcMint: pk(), priceFeed: feedKey, pool: poolKey,
      n: members.length, members: [...members, ...Array.from({ length: 8 - members.length }, () => PublicKey.default)],
      contribution: new BN(50 * USDC), roundSecs: new BN(120), graceSecs: new BN(60),
      haircutBps: 2000, coverageBps: 13000, warnBps: 11000,
      guaranteePerMember: new BN(35 * USDC), minStockCover: new BN(120 * USDC), maxPriceAge: new BN(691_200),
      status, round: 0, roundDeadline: new BN(1_000),
      paidBitmap: b.paid, joinedBitmap: b.joined, withdrawnBitmap: 0, receivedBitmap: 0, defaultedBitmap: 0,
      reserveTotal: new BN(105 * USDC), reserveLosses: new BN(0), reserveAllocated: new BN(0),
      escrow: new BN(0), escrowDeficit: new BN(0), withdrawnUsdc: new BN(0), depositsTotal: new BN(105 * USDC),
      forfeitedTotal: new BN(0), nextGateShortBy: new BN(0), heldContributions: new BN(0), lastCoverageAt: new BN(900),
    });
  const memberBytes = (circle: Key, wallet: Key, turn: number) =>
    coder.encode("member", {
      circle, wallet, turn, bump: 255, stockRaw: new BN(110_000_000), guarantee: new BN(35 * USDC),
      topUps: new BN(0), forfeited: new BN(0), roundsPaid: 0, allocated: new BN(0), lastCoverageBps: 0,
    });
  /** A Token-2022 mint with only ScaledUiAmountConfig, the devnet mirror's exact layout (226 bytes), multiplier 1. */
  const mint = () => {
    const b = Buffer.alloc(226);
    b[44] = 8;
    b[45] = 1;
    b[165] = 1;
    b.writeUInt16LE(25, 166);
    b.writeUInt16LE(56, 168);
    b.writeDoubleLE(1, 170 + 32);
    b.writeBigInt64LE(0n, 170 + 40);
    b.writeDoubleLE(1, 170 + 48);
    return b;
  };

  it("shows every one of four running circles the wallet joined, where it has nothing to do this round", async () => {
    const accounts = new Map<string, Buffer>();
    const members = new Map<string, Buffer>();
    const add = async (creator: Key, circleId: string, list: Key[], status: Record<string, unknown>, b: Bits) => {
      const circle = pk();
      accounts.set(circle.toBase58(), await circleBytes(creator, circleId, list, status, b));
      for (const [t, w] of list.entries()) {
        if (b.joined & (1 << t)) members.set(memberAddress(programId, circle, w).toBase58(), await memberBytes(circle, w, t));
      }
      return circle;
    };
    // four Active circles, each created by someone else and joined by this wallet (turn 1); every seat has paid round
    // 0 and round 0 is another seat's, so the wallet neither pays nor claims in any of them
    const own: Key[] = [];
    for (let k = 0; k < 4; k++) {
      const creator = pk();
      own.push(await add(creator, String(10 + k), [creator, me, pk()], { active: {} }, { joined: 0b111, paid: 0b111 }));
    }

    const feed = await coder.encode("priceFeed", {
      authority: pk(), stockMint: mintKey, bump: 255, wrapperPrice: new BN(150 * USDC), sharePrice: new BN(150 * USDC),
      pricedForMultiplier: new BN("1000000000"), updatedAt: new BN(900),
    });
    const pool = await coder.encode("liquidationPool", { authority: pk(), bump: 255, discountBps: 500 });
    const poolVault = Buffer.alloc(165);
    const info = (data: Buffer) => ({ data, owner: programId, lamports: 1, executable: false });
    const connection = {
      getProgramAccounts: async () => [...accounts].map(([k, data]) => ({ pubkey: new PublicKey(k), account: info(data) })),
      getAccountInfo: async (k: Key) => (accounts.has(k.toBase58()) ? info(accounts.get(k.toBase58())!) : null),
      getMultipleAccountsInfo: async (keys: Key[]) => {
        const [, , , , ...seats] = keys;
        return [info(feed), info(mint()), info(pool), info(poolVault), ...seats.map((s) => (members.has(s.toBase58()) ? info(members.get(s.toBase58())!) : null))];
      },
    };

    // the server's answer, exactly as /api/circles sends it (JSON)
    const body = JSON.parse(JSON.stringify(await solanaCirclesOf(connection as never, me.toBase58())));
    assert.equal(body.total, 4);
    assert.deepEqual(body.failed, []);
    assert.equal(body.circles.length, 4, "the server read all four");

    const React = appRequire("react");
    (globalThis as { React?: unknown }).React = React;
    const { renderToStaticMarkup } = appRequire("react-dom/server");
    const { solToList } = await import(pathToFileURL(resolve(SRC, "lib/to-list-solana.ts")).href);
    const { circleCard } = await import(pathToFileURL(resolve(SRC, "lib/core/circle-card.ts")).href);
    const { default: CirclesHome } = await import(pathToFileURL(resolve(SRC, "components/circles/CirclesHome.tsx")).href);

    const wallet = me.toBase58();
    // the source useSolanaCircles (components/live/SolanaHome.tsx) returns for this answer
    const circles = body.circles.map((c: unknown) => solToList(c, wallet));
    for (const v of circles) assert.equal(circleCard(v, wallet).group, "active", "precondition: nothing for the wallet to do in any of them");
    const source = {
      side: "solana", chainName: "Solana devnet",
      wallet: { installed: true, address: wallet, connect: () => {}, connectLabel: "Connect", installHint: "" },
      blocked: null, found: body.total, circles, notShown: body.total - body.circles.length - body.failed.length,
      reading: 0, failed: [], error: null, retry: () => {}, more: null,
    };
    const html: string = renderToStaticMarkup(React.createElement(CirclesHome, { source }));
    const missing = own.filter((c) => !html.includes(`/circle/sol:${c.toBase58()}`)).map((c) => c.toBase58());
    assert.deepEqual(missing, [],
      "a running circle the wallet joined and the server read is nowhere on the page (tiles, phone cards, Needs-you, pile, failed rows) and not counted in Showing N of M");
  });
});
