import type { Metadata } from "next";

import HowItWorksBySide from "@/components/howitworks/HowItWorksBySide";

export const metadata: Metadata = { title: "How it works · Othello" };

/** Neutral, or Robinhood Chain's, or (with a Solana wallet) the live Solana demo walkthrough: the wallet decides. */
export default function HowItWorksPage() {
  return <HowItWorksBySide />;
}
