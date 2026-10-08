"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import Landing from "@/components/landing/Landing";
import { useActiveSide } from "@/lib/active-side";
import { PHONE, phoneHome } from "@/lib/phone";
import { useWalletUi } from "@/lib/wallet";

import s from "./home.module.css";

/**
 * The home page: neutral with no wallet; with one, it leads to that wallet's chain (lib/active-side.ts).
 * On a phone there is no landing (Joshua, 2026-10-08): it goes straight to /circles, which leads to the connected
 * wallet's circles or asks for a wallet.
 */
export default function Page() {
  const wallet = useWalletUi();
  const { side } = useActiveSide();
  const router = useRouter();
  // On load, and when a window narrows to phone width (the landing is hidden there, so it must not stay blank).
  useEffect(() => {
    const query = window.matchMedia(PHONE);
    const go = () => {
      const to = phoneHome(query.matches);
      if (to) router.replace(to);
    };
    go();
    query.addEventListener("change", go);
    return () => query.removeEventListener("change", go);
  }, [router]);
  return (
    <div className={s.home}>
      <Landing side={side} onConnectWallet={wallet.openConnect} />
    </div>
  );
}
