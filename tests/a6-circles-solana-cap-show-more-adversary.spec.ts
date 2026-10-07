/**
 * Adversary on 55f8770 (PR #25, shared circles list). Spec item 3: "The board's wording never claims something a
 * pending, failed, capped or not-yet-paged read could make untrue."
 *
 * 55f8770 rewrote the empty tile's unread line (app/src/components/circles/CirclesBoard.tsx) to "Some of your circles
 * are still reading, couldn't be read, or are behind Show more: see below." On Solana the list is capped, not paged:
 * solanaCirclesOf (app/src/lib/solana-circles.ts) reads the first MAX_LISTED and useSolanaCircles
 * (app/src/components/live/SolanaHome.tsx) passes `more: null`, so CirclesHome draws no Show more. A wallet past the
 * cap whose first MAX_LISTED are all finished gets the empty tile with `unread` = notShown only: nothing is reading,
 * nothing failed, and the page has no Show more, yet the tile sends the person to one "below".
 *
 * Harness and fixture construction are those of tests/a6-circles-failed-count-adversary.spec.ts: account bytes built
 * with the deployed program's own IDL coder (accountsCoder), the real solanaCirclesOf over a stub Connection that sends
 * nothing, the real useSolanaCircles run by a small hook runner, the real CirclesHome rendered with react-dom/server.
 * The wallet has created MAX_LISTED + 1 circles, each Completed with every seat collected (rank 3).
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a6-circles-solana-cap-show-more-adversary.spec.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import * as anchor from "@coral-xyz/anchor";

import { REPO } from "./artifacts.ts";
import { IDL, accountsCoder, memberAddress } from "../app/src/lib/live.ts";
import { MAX_LISTED, solanaCirclesOf } from "../app/src/lib/solana-circles.ts";

const SRC = resolve(REPO, "app/src");
const appRequire = createRequire(resolve(SRC, "lib/chains.ts"));

type Slot = { v?: unknown; current?: unknown; f?: unknown; d?: unknown[]; cleanup?: unknown };
const g = globalThis as { __a6m?: ReturnType<typeof hooks>; __a6mWallet?: string; React?: unknown };

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
        "const H = () => globalThis.__a6m;" +
        "export const useState = (i) => H().useState(i);" +
        "export const useRef = (i) => H().useRef(i);" +
        "export const useCallback = (f, d) => H().useCallback(f, d);" +
        "export const useEffect = (f, d) => H().useEffect(f, d);",
      );
    }
    if (fromHome && specifier === "@solana/wallet-adapter-react") {
      return stub("export const useWallet = () => ({ publicKey: { toBase58: () => globalThis.__a6mWallet }, wallets: [{ readyState: 'Installed' }] });");
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

describe("Adversary on 55f8770: the empty tile's unread line on a capped Solana list", () => {
  const coder = accountsCoder();
  const programId = new PublicKey(IDL.address);
  const pk = () => anchor.web3.Keypair.generate().publicKey;
  const me = pk();
  const others = [pk(), pk()];
  const feedKey = pk();
  const mintKey = pk();
  const poolKey = pk();

  type Bits = { joined: number; paid: number; received: number; withdrawn: number };
  const circleBytes = (creator: Key, circleId: string, members: Key[], status: Record<string, unknown>, b: Bits) =>
    coder.encode("circle", {
      creator, circleId: new BN(circleId), bump: 255,
      stockMint: mintKey, usdcMint: pk(), priceFeed: feedKey, pool: poolKey,
      n: members.length, members: [...members, ...Array.from({ length: 8 - members.length }, () => PublicKey.default)],
      contribution: new BN(50 * USDC), roundSecs: new BN(120), graceSecs: new BN(60),
      haircutBps: 2000, coverageBps: 13000, warnBps: 11000,
      guaranteePerMember: new BN(35 * USDC), minStockCover: new BN(120 * USDC), maxPriceAge: new BN(691_200),
      status, round: 0, roundDeadline: new BN(1_000),
      paidBitmap: b.paid, joinedBitmap: b.joined, withdrawnBitmap: b.withdrawn, receivedBitmap: b.received, defaultedBitmap: 0,
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

  it("never sends the person to a Show more the page does not draw", async () => {
    const accounts = new Map<string, Buffer>();
    const members = new Map<string, Buffer>();
    const addMembers = async (circle: Key, list: Key[], joined: number) => {
      for (const [t, w] of list.entries()) {
        if (joined & (1 << t)) members.set(memberAddress(programId, circle, w).toBase58(), await memberBytes(circle, w, t));
      }
    };
    const seats = [me, ...others];
    // finished circles of its own, every seat collected: nothing left for it (rank 3), one past the cap
    for (let id = 1; id <= MAX_LISTED + 1; id++) {
      const done = pk();
      accounts.set(done.toBase58(), await circleBytes(me, String(id), seats, { completed: {} }, { joined: 0b111, paid: 0, received: 0b111, withdrawn: 0b111 }));
      await addMembers(done, seats, 0b111);
    }
    const total = accounts.size;
    assert.equal(total, MAX_LISTED + 1);

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
        const [, , , , ...rest] = keys;
        return [info(feed), info(mint()), info(pool), info(poolVault), ...rest.map((s) => (members.has(s.toBase58()) ? info(members.get(s.toBase58())!) : null))];
      },
    };

    // the server's answer, exactly as /api/circles sends it (JSON)
    const body = JSON.parse(JSON.stringify(await solanaCirclesOf(connection as never, me.toBase58())));
    assert.equal(body.total, total);
    assert.deepEqual(body.failed, [], "precondition: every listed circle was read");
    assert.equal(body.circles.length, MAX_LISTED, "precondition: the cap left one circle unread");

    // the page: the real useSolanaCircles, with fetch answering that body
    g.__a6mWallet = me.toBase58();
    g.__a6m = hooks();
    (globalThis as { fetch: unknown }).fetch = async (url: string) => {
      assert.equal(url, `/api/circles?wallet=${me.toBase58()}`);
      return { json: async () => body };
    };
    const React = appRequire("react");
    g.React = React;
    const { renderToStaticMarkup } = appRequire("react-dom/server");
    const { useSolanaCircles } = await import(pathToFileURL(resolve(SRC, "components/live/SolanaHome.tsx")).href);
    const { default: CirclesHome } = await import(pathToFileURL(resolve(SRC, "components/circles/CirclesHome.tsx")).href);
    const h = g.__a6m!;
    h.begin();
    useSolanaCircles();
    h.flush();
    for (let k = 0; k < 5; k++) await new Promise((r) => setTimeout(r, 0));
    h.begin();
    const source = useSolanaCircles();
    h.flush();
    assert.equal(source.found, total);
    assert.equal(source.failed.length, 0, "precondition: no failed row");
    assert.equal(source.reading, 0, "precondition: nothing is still reading");
    assert.equal(source.more, null, "precondition: Solana lists no further page");

    const html: string = renderToStaticMarkup(React.createElement(CirclesHome, { source }));
    const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
    assert.match(text, /Not every circle is read yet\./, "precondition: the board drew its empty tile with circles unread");
    const control = /<button\b[^>]*>\s*Show more\s*<\/button>/.test(html);
    const named = text.match(/[^.]*Show more[^.]*\./);
    assert.ok(
      !named || control,
      `the board says "${named?.[0]?.trim()}", but the page draws no Show more (Solana's list is capped at ${MAX_LISTED}, not paged)`,
    );
  });
});
