import { notFound } from "next/navigation";

import Circle from "@/components/circle/Circle";
import LiveCircle from "@/components/live/LiveCircle";
import RobinhoodCircle from "@/components/robinhood/RobinhoodCircle";
import {
  CIRCLE_STATES,
  FIXTURE_NOW,
  STALE_NOW,
  STATE_KEYS,
  type CircleStateKey,
} from "@/fixtures/circles";

/**
 * Every Circle state in design/FLOWS.md §7 gets its own URL, which is how G4's
 * "every place renders each of its states" is checked rather than asserted.
 *
 *   /circle/demo        what "Open demo circle" opens: the demo circle LIVE
 *                       from devnet (T18), not a fixture
 *   /circle/<state>     one per Data state: forming, active, paused,
 *                       repricing, completed, cancelled
 *   /circle/stale       the demo circle read past its max_price_age (D6)
 *   /circle/rh:<addr>   a circle on Robinhood Chain testnet (ARB-DESIGN r9), shown only if the
 *                       official factory made it
 */
export function generateStaticParams() {
  return [...STATE_KEYS, "demo", "stale"].map((id) => ({ id }));
}

type Params = { params: Promise<{ id: string }> };

export default async function CirclePage({ params }: Params) {
  const { id: raw } = await params;
  const id = decodeURIComponent(raw);

  if (id.startsWith("rh:")) return <RobinhoodCircle address={id.slice(3)} />;

  if (id === "stale") {
    return (
      <Circle circle={CIRCLE_STATES.active} startNow={STALE_NOW} stateKey="active" />
    );
  }

  if (id === "demo") return <LiveCircle />;

  const key = id as CircleStateKey;
  const circle = CIRCLE_STATES[key];
  if (!circle) notFound();

  return <Circle circle={circle} startNow={FIXTURE_NOW} stateKey={key} />;
}
