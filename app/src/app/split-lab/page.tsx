import type { Metadata } from "next";

import SplitLab from "@/components/splitlab/SplitLab";

export const metadata: Metadata = { title: "Split lab · Othello" };

/** The Split lab place (design/FLOWS.md): what a stock split does to locked stock, on the real NFLXx 10-for-1. */
export default function SplitLabPage() {
  return <SplitLab />;
}
