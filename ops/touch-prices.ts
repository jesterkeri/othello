/**
 * SPEC.md:137 / TASKS T26: keeps the devnet demo price fresh. Joshua runs it.
 *
 *   pnpm tsx ops/touch-prices.ts --cluster devnet
 *
 * Calls touch_prices ONLY: the feed's updated_at becomes the chain's now, and the prices and the multiplier they are
 * stamped for stay exactly as they are (I17). A circle accepts a price up to its max_price_age old (the demo's: 8
 * days), so run it before a recording or a try, and again within 8 days of the last run. Signs with the admin wallet
 * ($ANCHOR_WALLET or ~/.config/solana/id.json); one transaction, the base fee only.
 * The same function is proven on the devnet build by tests/b2-devnet-try.spec.ts.
 */
import { touchPrices } from "./demo.ts";
import { devnetChain } from "./devnet-cli.ts";

const [flag, cluster] = process.argv.slice(2);
if (flag !== "--cluster" || cluster !== "devnet") {
  console.error("Usage: pnpm tsx ops/touch-prices.ts --cluster devnet");
  process.exit(1);
}

const { chain, mints } = await devnetChain();
await touchPrices(chain, mints);
