/**
 * A6 adversary on 3e5d468: solanaCirclesOf (app/src/lib/solana-circles.ts) reads the first MAX_LISTED circles with one
 * Promise.all over readLiveCircle, and decodeLive (app/src/lib/live.ts) turns every u64 into a JS number with
 * BN.toNumber(), which throws above 2^53. create_circle (programs/othello/src/instructions/create_circle.rs) lets any
 * creator pick any u64 circle_id and name any wallet as a member, with no consent. So one Forming invitation from a
 * stranger, with circle_id 2^60, ranks behind the wallet's own circle (rank 3) yet is still inside the first
 * MAX_LISTED, and its read failing rejects the whole scan: the wallet's own circle, where it has to pay, is not listed
 * at all. Spec 2: "The cap must never drop a circle in which the wallet has something to do ... whatever circles third
 * parties create naming the wallet or whatever ids they choose".
 *
 * Accounts are encoded with the deployed program's own IDL coder (accountsCoder), in the shape tests/app-live.spec.ts
 * uses; the mint is the devnet mirror's ScaledUiAmountConfig layout from that same spec. The Connection is a stub: it
 * answers the three read calls solanaCirclesOf makes, from those bytes, and sends nothing.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a6-circles-third-party-id-adversary.spec.ts
 */
import assert from "node:assert/strict";

import * as anchor from "@coral-xyz/anchor";

import { IDL, accountsCoder, memberAddress } from "../app/src/lib/live.ts";
import { solanaCirclesOf } from "../app/src/lib/solana-circles.ts";

const { BN } = (anchor as unknown as { default: { BN: new (v: number | string) => unknown } }).default;
const PublicKey = anchor.web3.PublicKey;
type Key = InstanceType<typeof PublicKey>;
const USDC = 1_000_000;

describe("A6 adversary: a stranger's invitation with a large circle id empties the wallet's Solana list", () => {
  const coder = accountsCoder();
  const programId = new PublicKey(IDL.address);
  const pk = () => anchor.web3.Keypair.generate().publicKey;
  const me = pk();
  const stranger = pk();
  const others = [pk(), pk()];
  const feedKey = pk();
  const mintKey = pk();
  const poolKey = pk();

  const circleBytes = (creator: Key, circleId: string, members: Key[], status: Record<string, unknown>, joined: number, paid: number) =>
    coder.encode("circle", {
      creator, circleId: new BN(circleId), bump: 255,
      stockMint: mintKey, usdcMint: pk(), priceFeed: feedKey, pool: poolKey,
      n: members.length, members: [...members, ...Array.from({ length: 8 - members.length }, () => PublicKey.default)],
      contribution: new BN(50 * USDC), roundSecs: new BN(120), graceSecs: new BN(60),
      haircutBps: 2000, coverageBps: 13000, warnBps: 11000,
      guaranteePerMember: new BN(35 * USDC), minStockCover: new BN(120 * USDC), maxPriceAge: new BN(691_200),
      status, round: 0, roundDeadline: new BN(1_000),
      paidBitmap: paid, joinedBitmap: joined, withdrawnBitmap: 0, receivedBitmap: 0, defaultedBitmap: 0,
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

  it("still lists the wallet's own circle, where it must pay, beside a stranger's invitation with circle_id 2^60", async () => {
    // the wallet's own circle: Active, every seat joined, its seat (turn 0) unpaid, so the card says Pay
    const mine = pk();
    const mineMembers = [me, ...others];
    // a stranger's circle naming this wallet, never joined by it, with an id the stranger chose
    const invite = pk();
    const inviteMembers = [stranger, me, others[0]!];
    const accounts = new Map<string, Buffer>([
      [mine.toBase58(), await circleBytes(me, "1", mineMembers, { active: {} }, 0b111, 0b110)],
      [invite.toBase58(), await circleBytes(stranger, (2n ** 60n).toString(), inviteMembers, { forming: {} }, 0b001, 0)],
    ]);
    const members = new Map<string, Buffer>();
    for (const [t, w] of mineMembers.entries()) members.set(memberAddress(programId, mine, w).toBase58(), await memberBytes(mine, w, t));
    members.set(memberAddress(programId, invite, stranger).toBase58(), await memberBytes(invite, stranger, 0));

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
        const [f, m, p, v, ...seats] = keys;
        assert.ok(f!.equals(feedKey) && m!.equals(mintKey) && p!.equals(poolKey) && v);
        return [info(feed), info(mint()), info(pool), info(poolVault), ...seats.map((s) => (members.has(s.toBase58()) ? info(members.get(s.toBase58())!) : null))];
      },
    };

    let listed: string[];
    try {
      const { circles } = await solanaCirclesOf(connection as never, me.toBase58());
      listed = circles.map((c) => c.accounts.circle);
    } catch (e) {
      assert.fail(`the scan failed as a whole, so the circle this wallet must pay in is not listed: ${(e as Error).message}`);
    }
    assert.ok(listed.includes(mine.toBase58()), `the wallet's own circle was dropped; listed: ${listed.join(", ")}`);
  });
});
