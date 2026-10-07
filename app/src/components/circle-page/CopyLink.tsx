"use client";

/** "Share this circle": copies the page's permanent link (its own state, so a chain's page keeps its hook order). */
import { useState } from "react";

import s from "@/components/circle/Circle.module.css";

export default function CopyLink({ title, text, label }: { title: string; text: string; label: string }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");
  const run = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  };
  return (
    <div className={s.action}>
      <span className={s.actionText}>
        <span className={s.bannerTitle}>{title}</span>
        <span className={s.actFixture}>{text}</span>
      </span>
      <button type="button" className={s.pay} onClick={() => void run()}>{label}</button>
      {copy === "copied" && <span className={s.actFixture}>Circle link copied.</span>}
      {copy === "failed" && <span className={s.actFixture}>Copy was blocked. Copy this page&apos;s address from your browser instead.</span>}
    </div>
  );
}
