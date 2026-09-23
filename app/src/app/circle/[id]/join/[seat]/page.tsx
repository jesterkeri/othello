import { notFound } from "next/navigation";

import Join from "@/components/join/Join";
import {
  CIRCLE_STATES,
  DEMO_LOCK_RAW,
  DEMO_STATE,
  FIXTURE_NOW,
  STATE_KEYS,
  type CircleStateKey,
} from "@/fixtures/circles";

/**
 * Nesting Join under the circle state gives every one of its states a URL
 * without inventing a second set of fixtures:
 *
 *   /circle/forming/join/3    the open invite
 *   /circle/forming/join/1    a seat that has already joined
 *   /circle/active/join/3     "This circle already started" (circle_not_forming)
 */
export function generateStaticParams() {
  return [...STATE_KEYS, "demo"].flatMap((id) =>
    [1, 2, 3, 4, 5].map((seat) => ({ id, seat: String(seat) })),
  );
}

export default async function JoinPage({
  params,
}: {
  params: Promise<{ id: string; seat: string }>;
}) {
  const { id, seat } = await params;
  const key = (id === "demo" ? DEMO_STATE : id) as CircleStateKey;
  const circle = CIRCLE_STATES[key];
  const n = Number(seat);
  if (!circle || !Number.isInteger(n) || n < 1 || n > circle.n) notFound();

  return (
    <Join
      circle={circle}
      seat={n}
      now={FIXTURE_NOW}
      stateKey={key}
      suggestedLockRaw={DEMO_LOCK_RAW}
    />
  );
}
