/**
 * The Robinhood side of the shared circles list: the card logic moved to lib/core/circle-card.ts (one frontend for
 * both chains, Joshua 2026-10-06). This keeps the Robinhood entry point, a circle read straight from the chain.
 */
import { circleCard as cardOf, type CircleCard } from "../core/circle-card";
import type { RhCircleView } from "./adapter";
import { rhToList } from "./to-list";

export { dueIn, groupCards, type CardGroup, type CircleCard } from "../core/circle-card";

export const circleCard = (v: RhCircleView, me: string): CircleCard => cardOf(rhToList(v, me), me);
