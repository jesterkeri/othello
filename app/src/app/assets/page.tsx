import type { Metadata } from "next";

import AssetsIndex from "@/components/assets/AssetsIndex";

export const metadata: Metadata = { title: "Assets · Othello" };

export default function AssetsPage() {
  return <AssetsIndex />;
}
