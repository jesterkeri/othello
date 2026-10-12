"use client";

import { useEffect, useState } from "react";
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
  // Known only in the browser; the prerender carries both views and CSS shows the right one until then.
  const [phone, setPhone] = useState(false);

  // On load, and when a window narrows to phone width. Setting `phone` in the same commit as the landing's own first
  // effect drops the landing before its theme effects run, so a phone that never sees the landing does not have the
  // landing's default theme saved for it (PR #31 adversary).
  useEffect(() => {
    const query = window.matchMedia(PHONE);
    const go = () => {
      const to = phoneHome(query.matches);
      if (!to) return;
      setPhone(true);
      router.replace(to);
    };
    go();
    query.addEventListener("change", go);
    return () => query.removeEventListener("change", go);
  }, [router]);

  // Once it is known to be a phone, the line shows at any width (a phone turned sideways mid-redirect stays readable).
  const opening = (
    <main className={phone ? `${s.phone} ${s.known}` : s.phone}>
      <p>Opening your circles…</p>
      <a href="/circles">Go to circles</a>
    </main>
  );
  if (phone) return opening;
  return (
    <>
      {opening}
      <div className={s.home}>
        <Landing side={side} onConnectWallet={wallet.openConnect} />
      </div>
    </>
  );
}
