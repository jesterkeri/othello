/**
 * Adversary pass on 0553f0e (A2 spec 2: a connect reports Robinhood Chain testnet only when the wallet switched to it,
 * and no late answer from an older switch may overwrite a newer result).
 *
 * A second click on "Switch network" (components/othello/WalletConnect.tsx EvmControl, or the "Switch to Robinhood
 * Chain testnet" buttons in RobinhoodCircle.tsx and RobinhoodCreate.tsx) while the first switch prompt is still open
 * starts a second switchToRobinhood. A wallet that already has a request of that type open from this origin answers
 * the duplicate at once with EIP-1193 code -32002 ("resource unavailable", the MetaMask answer for a request already
 * pending): that says nothing about the network. The person then approves the first prompt and the wallet is on
 * Robinhood Chain testnet. The session must not go on saying it "did not switch": RobinhoodCircle.tsx renders
 * `w.error` whatever the network, beside the actions that only show on Robinhood Chain.
 *
 *   npx mocha --import=tsx tests/evm-session-busy-switch-adversary.spec.ts
 */
import assert from "node:assert/strict";

import type { Discovery, EvmWallet } from "../app/src/lib/robinhood/eip6963.ts";
import { ROBINHOOD_HEX_ID, createEvmSession, type RememberedWallet } from "../app/src/lib/robinhood/evm-session.ts";

const A1 = "0x1111111111111111111111111111111111111111";
const ROBINHOOD = 46630;

class FakeProvider {
  calls: string[] = [];
  private handlers = new Map<string, Set<(x: unknown) => void>>();
  constructor(public answers: Record<string, (params?: unknown) => unknown>) {}
  request = async ({ method, params }: { method: string; params?: unknown }) => {
    this.calls.push(method);
    const f = this.answers[method];
    if (!f) throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
    return f(params);
  };
  on(ev: string, f: (x: unknown) => void) { (this.handlers.get(ev) ?? this.handlers.set(ev, new Set()).get(ev)!).add(f); }
  removeListener(ev: string, f: (x: unknown) => void) { this.handlers.get(ev)?.delete(f); }
  emit(ev: string, x: unknown) { for (const f of this.handlers.get(ev) ?? []) f(x); }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((a) => { resolve = a; });
  return { promise, resolve };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("EVM session adversary: a duplicate switch refused as busy (0553f0e)", () => {
  it("after the first prompt is approved, the wallet on Robinhood Chain testnet is not reported as not switched", async () => {
    let chain = 1;
    let open: ReturnType<typeof deferred<null>> | null = null;
    const p: FakeProvider = new FakeProvider({
      eth_accounts: () => [A1],
      eth_chainId: () => `0x${chain.toString(16)}`,
      wallet_switchEthereumChain: (params) => {
        // one switch prompt at a time per origin; a second request while it is open is refused as busy
        if (open) {
          throw Object.assign(
            new Error("Request of type 'wallet_switchEthereumChain' already pending for origin http://localhost:3000. Please wait."),
            { code: -32002 },
          );
        }
        const d = deferred<null>();
        open = d;
        return d.promise.then(() => {
          open = null;
          chain = Number.parseInt((params as [{ chainId: string }])[0].chainId, 16);
          p.emit("chainChanged", `0x${chain.toString(16)}`);
          return null;
        });
      },
    });
    const w: EvmWallet = { info: { uuid: "u1", name: "MetaMask", rdns: "io.metamask", icon: null }, provider: p as never };
    const discovery: Discovery = { list: () => [w], subscribe: () => () => {}, stop: () => {} };
    // a returning visitor: the wallet is restored with eth_accounts, on another network
    const remembered: RememberedWallet = { get: () => "io.metamask", set: () => {}, clear: () => {} };
    const s = createEvmSession({ discovery, remembered });
    await settle();
    assert.equal(s.getSnapshot().address, A1);
    assert.equal(s.getSnapshot().chainId, 1, "so the Switch network button is on screen");

    // first click: the wallet opens its switch prompt
    const first = s.switchToRobinhood();
    await settle();
    assert.ok(open, "the first switch prompt is open");

    // second click before answering it: the wallet refuses the duplicate as busy
    assert.equal(await s.switchToRobinhood(), false);

    // the person approves the first prompt
    (open as unknown as { resolve(v: unknown): void }).resolve(null); // assigned inside the fake wallet, which TS cannot see
    assert.equal(await first, true, "the first switch succeeded");
    await settle();

    assert.equal(s.getSnapshot().chainId, ROBINHOOD, "the wallet is on Robinhood Chain testnet");
    assert.equal(s.getSnapshot().error, null, `the wallet switched, but the session still says: ${s.getSnapshot().error}`);
    assert.equal(ROBINHOOD_HEX_ID, "0xb626");
  });
});
