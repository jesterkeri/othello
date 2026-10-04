import type { Metadata } from "next";
import { notFound } from "next/navigation";

import RobinhoodAssetDetail from "@/components/robinhood/RobinhoodAssetDetail";
import { TESTNET_STOCK_TOKENS } from "@/lib/robinhood/testnet-stocks";

/** One page per Stock Token on testnet (lib/robinhood/testnet-stocks.ts); anything else is a 404, not an empty page. */
export function generateStaticParams() {
  return TESTNET_STOCK_TOKENS.map((t) => ({ symbol: t.symbol }));
}
export const dynamicParams = false;

type Params = { params: Promise<{ symbol: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { symbol } = await params;
  return { title: `${symbol} · Robinhood Chain · Othello` };
}

export default async function RobinhoodAssetPage({ params }: Params) {
  const { symbol } = await params;
  if (!TESTNET_STOCK_TOKENS.some((t) => t.symbol === symbol)) notFound();
  return <RobinhoodAssetDetail symbol={symbol} />;
}
