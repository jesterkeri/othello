import type { Metadata } from "next";

import RobinhoodAssets from "@/components/robinhood/RobinhoodAssets";

export const metadata: Metadata = { title: "Assets · Robinhood Chain · Othello" };

export default function RobinhoodAssetsPage() {
  return <RobinhoodAssets />;
}
