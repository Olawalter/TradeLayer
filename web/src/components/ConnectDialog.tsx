"use client";

import { useEffect } from "react";
import { useWallet } from "@/lib/wallet";

/**
 * Wallet choice. The list comes from EIP-6963 announcements, so it shows what
 * is genuinely installed rather than a hardcoded roster of brands the user may
 * not have. Nothing here is MetaMask-specific.
 */
export function ConnectDialog({ onClose }: { onClose: () => void }) {
  const { options, connect, phase, error, clearError } = useWallet();

  useEffect(() => {
    if (phase === "connected" || phase === "wrong-network") onClose();
  }, [phase, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Connect wallet"
    >
      <div
        className="w-full max-w-[420px] border border-rule-strong bg-ink"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-rule px-5 py-3">
          <span className="label label-bracket">Connect wallet</span>
          <button onClick={onClose} className="label hover:text-paper" aria-label="Close">
            Esc
          </button>
        </div>

        <div className="p-5">
          <p className="mb-4 text-[13px] leading-relaxed text-paper-dim">
            TradeLayer never sees a private key or a seed phrase. Your wallet signs;
            the contract holds the escrow and decides every outcome.
          </p>

          {options.length === 0 ? (
            <div className="border border-rule px-4 py-6 text-center">
              <p className="text-[13px] text-paper-dim">
                No injected wallet detected.
              </p>
              <p className="mt-2 text-[12px] text-paper-faint">
                Install any EIP-1193 wallet — MetaMask, Rabby, Trust Wallet or another —
                then reload this page.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col">
              {options.map((option) => (
                <li key={option.uuid}>
                  <button
                    onClick={() => void connect(option)}
                    disabled={phase === "connecting"}
                    className="flex w-full items-center gap-3 border border-rule px-4 py-3 text-left transition-colors hover:border-gold hover:bg-[var(--gold-wash)] disabled:opacity-50 [&+*]:mt-2"
                  >
                    {option.icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={option.icon} alt="" width={22} height={22} className="shrink-0" />
                    ) : (
                      <span className="h-[22px] w-[22px] shrink-0 border border-rule-strong" aria-hidden />
                    )}
                    <span className="text-[14px]">{option.name}</span>
                    <span className="label ml-auto">
                      {phase === "connecting" ? "…" : "Connect"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {error && (
            <div className="mt-4 border border-critical px-4 py-3">
              <p className="label mb-1 text-critical">Not connected</p>
              <p className="text-[13px] text-paper-dim">{error}</p>
              <button onClick={clearError} className="label mt-2 hover:text-paper">
                Dismiss
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
