/**
 * Each xStock's palette slot, the same on every page (Joshua: a stock's page uses its colour from
 * the list). The four a circle accepts keep the circle page's colours; the rest are fixed by their
 * symbol, so sorting or filtering never recolours a stock.
 */
const COVER: Record<string, string> = { SPYx: "teal", NVDAx: "cobalt", AAPLx: "sky", NFLXx: "acid" };
const SLOTS = ["clay", "sky", "teal", "cobalt", "acid"] as const;

export function slotFor(symbol: string): string {
  if (COVER[symbol]) return COVER[symbol]!;
  let h = 0;
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SLOTS[h % SLOTS.length]!;
}
