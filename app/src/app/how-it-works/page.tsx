import type { Metadata } from "next";

import HowItWorks from "@/components/howitworks/HowItWorks";

export const metadata: Metadata = { title: "How it works · Othello" };

/** The judge's path: six steps with live figures from the demo circle, each linking into the app. */
export default function HowItWorksPage() {
  return <HowItWorks />;
}
