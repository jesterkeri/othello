"use client";

import type { useEvmWallet } from "@/lib/robinhood/wallet";

import s from "./Robinhood.module.css";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The top bar's wallet control on Robinhood pages: the EVM wallet, never the Solana one. */
export default function EvmWalletPill({ w }: { w: ReturnType<typeof useEvmWallet> }) {
  if (!w.hasWallet) return <span className={s.walletPill}>No EVM wallet</span>;
  if (!w.address) {
    return <button type="button" className={s.walletPill} onClick={() => void w.connect()}>Connect EVM wallet</button>;
  }
  if (!w.onRobinhood) {
    return <button type="button" className={s.walletPill} onClick={() => void w.switchToRobinhood()}>Switch network</button>;
  }
  return <span className={s.walletPill} title={w.address}>{short(w.address)}</span>;
}
