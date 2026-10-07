"use client";

/**
 * The EVM wallet for Robinhood Chain pages: one session for the whole app (the root layout mounts the provider), so
 * the top bar, the connect modal and every Robinhood page see the same wallet. Wallets are found by EIP-6963 and the
 * one the person picks is the one that signs (lib/robinhood/eip6963.ts); the session's rules live in
 * lib/robinhood/evm-session.ts. Signing stays in the wallet: this reads the account and network, asks to connect only
 * when the person picks a wallet, and asks the wallet to switch to Robinhood Chain testnet.
 */
import { createContext, createElement, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPublicClient, createWalletClient, custom, type EIP1193Provider } from "viem";

import { ROBINHOOD_TESTNET_ID, robinhoodTestnet } from "./chain";
import { discoverEvmWallets } from "./eip6963";
import { createEvmSession, type EvmSession, type EvmSnapshot, type RememberedWallet } from "./evm-session";
import { robinhoodHttp } from "./transport";

export const robinhoodPublicClient = createPublicClient({ chain: robinhoodTestnet, transport: robinhoodHttp() });

/** The remembered wallet's rdns (not an address, not a key): a per-browser convenience, safe to lose. */
const REMEMBER_KEY = "othello.evmWallet";

function rememberedInThisBrowser(): RememberedWallet {
  return {
    get: () => window.localStorage.getItem(REMEMBER_KEY),
    set: (rdns) => window.localStorage.setItem(REMEMBER_KEY, rdns),
    clear: () => window.localStorage.removeItem(REMEMBER_KEY),
  };
}

function injected(): EIP1193Provider | undefined {
  return (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
}

const SessionContext = createContext<EvmSession | null>(null);

/** Mounted once by the root layout. The session starts after mount: the server has no window, and the first render matches it. */
export function EvmWalletProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<EvmSession | null>(null);
  useEffect(() => {
    const discovery = discoverEvmWallets(window, injected);
    const s = createEvmSession({ discovery, remembered: rememberedInThisBrowser() });
    setSession(s);
    return () => { s.stop(); discovery.stop(); };
  }, []);
  return createElement(SessionContext.Provider, { value: session }, children);
}

const EMPTY: EvmSnapshot = { wallets: [], chosen: null, address: null, chainId: null, error: null };
const noSubscribe = () => () => {};
const empty = () => EMPTY;

export function useEvmWallet() {
  const session = useContext(SessionContext);
  const snap = useSyncExternalStore(session ? session.subscribe : noSubscribe, session ? session.getSnapshot : empty, empty);
  const walletClient = useMemo(
    () => (snap.chosen && snap.address ? createWalletClient({ account: snap.address, chain: robinhoodTestnet, transport: custom(snap.chosen.provider) }) : null),
    [snap.chosen, snap.address],
  );
  return {
    /** Every EVM wallet found in this browser, for the connect modal. */
    wallets: snap.wallets,
    walletName: snap.chosen?.info.name ?? null,
    hasWallet: snap.wallets.length > 0,
    address: snap.address,
    chainId: snap.chainId,
    onRobinhood: snap.chainId === ROBINHOOD_TESTNET_ID,
    walletClient,
    /** Connects the picked wallet and switches it to Robinhood Chain testnet; rejects if the wallet refuses. */
    connectWith: (uuid: string) => (session ? session.connectWith(uuid) : Promise.reject(new Error("The wallet list is still loading. Try again."))),
    switchToRobinhood: () => (session ? session.switchToRobinhood() : Promise.resolve(false)),
    /** Drops the answer to a connect still waiting in the wallet; the wallet already connected stays. */
    cancelPending: () => session?.cancelPending(),
    disconnect: () => session?.disconnect(),
    error: snap.error,
  };
}

export type EvmWalletState = ReturnType<typeof useEvmWallet>;
