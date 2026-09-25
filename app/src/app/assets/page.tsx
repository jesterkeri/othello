import type { Metadata } from "next";

import AssetsIndex from "@/components/assets/AssetsIndex";

export const metadata: Metadata = { title: "xStocks · Othello" };

export default function AssetsPage() {
  return <AssetsIndex />;
}
