"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import s from "@/components/circle/Circle.module.css";
import Shell from "@/components/othello/Shell";

/** The asset pages' frame: the Circle place's nav and devnet strip, restated for mainnet reads. */
export default function AssetShell({ back, children }: { back: { href: string; label: string }; children: ReactNode }) {
  return (
    <Shell active="Stocks" network={{ chip: "Mainnet, read only", note: "Real xStocks, read live from Solana mainnet. Othello sends nothing to mainnet." }}>
      <div className={s.frame}>
        {children}
      </div>
    </Shell>
  );
}

export function Unavailable({ error }: { error: string }) {
  return (
    <div className={s.banners}>
      <div className={`${s.banner} ${s.bannerRefusal}`} role="status">
        <span className={s.bannerMark} aria-hidden>
          ?
        </span>
        <span className={s.bannerBody}>
          <span className={s.bannerTitle}>Live data unavailable</span>
          <p className={s.bannerText}>{error}</p>
        </span>
      </div>
    </div>
  );
}
