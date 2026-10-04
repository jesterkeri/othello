# Othello

Othello is a wallet-native savings circle: members contribute in turn, while the circle records who has paid and what is locked. This repository contains two distinct ecosystem builds:

- **Robinhood Chain:** the current testnet release, with test USDG circles and read-only Robinhood testnet Stock Token pages.
- **Solana / Stocklana:** the original Anchor implementation, devnet circle demonstration, and read-only mainnet xStock experience.

They share the Othello product idea, but they do not share assets, networks, or transaction paths. Testnet tokens are never presented as having value.

## Live builds

| Build | Link | Network and scope |
|---|---|---|
| Robinhood Chain | https://othello-chains.vercel.app/robinhood | Robinhood Chain testnet (`46630`); circles use test USDG. |
| Solana / Stocklana | https://othello-circle.vercel.app | Solana devnet circle demonstration and read-only Solana mainnet xStock views. |

## Live Robinhood Chain build

- **Judges' link:** https://othello-chains.vercel.app/robinhood
- **Network:** Robinhood Chain testnet, chain ID `46630`
- **Reviewed release commit:** `84ac22b045efa315b46bdc77c2fe3d964b3b621f`
- **Factory:** [`0x7Fc4f743a620F282EE02D83c5bDc0186c7d935D5`](https://explorer.testnet.chain.robinhood.com/address/0x7Fc4f743a620F282EE02D83c5bDc0186c7d935D5), deployed and source-verified on the testnet explorer
- **Circle asset:** test USDG. It is a test token with no value.

Start at `/robinhood`. The page opens directly to Robinhood Chain wallets, while the top bar keeps the selected EVM wallet and network aligned with every write. A person must click before the app requests accounts or a chain switch.

## What to try

| What | Where | Notes |
|---|---|---|
| Connect an EVM wallet | `/robinhood` | Robinhood Chain testnet only; no transaction is sent by connecting. |
| View the circle asset | `/robinhood/assets` | Shows a connected wallet's test USDG balance. |
| View faucet Stock Tokens | `/robinhood/assets/TSLA` and the other listed pages | TSLA, AMZN, PLTR, NFLX and AMD are Robinhood testnet ERC-20s. The pages are read only and show no price. |
| Get test assets | [Robinhood testnet faucet](https://faucet.testnet.chain.robinhood.com/) | The faucet supplies test ETH and five of each listed Stock Token. |
| Create and use a circle | `/robinhood` | Testnet circles are paid and locked in test USDG, not Stock Tokens. Every write requires an explicit wallet confirmation. |

The Assets page intentionally distinguishes the five faucet tokens from the wider Robinhood Stock Token registry: the other registry entries need mainnet and are not offered as testnet assets.

## Security and scope

- Othello does not ask for a recovery phrase, private key, or wallet password.
- The frontend has no transfer or approval path for the five Stock Tokens. It reads their public balances and supply only.
- The factory and test USDG are pinned by the release gate. The gate also pins each testnet ticker to its exact reviewed contract, so a swapped label and address fails the build.
- The release builds from a fresh clone, scans the browser bundle, and accepts only the reviewed factory, USDG, and five read-only Stock Token addresses.
- This is a testnet demonstration. No price, return, or investment advice is provided, and test assets have no value.

## Repository map

- `evm/src/`: `OthelloFactory` and `OthelloCircle` contracts.
- `evm/script/`: factory deployment and demonstration scripts.
- `evm/test/` and `core/`: contract tests, invariants, the reference model, and replay vectors.
- `app/`: Next.js application, Robinhood adapter, EIP-6963 wallet selection, and the neutral/chain-aware UI.
- `ops/`: reviewed release gate and production-release tooling.
- `tests/`: 159 TypeScript specs, including wallet state, release, bundle, and adversarial regression tests.

Run locally:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm -C app install --frozen-lockfile
corepack pnpm -C app dev
```

For the EVM suite, run `cd evm && forge test`. The full CI workflow also builds the app, checks the release gate against Robinhood testnet, and runs a read-only USDG fork suite.

## Solana / Stocklana build

The Solana implementation remains part of this repository and is separately usable from the Robinhood Chain testnet release.

- **Circle demo network:** Solana devnet, using demonstration assets.
- **Asset-view network:** Solana mainnet, read only for xStock discovery and market data.

- `programs/othello/`: the Anchor program for circles, joining and locking, contributions, release, coverage updates, defaults, liquidation, top-ups, and withdrawals. The devnet program is deployed at `DhZhSvtTh78ZK26MkVVpyeDYr4MuyTZSVrT5YEFqqrDT`.
- The Solana demo circle uses devnet assets. Its mainnet Assets pages are read-only xStock views; any mainnet wallet transaction requires the wallet holder's explicit confirmation.
- xStocks use a scaled UI multiplier for splits and dividends. The Anchor program accounts for that multiplier rather than treating a split as a loss of collateral.
- Solana devnet keys, when used by local demo tooling, live outside the repository; no credential file is tracked.

The Solana and Robinhood pages keep their network-specific assets and language separate, so a connected wallet is not asked to use an asset from the other chain.

## Honest limits

- The Robinhood release is testnet only.
- Circles currently use test USDG. The listed testnet Stock Tokens are visible assets, not circle collateral or payment assets.
- A connected wallet and its provider remain the authority for every transaction. Othello cannot protect a compromised browser, extension, or wallet.
- Dependency advisories are tracked separately and require a reviewed package-upgrade pass; no dependency update is included in this release.
