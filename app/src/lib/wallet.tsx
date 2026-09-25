'use client';

/**
 * Wallet connection, and the one place the connect modal's stage lives.
 *
 * Wallets are found through the Wallet Standard, so Phantom, Solflare and
 * Backpack appear when installed with no per-wallet package. The app never
 * holds a key: connecting shares an address, and every transaction will open in
 * the person's own wallet to be approved there.
 *
 * autoConnect is on for two reasons. It restores the last wallet on a reload,
 * and when someone picks a wallet it is what calls connect, so the result of
 * that attempt arrives through onError or through `connected`, both handled
 * here, rather than through a promise this file would have to race.
 */
import { useCallback, useEffect, useMemo, useRef, useState, createContext, useContext, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import { WalletReadyState, type WalletError, type WalletName } from '@solana/wallet-adapter-base';
import { clusterApiUrl } from '@solana/web3.js';

/** The modal's screens, named as in the design (Wallet Screen, rows 1a to 1e). */
export type ConnectStage = 'closed' | 'list' | 'empty' | 'connecting' | 'rejected' | 'failed';

export type DetectedWallet = { name: string; icon: string };

type WalletUi = {
  address: string | null;
  walletName: string | null;
  stage: ConnectStage;
  /** Wallets installed in this browser, in the order the adapter found them. */
  detected: DetectedWallet[];
  /** The wallet being connected, or the one that just refused. */
  pending: string | null;
  openConnect: () => void;
  close: () => void;
  pick: (name: string) => void;
  cancel: () => void;
  retry: () => void;
  another: () => void;
  recheck: () => void;
  disconnect: () => void;
};

const WalletUiContext = createContext<WalletUi | null>(null);

export function useWalletUi(): WalletUi {
  const v = useContext(WalletUiContext);
  if (!v) throw new Error('useWalletUi must be used inside <WalletProviders>');
  return v;
}

/**
 * The RPC is devnet unless NEXT_PUBLIC_SOLANA_RPC names another devnet
 * endpoint. It is a public URL by construction (NEXT_PUBLIC), so nothing
 * secret can be put there without it shipping to every browser.
 */
const ENDPOINT = process.env.NEXT_PUBLIC_SOLANA_RPC || clusterApiUrl('devnet');

/**
 * A refusal in the wallet and a wallet that broke are different screens with
 * different advice. Wallets report a refusal as EIP-1193 style code 4001
 * (Phantom, Solflare, Backpack), and the adapter keeps the original under
 * `error`; the message check covers wallets that only say it in words.
 */
function isRejection(e: WalletError): boolean {
  const inner = (e as { error?: { code?: number; message?: string } }).error;
  if (inner?.code === 4001) return true;
  return /reject|declin|denied|cancel/i.test(`${e.message} ${inner?.message ?? ''}`);
}

function Ui({ children, errorRef }: { children: ReactNode; errorRef: { current: ((e: WalletError) => void) | null } }) {
  const w = useWallet();
  const [stage, setStage] = useState<ConnectStage>('closed');
  const [pending, setPending] = useState<string | null>(null);
  // Set by Cancel. The wallet's own prompt cannot be withdrawn from here, so if
  // it is approved after the person cancelled, the connection is dropped
  // rather than appearing out of nowhere.
  const cancelled = useRef(false);

  const detected = useMemo(
    () => w.wallets.filter((x) => x.readyState === WalletReadyState.Installed).map((x) => ({ name: x.adapter.name, icon: x.adapter.icon })),
    [w.wallets],
  );

  useEffect(() => {
    errorRef.current = (e) => {
      if (cancelled.current) return;
      setStage((s) => (s === 'connecting' ? (isRejection(e) ? 'rejected' : 'failed') : s));
    };
    return () => { errorRef.current = null; };
  }, [errorRef]);

  useEffect(() => {
    if (!w.connected) return;
    if (cancelled.current) { cancelled.current = false; void w.disconnect(); return; }
    setStage((s) => (s === 'connecting' ? 'closed' : s));
  }, [w.connected, w]);

  const openConnect = useCallback(() => { cancelled.current = false; setStage(detected.length ? 'list' : 'empty'); }, [detected.length]);

  const pick = useCallback((name: string) => {
    cancelled.current = false;
    setPending(name);
    setStage('connecting');
    // Picking the wallet that is already selected does not re-trigger
    // autoConnect, so it is asked directly; the outcome still arrives through
    // onError or `connected`.
    if (w.wallet?.adapter.name === name) void w.connect().catch(() => {});
    else w.select(name as WalletName);
  }, [w]);

  const value = useMemo<WalletUi>(() => ({
    address: w.publicKey?.toBase58() ?? null,
    walletName: w.wallet?.adapter.name ?? null,
    stage,
    detected,
    pending,
    openConnect,
    close: () => { if (stage === 'connecting') cancelled.current = true; setStage('closed'); },
    pick,
    cancel: () => { cancelled.current = true; setStage('list'); },
    retry: () => { if (pending) pick(pending); },
    another: () => setStage(detected.length ? 'list' : 'empty'),
    recheck: () => setStage(detected.length ? 'list' : 'empty'),
    disconnect: () => { void w.disconnect(); },
  }), [w, stage, detected, pending, openConnect, pick]);

  return <WalletUiContext.Provider value={value}>{children}</WalletUiContext.Provider>;
}

export function WalletProviders({ children }: { children: ReactNode }) {
  const errorRef = useRef<((e: WalletError) => void) | null>(null);
  const onError = useCallback((e: WalletError) => { errorRef.current?.(e); }, []);
  return (
    <ConnectionProvider endpoint={ENDPOINT}>
      <WalletProvider wallets={[]} autoConnect onError={onError}>
        <Ui errorRef={errorRef}>{children}</Ui>
      </WalletProvider>
    </ConnectionProvider>
  );
}

/** 7xKX…9fQa, the form the design uses everywhere an address is shown short. */
export function shortAddress(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}
