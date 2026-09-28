"use client";

/**
 * The injected EVM wallet (EIP-1193, e.g. MetaMask) for Robinhood Chain pages. Signing stays in the
 * wallet; this only reads the account and chain and asks the wallet to switch to Robinhood Chain testnet.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, getAddress, http, type Address, type EIP1193Provider } from "viem";

import { ROBINHOOD_TESTNET_ID, robinhoodTestnet } from "./chain";

export const robinhoodPublicClient = createPublicClient({ chain: robinhoodTestnet, transport: http(undefined, { batch: true }) });

const HEX_ID = `0x${ROBINHOOD_TESTNET_ID.toString(16)}`;

function injected(): EIP1193Provider | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
}

export function useEvmWallet() {
  const [address, setAddress] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Read after mount: the server has no window, so the first render must match it (no hydration mismatch).
  const [eth, setEth] = useState<EIP1193Provider | undefined>(undefined);
  useEffect(() => setEth(injected()), []);

  useEffect(() => {
    if (!eth) return;
    const onAccounts = (a: unknown) => setAddress(Array.isArray(a) && a[0] ? getAddress(a[0] as string) : null);
    const onChain = (id: unknown) => setChainId(Number.parseInt(String(id), 16));
    void eth.request({ method: "eth_accounts" }).then(onAccounts).catch(() => {});
    void eth.request({ method: "eth_chainId" }).then(onChain).catch(() => {});
    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);
    return () => {
      eth.removeListener("accountsChanged", onAccounts);
      eth.removeListener("chainChanged", onChain);
    };
  }, [eth]);

  const connect = useCallback(async () => {
    setError(null);
    if (!eth) {
      setError("No EVM wallet found. Install MetaMask or another EVM wallet to use Robinhood Chain.");
      return;
    }
    try {
      const a = await eth.request({ method: "eth_requestAccounts" });
      setAddress(a[0] ? getAddress(a[0]) : null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [eth]);

  const switchToRobinhood = useCallback(async () => {
    if (!eth) return;
    setError(null);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: HEX_ID }] });
    } catch (e) {
      if ((e as { code?: number }).code !== 4902) {
        setError(e instanceof Error ? e.message : String(e));
        return;
      }
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: HEX_ID,
          chainName: robinhoodTestnet.name,
          nativeCurrency: robinhoodTestnet.nativeCurrency,
          rpcUrls: [...robinhoodTestnet.rpcUrls.default.http],
          blockExplorerUrls: [robinhoodTestnet.blockExplorers.default.url],
        }],
      });
    }
  }, [eth]);

  const walletClient = useMemo(
    () => (eth && address ? createWalletClient({ account: address, chain: robinhoodTestnet, transport: custom(eth) }) : null),
    [eth, address],
  );

  return {
    hasWallet: Boolean(eth),
    address,
    chainId,
    onRobinhood: chainId === ROBINHOOD_TESTNET_ID,
    walletClient,
    connect,
    switchToRobinhood,
    error,
  };
}
