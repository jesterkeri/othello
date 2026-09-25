import type { Metadata } from "next";
import { notFound } from "next/navigation";

import AssetDetail from "@/components/assets/AssetDetail";
import { REAL_XSTOCKS } from "@/lib/devnet";

/** One page per allowlisted xStock (ADR-012); anything else is a 404, not an empty page. */
export function generateStaticParams() {
  return REAL_XSTOCKS.map((x) => ({ symbol: x.symbol }));
}
export const dynamicParams = false;

type Params = { params: Promise<{ symbol: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { symbol } = await params;
  return { title: `${symbol} · Othello` };
}

export default async function AssetPage({ params }: Params) {
  const { symbol } = await params;
  if (!REAL_XSTOCKS.some((x) => x.symbol === symbol)) notFound();
  return <AssetDetail symbol={symbol} />;
}
