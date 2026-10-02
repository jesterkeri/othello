/**
 * The EVM wallet session for Robinhood Chain, as a plain store the React layer subscribes to (lib/robinhood/wallet.ts).
 * Kept free of React so its rules are tested directly (tests/evm-session.spec.ts):
 *
 * - Connecting asks the chosen wallet, and only that one, for its accounts, then asks it to switch to Robinhood Chain
 *   testnet. The session changes only after the wallet says yes: a refused or failed attempt leaves any wallet that
 *   was already connected as it was.
 * - A reload restores the remembered wallet silently: `eth_accounts` never opens a prompt, so no page load asks the
 *   person for anything. Only a click in the connect modal calls `eth_requestAccounts`.
 * - An answer from a wallet that is no longer the chosen one is ignored.
 * - Disconnecting forgets the wallet here and asks it to drop the permission (best effort; not every wallet can).
 * The remembered wallet is its rdns in browser storage, a per-browser convenience: storage that is missing or blocked
 * only means nothing is remembered.
 */
import { getAddress, type Address } from "viem";

import { ROBINHOOD_TESTNET_ID, robinhoodTestnet } from "./chain";
import type { Discovery, EvmWallet } from "./eip6963";

export type EvmSnapshot = {
  wallets: EvmWallet[];
  chosen: EvmWallet | null;
  address: Address | null;
  chainId: number | null;
  error: string | null;
};

export type RememberedWallet = { get(): string | null; set(rdns: string): void; clear(): void };

export type EvmSession = {
  getSnapshot(): EvmSnapshot;
  subscribe(listener: () => void): () => void;
  /** Connects the wallet with this uuid and switches it to Robinhood Chain testnet. Rejects if the wallet refuses. */
  connectWith(uuid: string): Promise<void>;
  /** Asks the chosen wallet to switch (adding the network if it does not know it); false, with `error` set, if not. */
  switchToRobinhood(): Promise<boolean>;
  /**
   * Abandons a connect whose wallet prompt is still open (the person cancelled or closed the modal, or picked another
   * wallet): if the wallet approves afterwards, the answer is dropped and the wallet already connected, if any, stays.
   */
  cancelPending(): void;
  disconnect(): void;
  stop(): void;
};

export const ROBINHOOD_HEX_ID = `0x${ROBINHOOD_TESTNET_ID.toString(16)}`;

function firstAccount(a: unknown): Address | null {
  if (!Array.isArray(a) || typeof a[0] !== "string") return null;
  try {
    return getAddress(a[0]);
  } catch {
    return null;
  }
}

function parseChain(id: unknown): number | null {
  const n = typeof id === "string" ? Number.parseInt(id, 16) : typeof id === "number" ? id : Number.NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
}

function quietly<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

/** A refusal in the wallet (EIP-1193 code 4001, or wallets that only say so in words). */
export function isRejection(e: unknown): boolean {
  if ((e as { code?: unknown })?.code === 4001) return true;
  return /reject|declin|denied|cancel/i.test(message(e));
}

export function createEvmSession(d: { discovery: Discovery; remembered: RememberedWallet }): EvmSession {
  let s: EvmSnapshot = { wallets: d.discovery.list(), chosen: null, address: null, chainId: null, error: null };
  const listeners = new Set<() => void>();
  const emit = (patch: Partial<EvmSnapshot>) => {
    s = { ...s, ...patch };
    for (const l of listeners) l();
  };
  /** Bumped whenever the chosen wallet changes; an answer carrying an older number is dropped. */
  let generation = 0;
  // each network switch asked; only the latest may report, so a late answer to an older switch cannot overwrite a
  // newer one (adversary pass on d99a70c: a refused older re-switch replaced a newer switch that had succeeded)
  let switchSeq = 0;
  /** Bumped by every connect, disconnect and stop: a connect whose wallet answers after a later one began is dropped. */
  let attempt = 0;
  let detach: (() => void) | null = null;
  /** Reads the chosen wallet's network now; set by attach. */
  let readChain: () => void = () => {};

  /**
   * Follows the wallet's account and network. An answer to a read applies only if no event of its kind arrived after
   * the read was asked: a wallet that switched network before answering an older eth_chainId must not be shown on the
   * old network (tests/evm-session.spec.ts).
   */
  function attach(w: EvmWallet): { g: number; readAccounts(): void } {
    detach?.();
    const g = ++generation;
    const p = w.provider;
    let accountEvents = 0;
    let chainEvents = 0;
    const onAccounts = (a: unknown) => { if (g === generation) { accountEvents++; emit({ address: firstAccount(a) }); } };
    const onChain = (id: unknown) => { if (g === generation) { chainEvents++; emit({ chainId: parseChain(id) }); } };
    p.on?.("accountsChanged", onAccounts as never);
    p.on?.("chainChanged", onChain as never);
    detach = () => {
      p.removeListener?.("accountsChanged", onAccounts as never);
      p.removeListener?.("chainChanged", onChain as never);
    };
    readChain = () => {
      const asked = chainEvents;
      void p.request({ method: "eth_chainId" }).then(
        (id) => { if (g === generation && chainEvents === asked) emit({ chainId: parseChain(id) }); },
        () => {},
      );
    };
    readChain();
    return {
      g,
      readAccounts: () => {
        const asked = accountEvents;
        void p.request({ method: "eth_accounts" }).then(
          (a) => { if (g === generation && accountEvents === asked) emit({ address: firstAccount(a) }); },
          () => {},
        );
      },
    };
  }

  function restore() {
    if (s.chosen) return;
    const rdns = quietly(() => d.remembered.get());
    const w = rdns ? s.wallets.find((x) => x.info.rdns === rdns) : undefined;
    if (!w) return;
    emit({ chosen: w });
    attach(w).readAccounts();
  }

  const unsubscribe = d.discovery.subscribe(() => {
    emit({ wallets: d.discovery.list() });
    restore();
  });
  restore();

  async function switchToRobinhood(): Promise<boolean> {
    const w = s.chosen;
    if (!w) return false;
    const g = generation;
    const mine = ++switchSeq;
    const current = () => g === generation && mine === switchSeq;
    try {
      await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ROBINHOOD_HEX_ID }] });
    } catch (e) {
      if ((e as { code?: unknown })?.code !== 4902) {
        if (current()) emit({ error: `${w.info.name} did not switch to Robinhood Chain testnet: ${message(e)}` });
        return false;
      }
      try {
        await w.provider.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: ROBINHOOD_HEX_ID,
            chainName: robinhoodTestnet.name,
            nativeCurrency: robinhoodTestnet.nativeCurrency,
            rpcUrls: [...robinhoodTestnet.rpcUrls.default.http],
            blockExplorerUrls: [robinhoodTestnet.blockExplorers.default.url],
          }],
        });
      } catch (e2) {
        if (current()) emit({ error: `${w.info.name} did not add Robinhood Chain testnet: ${message(e2)}` });
        return false;
      }
      // EIP-3085: adding a network need not select it; ask for the switch again (Codex code review r9, LOW)
      try {
        await w.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ROBINHOOD_HEX_ID }] });
      } catch (e3) {
        if (current()) emit({ error: `${w.info.name} added Robinhood Chain testnet but did not switch to it: ${message(e3)}` });
        return false;
      }
    }
    // a switch that resolved means the active chain was switched (EIP-3326); readChain then shows it, without making
    // the connect wait on a read the wallet may answer late (adversary search on this change)
    if (current()) {
      emit({ error: null });
      readChain();
    }
    return true;
  }

  return {
    getSnapshot: () => s,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    async connectWith(uuid) {
      const my = ++attempt;
      const w = s.wallets.find((x) => x.info.uuid === uuid);
      if (!w) throw new Error("That wallet is no longer available in this browser. Choose it again.");
      const a = await w.provider.request({ method: "eth_requestAccounts" });
      if (my !== attempt) return;
      const address = firstAccount(a);
      if (!address) throw new Error(`${w.info.name} shared no account.`);
      emit({ chosen: w, address, chainId: null, error: null });
      attach(w);
      quietly(() => d.remembered.set(w.info.rdns));
      await switchToRobinhood();
    },
    switchToRobinhood,
    cancelPending() {
      attempt++;
    },
    disconnect() {
      const w = s.chosen;
      attempt++;
      generation++;
      detach?.();
      detach = null;
      emit({ chosen: null, address: null, chainId: null, error: null });
      quietly(() => d.remembered.clear());
      if (w) void w.provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] } as never).catch(() => {});
    },
    stop() {
      attempt++;
      generation++;
      detach?.();
      detach = null;
      unsubscribe();
      listeners.clear();
    },
  };
}
