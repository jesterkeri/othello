/**
 * A6 adversary on f3be27c: CirclesBoard (app/src/components/circles/CirclesBoard.tsx) draws only the first three
 * running circles (`running.slice(0, SHOWN)`, "needs" first), on desktop and on the phone (CirclesPhone gets the same
 * `shown`). A running circle outside those three appears nowhere on the page: not in the Needs-you dialog (it is not
 * "needs"), not in the finished pile. The board's "a member is in at most three at a time" holds for circles a member
 * joined, but an invitation it has not joined is Forming (running) and "needs" (Join), and create_circle
 * (programs/othello/src/instructions/create_circle.rs) lets anyone create one naming any wallet. So three strangers'
 * invitations push the wallet's own circle off the page: here the one where its seat receives this round's pot, which
 * listRank itself ranks 0 ("claim ... the cap is about not losing a circle", app/src/lib/solana-circles.ts).
 * Spec 2: "Nothing a third party can create (any circle naming the wallet ...) may hide a circle in which the wallet
 * has something to do (pay, claim, start, collect)"; spec 6: "no layout that hides an action".
 *
 * The chain side is the real solanaCirclesOf over account bytes built with the deployed program's own IDL coder
 * (accountsCoder), in the shape tests/a6-circles-third-party-id-adversary.spec.ts uses; the Connection is a stub that
 * answers the three read calls from those bytes and sends nothing. The page side is the real useSolanaCircles, run by a
 * small hook runner (react swapped for it, as tests/a2-cancelled-solana-rearmed-adversary.spec.ts does), fed that
 * answer through a stubbed fetch, and the real CirclesHome rendered with react-dom/server.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a6-circles-board-invites-adversary.spec.ts
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

type Slot = { v?: unknown; current?: unknown; f?: unknown; d?: unknown[]; cleanup?: unknown };
const g = globalThis as { __a6c?: ReturnType<typeof hooks>; __a6cWallet?: string; React?: unknown };

/** One component's hooks, run by hand: state persists across renders, effects run when their deps change. */
function hooks() {
  const slots: Slot[] = [];
  const queue: (() => void)[] = [];
  let i = 0;
  const same = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((x, k) => Object.is(x, b[k])));
  return {
    begin() {
      i = 0;
    },
    useState(init: unknown) {
      const k = i++;
      if (!slots[k]) slots[k] = { v: typeof init === "function" ? (init as () => unknown)() : init };
      const s = slots[k]!;
      return [s.v, (x: unknown) => { s.v = typeof x === "function" ? (x as (p: unknown) => unknown)(s.v) : x; }];
    },
    useRef(init: unknown) {
      const k = i++;
      if (!slots[k]) slots[k] = { current: init };
      return slots[k];
    },
    useCallback(f: unknown, d: unknown[]) {
      const k = i++;
      if (slots[k] && same(slots[k]!.d, d)) return slots[k]!.f;
      slots[k] = { f, d };
      return f;
    },
    useEffect(f: () => unknown, d: unknown[]) {
      const k = i++;
      const s = slots[k];
      if (s && same(s.d, d)) return;
      queue.push(() => {
        if (typeof s?.cleanup === "function") (s.cleanup as () => void)();
        slots[k] = { d, cleanup: f() };
      });
    },
    flush() {
      for (const q of queue.splice(0)) q();
    },
  };
}

registerHooks({
  resolve(specifier, context, next) {
    const stub = (src: string) => ({ url: `data:text/javascript,${encodeURIComponent(src)}`, shortCircuit: true });
    const fromHome = context.parentURL?.endsWith("/components/live/SolanaHome.tsx") ?? false;
    if (specifier.endsWith(".module.css")) return stub("export default new Proxy({}, { get: (_, k) => String(k) });");
    if (fromHome && specifier === "react") {
      return stub(
        "const H = () => globalThis.__a6c;" +
        "export const useState = (i) => H().useState(i);" +
        "export const useRef = (i) => H().useRef(i);" +
        "export const useCallback = (f, d) => H().useCallback(f, d);" +
        "export const useEffect = (f, d) => H().useEffect(f, d);",
      );
    }
    if (fromHome && specifier === "@solana/wallet-adapter-react") {
      return stub("export const useWallet = () => ({ publicKey: { toBase58: () => globalThis.__a6cWallet }, wallets: [{ readyState: 'Installed' }] });");
    }
    if (fromHome && specifier === "@/lib/wallet") return stub("export const useWalletUi = () => ({ openConnect: () => {} });");
    if (fromHome && specifier === "@/components/othello/Shell") return stub("export default (p) => p.children;");
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

describe("A6 adversary: strangers' invitations push the wallet's own running circle off the board", () => {
  const coder = accountsCoder();
  const programId = new PublicKey(IDL.address);
  const pk = () => anchor.web3.Keypair.generate().publicKey;
  const me = pk();
  const others = [pk(), pk()];
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

  it("shows the wallet's own circle, where its seat receives this round, beside three strangers' invitations", async () => {
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
    // the wallet's own Active circle: every seat paid, round 0 is its seat's (turn 0), so it receives this round's pot
    // (the feed below was updated at 900, stale by any 2026 clock, so release waits on a price update)
    const own = await add(me, "1", [me, ...others], { active: {} }, { joined: 0b111, paid: 0b111 });
    // three strangers each create an invitation naming the wallet; the wallet has not joined any of them
    for (let k = 0; k < 3; k++) {
      const stranger = pk();
      await add(stranger, String(100 + k), [stranger, me, others[0]!], { forming: {} }, { joined: 0b001, paid: 0 });
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
    assert.equal(body.circles[0].accounts.circle, own.toBase58(), "the server lists the wallet's own circle first (listRank 0)");

    // the page: the real useSolanaCircles, with fetch answering that body
    g.__a6cWallet = me.toBase58();
    g.__a6c = hooks();
    (globalThis as { fetch: unknown }).fetch = async (url: string) => {
      assert.equal(url, `/api/circles?wallet=${me.toBase58()}`);
      return { json: async () => body };
    };
    const React = appRequire("react");
    g.React = React;
    const { renderToStaticMarkup } = appRequire("react-dom/server");
    const { useSolanaCircles } = await import(pathToFileURL(resolve(SRC, "components/live/SolanaHome.tsx")).href);
    const { default: CirclesHome } = await import(pathToFileURL(resolve(SRC, "components/circles/CirclesHome.tsx")).href);
    const h = g.__a6c!;
    h.begin();
    useSolanaCircles();
    h.flush();
    for (let k = 0; k < 5; k++) await new Promise((r) => setTimeout(r, 0));
    h.begin();
    const source = useSolanaCircles();
    h.flush();
    assert.equal(source.circles.length, 4);

    const html: string = renderToStaticMarkup(React.createElement(CirclesHome, { source }));
    // the three invitations took the three running tiles (each shown, with its Join)
    for (const x of body.circles.slice(1)) assert.ok(html.includes(`/circle/sol:${x.accounts.circle}`), "an invitation is on the page");
    assert.ok(html.includes("Join"));
    assert.ok(html.includes(`/circle/sol:${own.toBase58()}`),
      "the wallet's own circle, where its seat receives this round's pot, is nowhere on the page (board, phone, dialogs or pile)");
  });
});
