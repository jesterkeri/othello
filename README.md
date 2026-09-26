# Othello

**A savings circle (ajo, esusu, tontine) where every member locks real tokenized stock as collateral, so the pot keeps paying out even when someone stops.**

Friends pay in every round and take the whole pot once, in turn. The one failure mode is the member who takes the pot and then stops paying. In Othello, each member locks an xStock (tokenized shares on Solana) before the circle starts. If someone who already took the pot misses a payment, anyone can declare the default after the grace period: enough of their locked stock is sold to a liquidation pool to cover what they still owe, and a shared reserve covers any shortfall. The stock stays the member's own and comes back when the circle ends.

- **Live demo:** https://othello-circle.vercel.app
- **Built for:** Stocklana (Solana), September 2026

## Try it

| What | Where | Network |
|---|---|---|
| The live demo circle: five members, stakes, reserve, turn order | Circles | Solana devnet (test USDC, a labelled NFLXx devnet mirror) |
| Release a pot, update coverage, declare a default, from any devnet wallet, when the circle allows it | Circles | devnet (free devnet SOL: faucet.solana.com) |
| What a 10-for-1 split does to locked stock | How it works → Split lab | in the browser |
| 22 buyable xStocks, live prices, charts, the multiplier, the issuer's powers decoded from each mint | Assets | Solana mainnet, read only |
| **Buy a real xStock**, in the app, through Jupiter, signed in your own wallet | Assets → any stock | **Solana mainnet, real funds** (from 0.10 USDC plus ~0.005 SOL for fees) |
| Your mainnet total, wallet USDC and SOL, xStocks, circle seat, devnet funds kept apart | Portfolio | mainnet + devnet |

Every button that sends a transaction is enabled only when the program would accept it, and says why otherwise. The demo circle's other members are run by us; the demo video shows a full round.

## Why xStocks and Solana

xStocks change a token's multiplier for splits and dividends. A vault that reads the displayed balance would see a 10-for-1 split as a 90% loss and liquidate everyone. The Anchor program reads the Token-2022 Scaled UI multiplier from the mint, bit for bit, and values locked stock as raw × multiplier × price, so a split can neither inflate nor erase anyone's cover.

## How it is built

- `programs/othello/`: the Anchor program (circles, join and lock, contribute, release, update coverage, default and liquidation, top up, withdraw). Deployed on devnet at `DhZhSvtTh78ZK26MkVVpyeDYr4MuyTZSVrT5YEFqqrDT`.
- `app/`: Next.js. Reads the demo circle from devnet and the real xStocks from mainnet through server routes; the RPC URLs stay on the server.
- Buy: the server has Jupiter build the swap for the buyer and checks it (paid and owned by the buyer, the listed stock, bounded fees) before the buyer signs it in their own wallet; the server relays only that swap. Othello never holds a key or funds.
- `tests/`: 50 spec files, run against the program in a local bankrun and against recorded mainnet data.
- `SPEC.md` is the design; `TASKS.md` the work list; `reviews/` the review record.

Run locally: `pnpm -C app install --frozen-lockfile && pnpm -C app dev`.

## Honest limits

- The circle runs on devnet with test USDC and a labelled mirror of NFLXx. Creating your own circle is not in this demo yet: new members would need mirror stock, and a devnet faucet comes next.
- A member who stops paying before their turn can stall the circle. The stock's issuer can freeze, pause or move its tokens (each stock page shows those powers).
- Nothing runs by itself: every step happens when someone sends the transaction.
- Buy's security boundary: the buyer's wallet is the authorisation. The wallet shows the transaction (and its balance changes) before signing, and nothing moves without that signature. Othello's server builds only the requested, quoted purchase, checks every account and amount it can see, seals it, and relays only that sealed transaction. It does not defend against a compromised browser or wallet, which could bypass Othello entirely; and it does not decode Jupiter's individual route steps, only the route's accounts, amounts, slippage and fee.
- Othello pays no APR. Members get the pot interest-free, and their stock keeps its own returns. The planned business model, not in this version, is a 0.5% fee on each pot.

## Built with (open source)

Anchor, Next.js, @solana/web3.js and wallet-adapter, Token-2022 Scaled UI Amount, Jupiter (quotes and swaps), GeckoTerminal (price history), recharts.
