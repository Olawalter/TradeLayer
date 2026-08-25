"use client";

/**
 * Injected EIP-1193 wallet connection.
 *
 * Discovery is EIP-6963 first (every modern wallet announces itself, so the
 * user picks rather than the app guessing), with a `window.ethereum` fallback
 * for older injections. Nothing here is MetaMask-specific.
 *
 * THE CHAIN RECONCILIATION RULE: after `wallet_switchEthereumChain` resolves,
 * RE-READ `eth_chainId`. Several wallets resolve the switch before the change
 * has actually taken effect, so a write sent on the strength of the resolved
 * promise fails with "chainId should be same as current chainId" — an error
 * that points at the app and not at the wallet. This cost a production
 * outage in a sibling project; the fix is three lines and it is below.
 */

import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
} from "react";
import { CHAIN_ID, RPC_URL, EXPLORER } from "./contract";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
}

export interface WalletOption {
  uuid: string;
  name: string;
  icon?: string;
  provider: Eip1193Provider;
}

export type WalletPhase =
  | "disconnected" | "connecting" | "connected" | "wrong-network" | "switching";

interface WalletState {
  phase: WalletPhase;
  address: `0x${string}` | null;
  chainId: number | null;
  provider: Eip1193Provider | null;
  walletName: string | null;
  options: WalletOption[];
  error: string | null;
  connect: (option: WalletOption) => Promise<void>;
  disconnect: () => void;
  switchNetwork: () => Promise<boolean>;
  clearError: () => void;
}

const Ctx = createContext<WalletState | null>(null);

const HEX_CHAIN = `0x${CHAIN_ID.toString(16)}`;

/** EIP-6963 announcement, plus the legacy single injection. */
function useWalletOptions(): WalletOption[] {
  const [options, setOptions] = useState<WalletOption[]>([]);

  useEffect(() => {
    const found = new Map<string, WalletOption>();

    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent).detail as {
        info: { uuid: string; name: string; icon: string };
        provider: Eip1193Provider;
      };
      if (!detail?.info) return;
      found.set(detail.info.uuid, {
        uuid: detail.info.uuid,
        name: detail.info.name,
        icon: detail.info.icon,
        provider: detail.provider,
      });
      setOptions([...found.values()]);
    };

    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    // Fallback: an older injection that never announces itself.
    const timer = window.setTimeout(() => {
      const legacy = (window as { ethereum?: Eip1193Provider }).ethereum;
      if (legacy && found.size === 0) {
        found.set("injected", {
          uuid: "injected",
          name: "Injected wallet",
          provider: legacy,
        });
        setOptions([...found.values()]);
      }
    }, 350);

    return () => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      window.clearTimeout(timer);
    };
  }, []);

  return options;
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const options = useWalletOptions();
  const [provider, setProvider] = useState<Eip1193Provider | null>(null);
  const [walletName, setWalletName] = useState<string | null>(null);
  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [phase, setPhase] = useState<WalletPhase>("disconnected");
  const [error, setError] = useState<string | null>(null);

  const readChain = useCallback(async (p: Eip1193Provider) => {
    const hex = (await p.request({ method: "eth_chainId" })) as string;
    return parseInt(hex, 16);
  }, []);

  const connect = useCallback(
    async (option: WalletOption) => {
      setError(null);
      setPhase("connecting");
      try {
        const accounts = (await option.provider.request({
          method: "eth_requestAccounts",
        })) as string[];
        if (!accounts?.length) throw new Error("The wallet returned no accounts.");

        const id = await readChain(option.provider);
        setProvider(option.provider);
        setWalletName(option.name);
        setAddress(accounts[0] as `0x${string}`);
        setChainId(id);
        setPhase(id === CHAIN_ID ? "connected" : "wrong-network");
        window.localStorage.setItem("tradelayer.wallet", option.name);
      } catch (e) {
        const err = e as { code?: number; message?: string };
        setPhase("disconnected");
        setError(
          err.code === 4001
            ? "Connection rejected in the wallet."
            : err.message ?? "Could not connect."
        );
      }
    },
    [readChain]
  );

  const switchNetwork = useCallback(async (): Promise<boolean> => {
    if (!provider) return false;
    setError(null);
    setPhase("switching");
    try {
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: HEX_CHAIN }],
        });
      } catch (e) {
        // 4902: the chain is unknown to this wallet — offer to add it.
        if ((e as { code?: number }).code === 4902) {
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [{
              chainId: HEX_CHAIN,
              chainName: "GenLayer StudioNet",
              nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
              rpcUrls: [RPC_URL],
              blockExplorerUrls: [EXPLORER],
            }],
          });
        } else {
          throw e;
        }
      }

      // ── THE RULE ──────────────────────────────────────────────────────
      // Do not trust the resolved promise. Read the chain back, and give a
      // slow wallet a couple of chances to catch up before declaring failure.
      let id = await readChain(provider);
      for (let i = 0; i < 6 && id !== CHAIN_ID; i++) {
        await new Promise((r) => setTimeout(r, 250));
        id = await readChain(provider);
      }
      setChainId(id);
      const ok = id === CHAIN_ID;
      setPhase(ok ? "connected" : "wrong-network");
      if (!ok) {
        setError(
          "The wallet reports a different network than the one it just switched to. " +
          "Switch to GenLayer StudioNet manually, then try again."
        );
      }
      return ok;
    } catch (e) {
      const err = e as { code?: number; message?: string };
      setPhase("wrong-network");
      setError(
        err.code === 4001
          ? "Network switch rejected in the wallet."
          : err.message ?? "Could not switch network."
      );
      return false;
    }
  }, [provider, readChain]);

  const disconnect = useCallback(() => {
    setProvider(null);
    setWalletName(null);
    setAddress(null);
    setChainId(null);
    setPhase("disconnected");
    setError(null);
    window.localStorage.removeItem("tradelayer.wallet");
  }, []);

  // The wallet is the source of truth for account and chain; mirror it.
  useEffect(() => {
    if (!provider?.on) return;
    const onAccounts = (...args: never[]) => {
      const accounts = args[0] as unknown as string[];
      if (!accounts?.length) disconnect();
      else setAddress(accounts[0] as `0x${string}`);
    };
    const onChain = (...args: never[]) => {
      const hex = args[0] as unknown as string;
      const id = parseInt(hex, 16);
      setChainId(id);
      setPhase(id === CHAIN_ID ? "connected" : "wrong-network");
    };
    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, [provider, disconnect]);

  const value = useMemo<WalletState>(
    () => ({
      phase, address, chainId, provider, walletName, options, error,
      connect, disconnect, switchNetwork,
      clearError: () => setError(null),
    }),
    [phase, address, chainId, provider, walletName, options, error,
     connect, disconnect, switchNetwork]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}
