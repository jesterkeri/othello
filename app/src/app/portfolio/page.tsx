import type { Metadata } from "next";

import Portfolio from "@/components/portfolio/Portfolio";

export const metadata: Metadata = { title: "Portfolio · Othello" };

export default function PortfolioPage() {
  return <Portfolio />;
}
