import { notFound } from "next/navigation";

import Circle from "@/components/circle/Circle";
import {
  CIRCLE_STATES,
  DEMO_STATE,
  FIXTURE_NOW,
  STALE_NOW,
  STATE_KEYS,
  type CircleStateKey,
} from "@/fixtures/circles";

/**
 * Every Circle state in design/FLOWS.md §7 gets its own URL, which is how G4's
 * "every place renders each of its states" is checked rather than asserted.
 *
 *   /circle/demo        what "Open demo circle" opens
 *   /circle/<state>     one per Data state: forming, active, paused,
 *                       repricing, completed, cancelled
 *   /circle/stale       the demo circle read past its max_price_age (D6)
 */
export function generateStaticParams() {
  return [...STATE_KEYS, "demo", "stale"].map((id) => ({ id }));
}

type Params = { params: Promise<{ id: string }> };

export default async function CirclePage({ params }: Params) {
  const { id } = await params;

  if (id === "stale") {
    return (
      <Circle circle={CIRCLE_STATES.active} startNow={STALE_NOW} stateKey="active" />
    );
  }

  const key = (id === "demo" ? DEMO_STATE : id) as CircleStateKey;
  const circle = CIRCLE_STATES[key];
  if (!circle) notFound();

  return <Circle circle={circle} startNow={FIXTURE_NOW} stateKey={key} />;
}
