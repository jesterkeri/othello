import { notFound } from "next/navigation";

import Position from "@/components/position/Position";
import {
  CIRCLE_STATES,
  DEMO_STATE,
  FIXTURE_NOW,
  STATE_KEYS,
  type CircleStateKey,
} from "@/fixtures/circles";

/**
 * The three Position Data states of design/FLOWS.md §7 come from the circle
 * states that already exist, rather than from fixtures written for this screen:
 *
 *   /circle/forming/position/3    before join
 *   /circle/active/position/1     locked
 *   /circle/completed/position/1  withdrawn
 */
export function generateStaticParams() {
  return [...STATE_KEYS, "demo"].flatMap((id) =>
    [1, 2, 3, 4, 5].map((seat) => ({ id, seat: String(seat) })),
  );
}

export default async function PositionPage({
  params,
}: {
  params: Promise<{ id: string; seat: string }>;
}) {
  const { id, seat } = await params;
  const key = (id === "demo" ? DEMO_STATE : id) as CircleStateKey;
  const circle = CIRCLE_STATES[key];
  const n = Number(seat);
  if (!circle || !Number.isInteger(n) || n < 1 || n > circle.n) notFound();

  return <Position circle={circle} seat={n} now={FIXTURE_NOW} stateKey={key} />;
}
