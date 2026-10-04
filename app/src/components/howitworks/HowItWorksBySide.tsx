'use client';

import HowItWorks from '@/components/howitworks/HowItWorks';
import HowItWorksNeutral from '@/components/howitworks/HowItWorksNeutral';
import { useActiveSide } from '@/lib/active-side';

/** The Solana walkthrough with a Solana wallet; otherwise the neutral page, with Robinhood Chain's facts for an EVM one. */
export default function HowItWorksBySide() {
  const { side } = useActiveSide();
  if (side === 'solana') return <HowItWorks />;
  return <HowItWorksNeutral side={side} />;
}
