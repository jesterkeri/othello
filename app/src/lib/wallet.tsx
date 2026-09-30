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
 *
 * The same modal lists EVM wallets for Robinhood Chain (lib/robinhood/wallet.ts)
 * beside the Solana ones, and the wallet a person picks decides the chain: after
 * a connect they are taken to that wallet's side (lib/chains.ts, A2-SWITCH). A
 * restore on reload never navigates; only a pick does.
 */
import { useCallback, useEffect, useMemo, useRef, useState, createContext, useContext, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ConnectionProvider, WalletProvider, useWallet } from '@solana/wallet-adapter-react';
import { WalletReadyState, type WalletError, type WalletName } from '@solana/wallet-adapter-base';
import { clusterApiUrl } from '@solana/web3.js';

import { destinationAfterConnect, type ChainSide } from '@/lib/chains';
import { isRejection as isEvmRejection } from '@/lib/robinhood/evm-session';
import { useEvmWallet } from '@/lib/robinhood/wallet';

/** The modal's screens, named as in the design (Wallet Screen, rows 1a to 1e). */
export type ConnectStage = 'closed' | 'list' | 'empty' | 'connecting' | 'rejected' | 'failed';

export type DetectedWallet = { name: string; icon: string };
/** An EVM wallet found by EIP-6963; its icon is a checked data:image URI or null. */
export type DetectedEvmWallet = { uuid: string; name: string; icon: string | null };

type WalletUi = {
  address: string | null;
  walletName: string | null;
  stage: ConnectStage;
  /** Solana wallets installed in this browser, in the order the adapter found them. */
  detected: DetectedWallet[];
  /** EVM wallets for Robinhood Chain, in the order they announced themselves. */
  evmDetected: DetectedEvmWallet[];
  /** The wallet being connected, or the one that just refused. */
  pending: string | null;
  /** Which chain the pending wallet is for. */
  pendingKind: ChainSide | null;
  /**
   * A Solana wallet's request is still open in its own window (the library is connecting). No Solana wallet may be
   * picked until it answers: the library's late answer to an old pick deselects whatever wallet is selected by then.
   */
  solanaBusy: boolean;
  openConnect: () => void;
  close: () => void;
  pick: (name: string) => void;
  /** Connect an EVM wallet (by its EIP-6963 uuid) for Robinhood Chain. */
  pickEvm: (uuid: string) => void;
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
  const evm = useEvmWallet();
  const router = useRouter();
  const pathname = usePathname();
  const path = useRef(pathname);
  path.current = pathname;
  const [stage, setStage] = useState<ConnectStage>('closed');
  const [pending, setPending] = useState<string | null>(null);
  const [pendingKind, setPendingKind] = useState<ChainSide | null>(null);
  const [pendingUuid, setPendingUuid] = useState<string | null>(null);
  // Set when a person picks a Solana wallet, so the connect that follows (and only that one, not a restore on
  // reload) takes them to the Solana side.
  const goAfterSolana = useRef(false);
  // Each EVM pick gets a number; an answer to an older pick is dropped. An EVM cancel has its own flag: sharing
  // `cancelled` let an EVM pick re-arm a Solana connect the person had cancelled (adversary pass on 04fc114), and an
  // EVM cancel must never disconnect a Solana wallet.
  const evmPick = useRef(0);
  const evmCancelled = useRef(false);
  // True from a Solana pick until its outcome: only then may a Solana connect close the modal. A restore, an account
  // switch in the wallet, or a wallet connected before is not a pick (adversary pass on 1bbd3c4).
  const solanaPicking = useRef(false);
  // Set by Cancel. The wallet's own prompt cannot be withdrawn from here, so if
  // it is approved after the person cancelled, the connection is dropped
  // rather than appearing out of nowhere.
  const cancelled = useRef(false);

  const detected = useMemo(
    () => w.wallets.filter((x) => x.readyState === WalletReadyState.Installed).map((x) => ({ name: x.adapter.name, icon: x.adapter.icon })),
    [w.wallets],
  );
  const evmDetected = useMemo(() => evm.wallets.map((x) => ({ uuid: x.info.uuid, name: x.info.name, icon: x.info.icon })), [evm.wallets]);
  const anyDetected = detected.length + evmDetected.length > 0;

  useEffect(() => {
    errorRef.current = (e) => {
      goAfterSolana.current = false;
      const wasPicking = solanaPicking.current;
      solanaPicking.current = false;
      if (cancelled.current) { cancelled.current = false; return; }
      if (!wasPicking) return;
      setStage((s) => (s === 'connecting' ? (isRejection(e) ? 'rejected' : 'failed') : s));
    };
    return () => { errorRef.current = null; };
  }, [errorRef]);

  useEffect(() => {
    if (!w.connected) return;
    if (!solanaPicking.current && !cancelled.current) return;
    solanaPicking.current = false;
    if (cancelled.current) { cancelled.current = false; goAfterSolana.current = false; void w.disconnect(); return; }
    setStage((s) => (s === 'connecting' ? 'closed' : s));
    if (goAfterSolana.current) {
      goAfterSolana.current = false;
      const to = destinationAfterConnect('solana', path.current);
      if (to) router.push(to);
    }
  }, [w.connected, w, router]);

  // Opening the modal does not re-arm a Solana connect the person closed or cancelled: only a new Solana pick does
  // (adversary pass on 9a24341), so a late approval of the old prompt is still dropped.
  const openConnect = useCallback(() => { setStage(anyDetected ? 'list' : 'empty'); }, [anyDetected]);

  const pick = useCallback((name: string) => {
    // Never select a Solana wallet while the library is still connecting one: when that older request fails, the
    // library's autoConnect calls changeWallet(null) and deselects the wallet selected by then, without onError
    // (wallet-adapter-react 0.15.40 WalletProvider handleConnectError; adversary pass on b94f89a).
    if (w.connecting) return;
    evmPick.current++;
    evm.cancelPending();
    // A Solana wallet is already connected (the modal can be opened from the Robinhood side): picking it goes to the
    // Solana side, with nothing to ask; another Solana wallet is not offered, because selecting it would disconnect
    // the connected one before the new one answered (adversary pass on 1bbd3c4).
    if (w.connected) {
      if (w.wallet?.adapter.name === name) {
        setStage('closed');
        const to = destinationAfterConnect('solana', path.current);
        if (to) router.push(to);
      }
      return;
    }
    cancelled.current = false;
    solanaPicking.current = true;
    goAfterSolana.current = true;
    setPending(name);
    setPendingKind('solana');
    setPendingUuid(null);
    setStage('connecting');
    // Picking the wallet that is already selected does not re-trigger
    // autoConnect, so it is asked directly; the outcome still arrives through
    // onError or `connected`.
    if (w.wallet?.adapter.name === name) void w.connect().catch(() => {});
    else w.select(name as WalletName);
  }, [w, evm, router]);

  const pickEvm = useCallback((uuid: string) => {
    const name = evm.wallets.find((x) => x.info.uuid === uuid)?.info.name ?? 'your wallet';
    const mine = ++evmPick.current;
    evmCancelled.current = false;
    goAfterSolana.current = false;
    setPending(name);
    setPendingKind('robinhood');
    setPendingUuid(uuid);
    setStage('connecting');
    evm.connectWith(uuid).then(
      () => {
        // Cancelled, closed or superseded: the session already dropped the wallet's late answer (cancelPending), so
        // there is nothing to undo here, and the wallet connected before, if any, is untouched.
        if (mine !== evmPick.current || evmCancelled.current) return;
        setStage('closed');
        const to = destinationAfterConnect('robinhood', path.current);
        if (to) router.push(to);
      },
      (e: unknown) => {
        if (mine !== evmPick.current || evmCancelled.current) return;
        setStage(isEvmRejection(e) ? 'rejected' : 'failed');
      },
    );
  }, [evm, router]);

  /** Abandons the connect waiting in a wallet: only the kind that is waiting, so neither side's cancel touches the other. */
  const cancelPendingPick = useCallback(() => {
    if (pendingKind === 'robinhood') { evmCancelled.current = true; evm.cancelPending(); }
    else cancelled.current = true;
  }, [pendingKind, evm]);

  const value = useMemo<WalletUi>(() => ({
    address: w.publicKey?.toBase58() ?? null,
    walletName: w.wallet?.adapter.name ?? null,
    stage,
    detected,
    evmDetected,
    pending,
    pendingKind,
    solanaBusy: w.connecting && !w.connected,
    openConnect,
    close: () => {
      if (stage === 'connecting') cancelPendingPick();
      goAfterSolana.current = false;
      setStage('closed');
    },
    pick,
    pickEvm,
    cancel: () => { cancelPendingPick(); goAfterSolana.current = false; setStage('list'); },
    retry: () => {
      if (pendingKind === 'robinhood' && pendingUuid) pickEvm(pendingUuid);
      else if (pending) pick(pending);
    },
    another: () => setStage(anyDetected ? 'list' : 'empty'),
    recheck: () => setStage(anyDetected ? 'list' : 'empty'),
    disconnect: () => { void w.disconnect(); },
  }), [w, stage, detected, evmDetected, pending, pendingKind, pendingUuid, anyDetected, openConnect, pick, pickEvm, cancelPendingPick]);

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
