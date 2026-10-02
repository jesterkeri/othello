/**
 * Adversary pass on d99a70c (A2 spec: "No late answer from an old attempt may overwrite a newer one").
 *
 * While a connect is waiting on its re-switch after wallet_addEthereumChain, the wallet is already shown as connected
 * on another network, so the header's "Switch network" button (components/othello/WalletConnect.tsx, EvmControl) and
 * the "Switch to Robinhood Chain testnet" buttons are on screen. A click there starts a second switchToRobinhood in the
 * same generation. If that newer switch succeeds and the person then refuses the older, still-open re-switch prompt,
 * the older attempt's late refusal must not replace the newer success.
 *
 *   npx mocha --import=tsx tests/evm-session-reswitch-overlap-adversary.spec.ts
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
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("EVM session adversary: overlapping switches after an add (d99a70c)", () => {
  it("an older re-switch refused after a newer switch succeeded does not show the wallet as not switched", async () => {
    let chain = 1;
    let added = false;
    let switches = 0;
    const firstReswitch = deferred<null>();
    const p: FakeProvider = new FakeProvider({
      eth_requestAccounts: () => [A1],
      eth_accounts: () => [A1],
      eth_chainId: () => `0x${chain.toString(16)}`,
      // adds the network without selecting it (EIP-3085 allows this)
      wallet_addEthereumChain: () => { added = true; return null; },
      wallet_switchEthereumChain: (params) => {
        if (!added) throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
        switches++;
        // the connect's re-switch prompt stays open; the person answers the header click's prompt first
        if (switches === 1) return firstReswitch.promise;
        chain = Number.parseInt((params as [{ chainId: string }])[0].chainId, 16);
        p.emit("chainChanged", `0x${chain.toString(16)}`);
        return null;
      },
    });
    const w: EvmWallet = { info: { uuid: "u1", name: "MetaMask", rdns: "io.metamask", icon: null }, provider: p as never };
    const discovery: Discovery = { list: () => [w], subscribe: () => () => {}, stop: () => {} };
    const remembered: RememberedWallet = { get: () => null, set: () => {}, clear: () => {} };
    const s = createEvmSession({ discovery, remembered });

    const connecting = s.connectWith("u1");
    await settle();
    assert.equal(switches, 1, "the connect is waiting on its re-switch after adding the network");
    assert.equal(s.getSnapshot().address, A1);
    assert.notEqual(s.getSnapshot().chainId, ROBINHOOD, "so the Switch network button is on screen");

    // the person clicks Switch network and approves that prompt
    assert.equal(await s.switchToRobinhood(), true);
    await settle();
    assert.equal(s.getSnapshot().chainId, ROBINHOOD);
    assert.equal(s.getSnapshot().error, null);

    // then refuses the older prompt still open from the connect
    firstReswitch.reject(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    await connecting;
    await settle();

    assert.equal(s.getSnapshot().chainId, ROBINHOOD, "the wallet is on Robinhood Chain testnet");
    assert.equal(s.getSnapshot().error, null, `a late answer from the older attempt overwrote the newer success: ${s.getSnapshot().error}`);
    assert.equal(ROBINHOOD_HEX_ID, "0xb626");
  });
});
