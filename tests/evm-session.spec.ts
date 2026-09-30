/**
 * The EVM wallet session (A2-SWITCH): the chosen wallet is the one asked and the one that signs; a reload never
 * prompts; a refusal changes nothing; late answers from a wallet no longer chosen are dropped.
 *
 *   npx mocha --import=tsx tests/evm-session.spec.ts
 */
import assert from "node:assert/strict";

import type { Discovery, EvmWallet } from "../app/src/lib/robinhood/eip6963.ts";
import { ROBINHOOD_HEX_ID, createEvmSession, isRejection, type RememberedWallet } from "../app/src/lib/robinhood/evm-session.ts";

const A1 = "0x1111111111111111111111111111111111111111";
const A2 = "0x2222222222222222222222222222222222222222";
const ROBINHOOD = 46630;

type Answer = (params?: unknown) => unknown;

class FakeProvider {
  calls: string[] = [];
  private handlers = new Map<string, Set<(x: unknown) => void>>();
  constructor(public answers: Record<string, Answer>) {}
  request = async ({ method, params }: { method: string; params?: unknown }) => {
    this.calls.push(method);
    const f = this.answers[method];
    if (!f) throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
    return f(params);
  };
  on(ev: string, f: (x: unknown) => void) { (this.handlers.get(ev) ?? this.handlers.set(ev, new Set()).get(ev)!).add(f); }
  removeListener(ev: string, f: (x: unknown) => void) { this.handlers.get(ev)?.delete(f); }
  emit(ev: string, x: unknown) { for (const f of this.handlers.get(ev) ?? []) f(x); }
  listening(ev: string) { return this.handlers.get(ev)?.size ?? 0; }
}

const refused = () => { throw Object.assign(new Error("User rejected the request."), { code: 4001 }); };
/** A well-behaved wallet: it answers eth_chainId with its current network, and a switch changes it and says so. */
function approving(account: string, chain = ROBINHOOD) {
  const p: FakeProvider = new FakeProvider({
    eth_requestAccounts: () => [account],
    eth_accounts: () => [account],
    eth_chainId: () => `0x${chain.toString(16)}`,
    wallet_switchEthereumChain: (params) => {
      chain = Number.parseInt((params as [{ chainId: string }])[0].chainId, 16);
      p.emit("chainChanged", `0x${chain.toString(16)}`);
      return null;
    },
    wallet_revokePermissions: () => null,
  });
  return p;
}
const wallet = (uuid: string, name: string, rdns: string, provider: FakeProvider): EvmWallet =>
  ({ info: { uuid, name, rdns, icon: null }, provider: provider as never });

function discovery(initial: EvmWallet[]) {
  let list = initial;
  const ls = new Set<() => void>();
  const d: Discovery & { add(w: EvmWallet): void } = {
    list: () => list,
    subscribe: (l) => { ls.add(l); return () => { ls.delete(l); }; },
    stop: () => {},
    add: (w) => { list = [...list, w]; for (const l of ls) l(); },
  };
  return d;
}

function memory(initial: string | null = null, broken = false): RememberedWallet & { value: string | null } {
  const m = {
    value: initial,
    get() { if (broken) throw new Error("storage blocked"); return m.value; },
    set(v: string) { if (broken) throw new Error("storage blocked"); m.value = v; },
    clear() { if (broken) throw new Error("storage blocked"); m.value = null; },
  };
  return m;
}

const settle = () => new Promise((r) => setTimeout(r, 0));
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

describe("EVM session: restoring on load never prompts", () => {
  it("a remembered wallet is re-attached with eth_accounts only", async () => {
    const mm = approving(A1);
    const s = createEvmSession({ discovery: discovery([wallet("u1", "MetaMask", "io.metamask", mm)]), remembered: memory("io.metamask") });
    await settle();
    assert.equal(s.getSnapshot().address, A1);
    assert.equal(s.getSnapshot().chainId, ROBINHOOD);
    assert.ok(mm.calls.includes("eth_accounts"));
    assert.ok(!mm.calls.includes("eth_requestAccounts"), "no prompt on load");
    assert.ok(!mm.calls.includes("wallet_switchEthereumChain"), "no prompt on load");
  });

  it("a remembered wallet that announces late is restored then, still without a prompt", async () => {
    const mm = approving(A1);
    const d = discovery([]);
    const s = createEvmSession({ discovery: d, remembered: memory("io.metamask") });
    assert.equal(s.getSnapshot().chosen, null);
    d.add(wallet("u1", "MetaMask", "io.metamask", mm));
    await settle();
    assert.equal(s.getSnapshot().address, A1);
    assert.ok(!mm.calls.includes("eth_requestAccounts"));
  });

  it("nothing remembered, or storage blocked: nothing is asked of any wallet", async () => {
    for (const remembered of [memory(null), memory("io.metamask", true)]) {
      const mm = approving(A1);
      const s = createEvmSession({ discovery: discovery([wallet("u1", "MetaMask", "io.metamask", mm)]), remembered });
      await settle();
      assert.equal(s.getSnapshot().chosen, null);
      assert.deepEqual(mm.calls, []);
    }
  });
});

describe("EVM session: connecting", () => {
  it("asks only the chosen wallet, then switches it to Robinhood Chain testnet, and remembers it", async () => {
    const mm = approving(A1, 1);
    const ph = approving(A2);
    const mem = memory();
    const switchTo = mm.answers.wallet_switchEthereumChain!;
    mm.answers.wallet_switchEthereumChain = (p) => { assert.deepEqual(p, [{ chainId: ROBINHOOD_HEX_ID }]); return switchTo(p); };
    const s = createEvmSession({ discovery: discovery([wallet("u1", "MetaMask", "io.metamask", mm), wallet("u2", "Phantom", "app.phantom", ph)]), remembered: mem });
    await s.connectWith("u1");
    await settle();
    assert.equal(ROBINHOOD_HEX_ID, "0xb626");
    assert.deepEqual(mm.calls.filter((c) => c !== "eth_chainId"), ["eth_requestAccounts", "wallet_switchEthereumChain"], "never eth_accounts or anything else");
    assert.deepEqual(ph.calls, [], "the other wallet is never asked");
    assert.equal(s.getSnapshot().address, A1);
    assert.equal(s.getSnapshot().chosen?.info.name, "MetaMask");
    assert.equal(s.getSnapshot().chainId, ROBINHOOD);
    assert.equal(mem.value, "io.metamask");
  });

  it("a wallet that does not know the network is asked to add it", async () => {
    const mm = approving(A1, 1);
    let added: unknown = null;
    mm.answers.wallet_switchEthereumChain = () => { throw Object.assign(new Error("Unrecognized chain"), { code: 4902 }); };
    mm.answers.wallet_addEthereumChain = (p) => { added = p; return null; };
    const s = createEvmSession({ discovery: discovery([wallet("u1", "MetaMask", "io.metamask", mm)]), remembered: memory() });
    await s.connectWith("u1");
    const [params] = added as [{ chainId: string; rpcUrls: string[] }];
    assert.equal(params.chainId, ROBINHOOD_HEX_ID);
    assert.ok(params.rpcUrls.length > 0);
    assert.equal(s.getSnapshot().error, null);
  });

  it("a refused network switch leaves the wallet connected on its own network, with the reason", async () => {
    const mm = approving(A1, 1);
    mm.answers.wallet_switchEthereumChain = refused;
    const s = createEvmSession({ discovery: discovery([wallet("u1", "Phantom", "app.phantom", mm)]), remembered: memory() });
    await s.connectWith("u1");
    await settle();
    assert.equal(s.getSnapshot().address, A1);
    assert.equal(s.getSnapshot().chainId, 1);
    assert.match(s.getSnapshot().error ?? "", /Phantom did not switch to Robinhood Chain testnet/);
  });

  it("a refused connect rejects as a refusal and leaves the wallet already connected as it was", async () => {
    const mm = approving(A1);
    const rb = approving(A2);
    rb.answers.eth_requestAccounts = refused;
    const mem = memory();
    const s = createEvmSession({ discovery: discovery([wallet("u1", "MetaMask", "io.metamask", mm), wallet("u2", "Rabby", "io.rabby", rb)]), remembered: mem });
    await s.connectWith("u1");
    await assert.rejects(s.connectWith("u2"), (e) => isRejection(e));
    assert.equal(s.getSnapshot().chosen?.info.name, "MetaMask");
    assert.equal(s.getSnapshot().address, A1);
    assert.equal(mem.value, "io.metamask");
  });

  it("a wallet that shares no account is an error, not a connection", async () => {
    const mm = approving(A1);
    mm.answers.eth_requestAccounts = () => [];
    const s = createEvmSession({ discovery: discovery([wallet("u1", "MetaMask", "io.metamask", mm)]), remembered: memory() });
    await assert.rejects(s.connectWith("u1"), /MetaMask shared no account/);
    assert.equal(s.getSnapshot().chosen, null);
  });

  it("an unknown wallet id is an error", async () => {
    const s = createEvmSession({ discovery: discovery([]), remembered: memory() });
    await assert.rejects(s.connectWith("nope"), /no longer available/);
  });
});

describe("EVM session: stale reads", () => {
  it("an eth_chainId answer that arrives after a newer chainChanged is not applied", async () => {
    const slow = deferred<string>();
    const mm = approving(A1, 1);
    mm.answers.eth_chainId = () => slow.promise;
    const s = createEvmSession({ discovery: discovery([wallet("u1", "MetaMask", "io.metamask", mm)]), remembered: memory("io.metamask") });
    mm.emit("chainChanged", "0xb626");
    slow.resolve("0x1");
    await settle();
    assert.equal(s.getSnapshot().chainId, ROBINHOOD);
  });

  it("an eth_accounts answer that arrives after a newer accountsChanged is not applied", async () => {
    const slow = deferred<string[]>();
    const mm = approving(A1);
    mm.answers.eth_accounts = () => slow.promise;
    const s = createEvmSession({ discovery: discovery([wallet("u1", "MetaMask", "io.metamask", mm)]), remembered: memory("io.metamask") });
    mm.emit("accountsChanged", [A2]);
    slow.resolve([A1]);
    await settle();
    assert.equal(s.getSnapshot().address, A2);
  });
});

describe("EVM session: only the latest intent counts", () => {
  it("of two overlapping connects, the later one wins even if the earlier wallet answers last", async () => {
    const slow = deferred<string[]>();
    const mm = approving(A1);
    mm.answers.eth_requestAccounts = () => slow.promise;
    const rb = approving(A2);
    const s = createEvmSession({ discovery: discovery([wallet("u1", "MetaMask", "io.metamask", mm), wallet("u2", "Rabby", "io.rabby", rb)]), remembered: memory() });
    const first = s.connectWith("u1");
    await s.connectWith("u2");
    slow.resolve([A1]);
    await first;
    assert.equal(s.getSnapshot().chosen?.info.name, "Rabby");
    assert.equal(s.getSnapshot().address, A2);
  });

  it("disconnecting while a wallet prompt is open: approving it afterwards connects nothing", async () => {
    const slow = deferred<string[]>();
    const mm = approving(A1);
    mm.answers.eth_requestAccounts = () => slow.promise;
    const mem = memory();
    const s = createEvmSession({ discovery: discovery([wallet("u1", "MetaMask", "io.metamask", mm)]), remembered: mem });
    const pending = s.connectWith("u1");
    s.disconnect();
    slow.resolve([A1]);
    await pending;
    assert.equal(s.getSnapshot().chosen, null);
    assert.equal(s.getSnapshot().address, null);
    assert.equal(mem.value, null);
  });

  it("a restored wallet's late eth_accounts cannot overwrite a newer connection", async () => {
    const slow = deferred<string[]>();
    const mm = approving(A1);
    mm.answers.eth_accounts = () => slow.promise;
    const rb = approving(A2);
    const s = createEvmSession({ discovery: discovery([wallet("u1", "MetaMask", "io.metamask", mm), wallet("u2", "Rabby", "io.rabby", rb)]), remembered: memory("io.metamask") });
    await s.connectWith("u2");
    slow.resolve([A1]);
    await settle();
    assert.equal(s.getSnapshot().address, A2);
  });

  it("events from a wallet no longer chosen are ignored; the chosen one's are followed", async () => {
    const mm = approving(A1);
    const rb = approving(A2);
    const s = createEvmSession({ discovery: discovery([wallet("u1", "MetaMask", "io.metamask", mm), wallet("u2", "Rabby", "io.rabby", rb)]), remembered: memory() });
    await s.connectWith("u1");
    await s.connectWith("u2");
    assert.equal(mm.listening("accountsChanged"), 0, "the old wallet's listeners are removed");
    mm.emit("accountsChanged", [A1]);
    assert.equal(s.getSnapshot().address, A2);
    rb.emit("chainChanged", "0x1");
    assert.equal(s.getSnapshot().chainId, 1);
    rb.emit("accountsChanged", []);
    assert.equal(s.getSnapshot().address, null, "a locked or disconnected wallet shows as not connected");
  });
});

describe("EVM session: disconnect", () => {
  it("forgets the wallet, asks it to drop the permission, and ignores it afterwards", async () => {
    const mm = approving(A1);
    const mem = memory();
    const s = createEvmSession({ discovery: discovery([wallet("u1", "MetaMask", "io.metamask", mm)]), remembered: mem });
    await s.connectWith("u1");
    s.disconnect();
    await settle();
    assert.deepEqual(s.getSnapshot(), { ...s.getSnapshot(), chosen: null, address: null, chainId: null, error: null });
    assert.equal(mem.value, null);
    assert.ok(mm.calls.includes("wallet_revokePermissions"));
    mm.emit("accountsChanged", [A1]);
    assert.equal(s.getSnapshot().address, null);
  });

  it("a wallet that cannot drop the permission still disconnects here; blocked storage does not stop anything", async () => {
    const mm = approving(A1);
    delete mm.answers.wallet_revokePermissions;
    const s = createEvmSession({ discovery: discovery([wallet("u1", "MetaMask", "io.metamask", mm)]), remembered: memory(null, true) });
    await s.connectWith("u1");
    assert.equal(s.getSnapshot().address, A1);
    s.disconnect();
    await settle();
    assert.equal(s.getSnapshot().address, null);
  });
});
