import { notFound } from "next/navigation";

import LiveSeat from "@/components/live/LiveSeat";
import { parseAddress } from "@/lib/sol-address";

import Join from "@/components/join/Join";
import {
  CIRCLE_STATES,
  DEMO_LOCK_RAW,
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
  const { id: raw, seat } = await params;
  // as /circle/[id]: a link may carry the "sol:" prefix encoded (sol%3A...)
  const id = decodeURIComponent(raw);
  // The live demo circle reads the chain, like /circle/demo itself (T18).
  if (id === "demo") {
    const n = Number(seat);
    if (!Number.isInteger(n) || n < 1 || n > 5) notFound();
    return <LiveSeat kind="join" seat={n} />;
  }
  // any other Solana circle (seats 1 to 8, the program's most); LiveSeat refuses a seat the circle does not have
  if (id.startsWith("sol:")) {
    const address = parseAddress(id.slice(4));
    const n = Number(seat);
    if (!address || !Number.isInteger(n) || n < 1 || n > 8) notFound();
    return <LiveSeat kind="join" seat={n} address={address} />;
  }
  const key = id as CircleStateKey;
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
