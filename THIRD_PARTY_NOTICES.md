# Third-party code

Othello's own code is under the [MIT License](LICENSE). It is built on the open-source projects below, each under its
own licence; none of their code is modified here. Exact versions are pinned in `programs/othello/Cargo.toml` /
`Cargo.lock`, `app/package.json` / `app/pnpm-lock.yaml`, `package.json` / `pnpm-lock.yaml` and the `evm/lib`
submodules.

| Project | Used for | Licence |
|---|---|---|
| [Anchor](https://github.com/solana-foundation/anchor) (`anchor-lang`, `anchor-spl`) | the Solana program | Apache-2.0 |
| [`@coral-xyz/anchor`](https://www.npmjs.com/package/@coral-xyz/anchor) | the website's Solana client | MIT OR Apache-2.0 |
| [`@solana/web3.js`](https://github.com/solana-foundation/solana-web3.js) | Solana RPC and transactions | MIT |
| [Solana wallet adapter](https://github.com/anza-xyz/wallet-adapter) (`base`, `react`) | Solana wallet connection | Apache-2.0 |
| [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) (`evm/lib`, submodule) | Solidity token interfaces and helpers | MIT |
| [forge-std](https://github.com/foundry-rs/forge-std) (`evm/lib`, submodule) | Foundry tests and scripts | MIT OR Apache-2.0 |
| [viem](https://github.com/wevm/viem) | Robinhood Chain (EVM) reads and transactions | MIT |
| [`@noble/curves`](https://github.com/paulmillr/noble-curves) | checking the buyer's signature before a signed swap is relayed | MIT |
| [Next.js](https://github.com/vercel/next.js), [React](https://github.com/facebook/react) | the website | MIT |
| [Framer Motion](https://github.com/motiondivision/motion), [Recharts](https://github.com/recharts/recharts) | animation and charts | MIT |
| [Archivo](https://github.com/Omnibus-Type/Archivo), [Plus Jakarta Sans](https://github.com/tokotype/PlusJakartaSans) (`app/public/fonts`) | typefaces | SIL Open Font License 1.1 (licence files alongside) |

External services the website calls, under their own terms: Solana RPC endpoints, the Robinhood Chain testnet RPC
and explorer, and the [Jupiter](https://jup.ag) quote and swap API (the xStock pages' mainnet buy).
