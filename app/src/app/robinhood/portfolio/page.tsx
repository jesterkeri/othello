import type { Metadata } from "next";

import RobinhoodPortfolio from "@/components/robinhood/RobinhoodPortfolio";

export const metadata: Metadata = { title: "Portfolio · Othello" };

export default function RobinhoodPortfolioPage() {
  return <RobinhoodPortfolio />;
}
