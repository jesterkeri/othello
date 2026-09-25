/**
 * The demo circle, read live from devnet and mapped to the same CircleView the
 * fixtures use, so the Circle screen renders chain state with no second code
 * path. Accounts are decoded with the deployed program's own IDL, so a field
 * the program renames fails here loudly instead of reading the wrong bytes.
 *
 * Two requests per read: the circle, then its feed, its mint and every member
 * in one getMultipleAccounts. Nothing is cached or guessed: an account that is
 * missing is an error the screen shows, never a zero.
 *
 * No "@/" imports: tests/app-live.spec.ts runs decodeLive from the repo root.
 */
import * as anchor from "@coral-xyz/anchor";

import type { CircleStatus, CircleView, MemberView } from "./circle";
import idlJson from "../idl/othello.json";
import { multiplierAt, readScaledUi, toFixed1e9 } from "./scaledUi";

type PublicKeyT = anchor.web3.PublicKey;
type BNLike = { toNumber(): number; toString(): string };

export const IDL = idlJson as anchor.Idl & { address: string };

/** The IDL's account coder, with the camelCase names the rest of the app uses. */
export function accountsCoder(): anchor.AccountsCoder {
  // A Program only to get its coder: nothing is fetched through this provider.
  return new anchor.Program(IDL, { connection: undefined } as unknown as anchor.Provider).coder.accounts;
}

export function memberAddress(programId: PublicKeyT, circle: PublicKeyT, wallet: PublicKeyT): PublicKeyT {
  return anchor.web3.PublicKey.findProgramAddressSync(
    [new TextEncoder().encode("member"), circle.toBytes(), wallet.toBytes()],
    programId,
  )[0];
}

type DecodedCircle = {
  creator: PublicKeyT;
  circleId: BNLike;
  stockMint: PublicKeyT;
  usdcMint: PublicKeyT;
  priceFeed: PublicKeyT;
  pool: PublicKeyT;
  n: number;
  members: PublicKeyT[];
  contribution: BNLike;
  roundSecs: BNLike;
  graceSecs: BNLike;
  haircutBps: number;
  coverageBps: number;
  warnBps: number;
  guaranteePerMember: BNLike;
  minStockCover: BNLike;
  maxPriceAge: BNLike;
  status: Record<string, unknown>;
  round: number;
  roundDeadline: BNLike;
  paidBitmap: number;
  joinedBitmap: number;
  withdrawnBitmap: number;
  receivedBitmap: number;
  defaultedBitmap: number;
  reserveTotal: BNLike;
  reserveLosses: BNLike;
  reserveAllocated: BNLike;
  escrow: BNLike;
  escrowDeficit: BNLike;
  nextGateShortBy: BNLike;
  heldContributions: BNLike;
  lastCoverageAt: BNLike;
};

type DecodedMember = { wallet: PublicKeyT; turn: number; stockRaw: BNLike; roundsPaid: number; allocated: BNLike };
type DecodedFeed = { wrapperPrice: BNLike; sharePrice: BNLike; pricedForMultiplier: BNLike; updatedAt: BNLike };

const STATUS: Record<string, CircleStatus> = {
  forming: "Forming",
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
};

/** Numbers here are USDC or raw base units well under 2^53 for any circle this program allows. */
const num = (b: BNLike) => b.toNumber();

/**
 * Account data as web3.js returns it (its own Buffer, which is what anchor's
 * coder needs; the browser has no global Buffer, so nothing here makes one).
 * `members` is in SEAT order, null for a seat that has not joined yet.
 */
export type RawAccounts = { circle: Buffer; feed: Buffer; mint: Buffer; members: (Buffer | null)[] };

/**
 * Decodes the raw accounts into CircleView. Pure: the same bytes and `now`
 * always give the same view. `now` only chooses which multiplier the mint has
 * in force, exactly as the program's Clock does.
 */
export function decodeLive(raw: RawAccounts, stockSymbol: string, now: number): CircleView {
  const coder = accountsCoder();
  const c = coder.decode<DecodedCircle>("circle", raw.circle);
  const feed = coder.decode<DecodedFeed>("priceFeed", raw.feed);
  const scaled = readScaledUi(raw.mint);
  if (!scaled) throw new Error("The circle's stock mint carries no ScaledUiAmountConfig");

  const statusKey = Object.keys(c.status)[0] ?? "";
  const status = STATUS[statusKey];
  if (!status) throw new Error(`Unknown circle status ${statusKey}`);

  if (raw.members.length !== c.n) throw new Error(`Expected ${c.n} member slots, got ${raw.members.length}`);
  const members: MemberView[] = c.members.slice(0, c.n).map((wallet, turn) => {
    const bytes = raw.members[turn];
    // The chain stores only the address; seats are named by their number.
    const name = `Seat ${turn + 1}`;
    const joined = (c.joinedBitmap & (1 << turn)) !== 0;
    if (!bytes) {
      if (joined) throw new Error(`Seat ${turn + 1} has joined but its Member account is missing`);
      return { turn, address: wallet.toBase58(), name, lockedRaw: 0, roundsPaid: 0, allocated: 0 };
    }
    const m = coder.decode<DecodedMember>("member", bytes);
    if (m.turn !== turn || !m.wallet.equals(wallet)) throw new Error(`Member account for seat ${turn + 1} does not match the circle`);
    return { turn, address: wallet.toBase58(), name, lockedRaw: num(m.stockRaw), roundsPaid: m.roundsPaid, allocated: num(m.allocated) };
  });

  return {
    circleId: num(c.circleId),
    creator: c.creator.toBase58(),
    stockSymbol,
    n: c.n,
    members,
    contribution: num(c.contribution),
    roundSecs: num(c.roundSecs),
    graceSecs: num(c.graceSecs),
    haircutBps: c.haircutBps,
    coverageBps: c.coverageBps,
    warnBps: c.warnBps,
    guaranteePerMember: num(c.guaranteePerMember),
    minStockCover: num(c.minStockCover),
    maxPriceAge: num(c.maxPriceAge),
    status,
    round: c.round,
    roundDeadline: num(c.roundDeadline),
    paidBitmap: c.paidBitmap,
    joinedBitmap: c.joinedBitmap,
    withdrawnBitmap: c.withdrawnBitmap,
    receivedBitmap: c.receivedBitmap,
    defaultedBitmap: c.defaultedBitmap,
    reserveTotal: num(c.reserveTotal),
    reserveLosses: num(c.reserveLosses),
    reserveAllocated: num(c.reserveAllocated),
    escrow: num(c.escrow),
    escrowDeficit: num(c.escrowDeficit),
    nextGateShortBy: num(c.nextGateShortBy),
    heldContributions: num(c.heldContributions),
    lastCoverageAt: num(c.lastCoverageAt),
    feed: {
      wrapperPrice: num(feed.wrapperPrice),
      sharePrice: num(feed.sharePrice),
      pricedForMultiplier: num(feed.pricedForMultiplier),
      updatedAt: num(feed.updatedAt),
    },
    effectiveMultiplier: toFixed1e9(multiplierAt(scaled, now)),
  };
}

export type LiveCircle = {
  view: CircleView;
  /** The addresses Contribute needs, straight from the circle account. */
  accounts: { circle: string; usdcMint: string; stockMint: string };
  /** The mint's pending split, for the screen to say when the multiplier changes. */
  split: { multiplier: number; newMultiplier: number; effectiveAt: number };
  readAt: number;
};

/** Reads the circle from the chain. Throws, with the reason, if any account is missing. */
export async function readLiveCircle(
  connection: anchor.web3.Connection,
  circleAddress: string,
  stockSymbol: string,
): Promise<LiveCircle> {
  const programId = new anchor.web3.PublicKey(IDL.address);
  const circleKey = new anchor.web3.PublicKey(circleAddress);
  const circleInfo = await connection.getAccountInfo(circleKey);
  if (!circleInfo) throw new Error(`No circle at ${circleAddress} on this cluster`);
  if (!circleInfo.owner.equals(programId)) throw new Error(`${circleAddress} is not an Othello account`);

  const c = accountsCoder().decode<DecodedCircle>("circle", circleInfo.data);
  const wallets = c.members.slice(0, c.n);
  const keys = [c.priceFeed, c.stockMint, ...wallets.map((w) => memberAddress(programId, circleKey, w))];
  const infos = await connection.getMultipleAccountsInfo(keys);
  // A Forming circle may have seats not yet joined; only joined seats have a
  // Member account, and decodeLive checks that against joined_bitmap's seats.
  const [feedInfo, mintInfo, ...memberInfos] = infos;
  if (!feedInfo) throw new Error(`Missing price feed ${c.priceFeed.toBase58()}`);
  if (!mintInfo) throw new Error(`Missing stock mint ${c.stockMint.toBase58()}`);

  const now = Math.floor(Date.now() / 1000);
  const view = decodeLive(
    { circle: circleInfo.data, feed: feedInfo.data, mint: mintInfo.data, members: memberInfos.map((m) => m?.data ?? null) },
    stockSymbol,
    now,
  );
  const scaled = readScaledUi(mintInfo.data)!;
  return {
    view,
    accounts: { circle: circleAddress, usdcMint: c.usdcMint.toBase58(), stockMint: c.stockMint.toBase58() },
    split: scaled,
    readAt: now,
  };
}
