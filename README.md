# Othello

> **Judges: no wallet needed.** Open a live circle on either chain directly:
>
> | Chain | Direct link | What you see |
> |---|---|---|
> | **Solana devnet** | **https://othello-chains.vercel.app/circle/demo** | A live circle, read from devnet as you watch: the ring of seats, who has paid, the pot, the payout safety check, each member's locked collateral |
> | **Robinhood Chain testnet** | **https://othello-chains.vercel.app/circle/rh:0x4bBBf722b8A3D6B5C4497eCD30c34b0FcC9aCd34** | A finished circle: every round paid out, each member collecting their own share |
>
> Home page with both: https://othello-chains.vercel.app

**Savings circles backed by stocks.** In a savings circle (an *ajo*, *esusu*, *tanda* or *chit fund*), a few people pay
the same amount every round and one member takes the whole pot each round, until everyone has had a turn. Millions
of people save this way, and the circle's one weakness is trust: a member who has already taken the pot
can stop paying.

Othello makes that risk visible and backs it with collateral. Each member locks collateral (tokenized stock on Solana)
and a small cash guarantee. Every round the circle checks, on chain, that the collateral still covers what the
remaining members are owed before it releases the pot. If a member who has already taken the pot stops paying, their
collateral and the shared reserve go toward what they owe; if that is not enough, the circle pauses until members top
up the reserve. Members keep the upside of the stock they lock, and no one has to trust a treasurer.

Othello runs on two chains with one website: **Solana devnet** (an Anchor program, xStock collateral) and **Robinhood
Chain testnet** (Solidity contracts; circles saved and collateralised in test USDG). The circles are testnet
demonstrations: test tokens have no value, and nothing on the site is financial advice.

## Try it

**Live site: https://othello-chains.vercel.app**

| What | Where | Wallet needed |
|---|---|---|
| Watch a live Solana circle on devnet: seats, rounds, coverage, the pot | [/circle/demo](https://othello-chains.vercel.app/circle/demo) | No |
| A finished Robinhood Chain circle: every round paid out, each member collecting their share | [/circle/rh:0x4bBB…Cd34](https://othello-chains.vercel.app/circle/rh:0x4bBBf722b8A3D6B5C4497eCD30c34b0FcC9aCd34) | No |
| How a circle works, step by step | [/how-it-works](https://othello-chains.vercel.app/how-it-works) | No |
| See your circles on either chain | [/circles](https://othello-chains.vercel.app/circles) | Phantom (Solana) or MetaMask (EVM) |
| Create a circle and pay into it on Robinhood Chain | [/robinhood](https://othello-chains.vercel.app/robinhood) | MetaMask on Robinhood Chain testnet (`46630`) |
| Stock pages: Solana xStocks with live Jupiter quotes, and Robinhood testnet Stock Tokens (read only) | [/assets](https://othello-chains.vercel.app/assets), [/robinhood/assets](https://othello-chains.vercel.app/robinhood/assets) | No, except to buy |

Test assets: the [Robinhood testnet faucet](https://faucet.testnet.chain.robinhood.com/) gives test ETH and five
Stock Tokens; Robinhood circles are paid in test USDG. Connecting a wallet shares only its address, and every
transaction needs the wallet holder's own confirmation.

**The one mainnet action:** an xStock page can buy that xStock with USDC through Jupiter. It is a real Solana mainnet
swap with real funds, built by Jupiter, checked by the site and signed in the buyer's own wallet; Othello never holds
the funds or a key.

## How it works

1. **Form.** A creator sets the members, the contribution, the round length and the cover rules. Each member joins by
   locking collateral and a guarantee.
2. **Pay.** Every round each member contributes the same amount. Payments are recorded on chain, so everyone sees who
   has paid.
3. **Release.** When the round is funded, anyone can release the pot to that round's member. On Solana the program
   first checks that every member's collateral, valued at a haircut, still covers what the circle is owed (invariant
   I1); if it does not, the circle pauses until someone tops up.
4. **Default.** If a member who has already received the pot misses a payment past the grace period, anyone can
   declare the default (on Robinhood Chain the missed payment is first marked late). Their collateral and the free
   reserve are applied to what they still owe. If that does not cover it, the circle records the shortfall and pauses
   payouts until members top up the reserve. Top-ups fill the shortfall first; any shortfall left keeps payouts
   paused.
5. **Finish.** After the last round each member withdraws what is left of their own deposit.

Tokenized stocks split and pay dividends. Solana xStocks carry a scaled UI multiplier for that; the program values
collateral through the multiplier, so a stock split is never mistaken for a loss of collateral.

## On chain

| Chain | Code | Address |
|---|---|---|
| Solana devnet | `programs/othello/` (Anchor 1.1, about 5,500 lines of Rust) | Program `DhZhSvtTh78ZK26MkVVpyeDYr4MuyTZSVrT5YEFqqrDT` |
| Robinhood Chain testnet (`46630`) | `evm/src/` (`OthelloFactory`, `OthelloCircle`, about 720 lines of Solidity) | Factory [`0x7Fc4f743a620F282EE02D83c5bDc0186c7d935D5`](https://explorer.testnet.chain.robinhood.com/address/0x7Fc4f743a620F282EE02D83c5bDc0186c7d935D5), source-verified |

On Solana devnet the stock prices come from a price feed the program's upgrade authority sets
(`init_price_feed`, `set_prices`, `touch_prices`); the program refuses a price older than the circle's maximum age.
A production build would read an oracle instead. The demo circle uses devnet mirror tokens of real xStocks.

## Repository map

- `programs/othello/`: the Anchor program (circles, joining and locking, contributions, release, coverage, defaults,
  top-ups, withdrawals, the price feed and the liquidation pool).
- `evm/`: Solidity contracts, Foundry tests and deployment scripts.
- `core/`: the shared reference model and replay vectors both chains are tested against.
- `app/`: the Next.js website, one chain-neutral interface over a Solana adapter and a Robinhood adapter.
- `ops/`: the release gate (it rebuilds from a clean clone, scans the browser bundle and pins every contract address)
  and the devnet demo tooling.
- `tests/`: TypeScript specs, including bankrun tests of the program and adversarial regression tests.
- `SPEC.md`, `INVARIANTS.md`: the specification and the invariants the tests check.

## Run it locally

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm -C app install --frozen-lockfile
corepack pnpm -C app dev
```

- Solana program: `anchor build`, then a spec, for example
  `npx mocha --import=tsx --timeout 900000 tests/t09-join-and-lock.spec.ts`.
- Solidity: `cd evm && forge test`.
- CI: the harness workflow (guardrails, secret scan) runs on every pull request; the EVM workflow (app build, Solidity
  contracts, reference model, read-only USDG fork suite, release gate) runs when its configured app, EVM, core, release or
  selected test paths change.

## Honest limits

- The circles are testnet and devnet only; no Othello program or contract is on mainnet, and test assets have no
  value. The xStock buy on the Assets pages is a mainnet Jupiter swap, separate from the circles.
- Solana prices on devnet are set by the program's upgrade authority, not read from an oracle.
- Solana circles are created with the devnet tooling in `ops/`; the website creates Robinhood circles.
- Robinhood testnet circles hold test USDG; the testnet Stock Tokens are shown read only, not used as collateral.
- Not audited. The program and contracts were reviewed by independent AI reviewers and adversarial tests, which is
  not a substitute for an audit.
- Your wallet stays the authority for every transaction. Othello never asks for a recovery phrase or private key.

## Hackathons

Othello was built from 2026-09-21. It was entered at Solana's Stocklana hackathon (submitted 2026-09-25, Solana
devnet) and the Arbitrum Open House buildathon (the Robinhood Chain build), and is submitted to Colosseum's Crypto
World's Fair. See [HACKATHON.md](HACKATHON.md).

## License

[MIT](LICENSE). Third-party code and its licences: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
