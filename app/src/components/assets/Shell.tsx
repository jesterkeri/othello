"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import s from "@/components/circle/Circle.module.css";
import { ThemeRoot } from "@/components/theme/ThemeRoot";

/** The asset pages' frame: the Circle place's nav and devnet strip, restated for mainnet reads. */
export default function AssetShell({ back, children }: { back: { href: string; label: string }; children: ReactNode }) {
  return (
    <ThemeRoot className={s.root}>
      <div className={s.frame}>
        <header className={s.nav}>
          <span className={s.logo} aria-label="Othello">
            O
          </span>
          <Link href={back.href} className={s.back}>
            <span aria-hidden>{"←"}</span> {back.label}
          </Link>
          <span className={s.navSpacer} />
          <Link href="/circle/demo" className={s.back}>
            Demo circle
          </Link>
        </header>
        <div className={s.devnet}>
          <span className={s.devnetPill}>
            <span className={s.micro}>Mainnet, read only</span>
          </span>
          <p className={s.devnetText}>
            Read live from each real mint on Solana mainnet. Nothing here is a fixture, and Othello sends nothing to mainnet.
          </p>
        </div>
        {children}
      </div>
    </ThemeRoot>
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
