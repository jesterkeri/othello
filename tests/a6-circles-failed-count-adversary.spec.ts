/**
 * A6 adversary on f3be27c: solanaCirclesOf (app/src/lib/solana-circles.ts) now lists a circle whose read failed in
 * `failed`, and useSolanaCircles (app/src/components/live/SolanaHome.tsx) passes
 * notShown = total - circles.length - failed.length. CirclesHome (app/src/components/circles/CirclesHome.tsx) then
 * says "Showing {circles.length} of {circles.length + notShown} circles", so the M it prints is total - failed.length:
 * every failed read inside the first MAX_LISTED shrinks the count of circles the wallet has. Spec 5: "A circle that
 * cannot be read shows as a failed row with a link to its page; counts ("Showing N of M") stay true."
 *
 * The chain side is the real solanaCirclesOf over account bytes built with the deployed program's own IDL coder
 * (accountsCoder), in the shape tests/a6-circles-third-party-id-adversary.spec.ts uses; the Connection is a stub that
 * answers the three read calls from those bytes and sends nothing. The unreadable circle is a stranger's Forming
 * invitation with circle_id 2^60, which create_circle allows (programs/othello/src/instructions/create_circle.rs takes
 * any u64 id) and decodeLive cannot turn into a JS number. The page side is the real useSolanaCircles, run by a small
 * hook runner (react swapped for it, as tests/a2-cancelled-solana-rearmed-adversary.spec.ts does), fed that answer
 * through a stubbed fetch, and the real CirclesHome rendered with react-dom/server.
 *
 *   npx mocha --import=tsx --timeout 300000 tests/a6-circles-failed-count-adversary.spec.ts
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

describe("A6 adversary: a failed read inside the cap makes 'Showing N of M' undercount the wallet's circles", () => {
  const coder = accountsCoder();
  const programId = new PublicKey(IDL.address);
  const pk = () => anchor.web3.Keypair.generate().publicKey;
  const me = pk();
  const stranger = pk();
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

  it("says the wallet has as many circles as the scan found, failed read or not", async () => {
    const accounts = new Map<string, Buffer>();
    const members = new Map<string, Buffer>();
    const addMembers = async (circle: Key, list: Key[], joined: number) => {
      for (const [t, w] of list.entries()) {
        if (joined & (1 << t)) members.set(memberAddress(programId, circle, w).toBase58(), await memberBytes(circle, w, t));
      }
    };
    // the wallet's own Active circle, its seat unpaid: Pay (rank 0)
    const pay = pk();
    const payMembers = [me, ...others];
    accounts.set(pay.toBase58(), await circleBytes(me, "1", payMembers, { active: {} }, { joined: 0b111, paid: 0b110, received: 0, withdrawn: 0 }));
    await addMembers(pay, payMembers, 0b111);
    // a stranger's invitation naming the wallet, id 2^60: rank 3, inside the first MAX_LISTED, and unreadable
    const invite = pk();
    const inviteMembers = [stranger, me, others[0]!];
    accounts.set(invite.toBase58(), await circleBytes(stranger, (2n ** 60n).toString(), inviteMembers, { forming: {} }, { joined: 0b001, paid: 0, received: 0, withdrawn: 0 }));
    await addMembers(invite, inviteMembers, 0b001);
    // twelve finished circles of its own, every seat collected: nothing left for it (rank 4)
    for (let id = 2; id <= 13; id++) {
      const done = pk();
      accounts.set(done.toBase58(), await circleBytes(me, String(id), payMembers, { completed: {} }, { joined: 0b111, paid: 0, received: 0b111, withdrawn: 0b111 }));
      await addMembers(done, payMembers, 0b111);
    }
    const total = accounts.size;
    assert.equal(total, 14);
    assert.ok(total > MAX_LISTED);

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
    assert.equal(body.total, 14);
    assert.deepEqual(body.failed, [invite.toBase58()], "the stranger's invitation is the one failed read");
    assert.equal(body.circles.length, MAX_LISTED - 1);

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
    assert.equal(source.found, 14);
    assert.equal(source.failed.length, 1, "the failed read is shown as its own row");

    const html: string = renderToStaticMarkup(React.createElement(CirclesHome, { source }));
    const said = html.match(/Showing (\d+) of (\d+) circles/);
    assert.ok(said, "the page says it is showing only some of the wallet's circles");
    assert.equal(Number(said[2]), total, `the page says "${said[0]}", but the wallet has ${total} circles (one of them a failed read shown as a row)`);
  });
});
