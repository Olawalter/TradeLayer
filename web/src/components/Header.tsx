"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { useWallet } from "@/lib/wallet";
import { short } from "@/lib/format";
import { Wordmark } from "./Mark";
import { ConnectDialog } from "./ConnectDialog";

const NAV = [
  { href: "/register", label: "Register" },
  { href: "/create", label: "Create trade" },
  { href: "/protocol", label: "Protocol" },
];

export function Header() {
  const { phase, address, walletName, switchNetwork, disconnect } = useWallet();
  const [dialog, setDialog] = useState(false);
  const pathname = usePathname();

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-rule bg-ink/95 backdrop-blur">
        <div className="flex h-14 items-center gap-6 px-6 md:px-10">
          <Link href="/" className="shrink-0">
            <Wordmark />
          </Link>

          <nav className="hidden items-center gap-6 md:flex">
            {NAV.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`label transition-colors hover:text-paper ${
                    active ? "text-gold" : ""
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            {phase === "connected" && (
              <span className="hidden items-center gap-2 sm:flex">
                <span className="label">Network</span>
                <span className="stamp text-verified">
                  <span aria-hidden>✓</span> GenLayer
                </span>
              </span>
            )}

            {phase === "wrong-network" && (
              <button
                onClick={() => void switchNetwork()}
                className="stamp text-critical transition-colors hover:bg-[var(--critical-wash)]"
              >
                Wrong network — switch
              </button>
            )}

            {phase === "switching" && (
              <span className="stamp live text-gold">Switching network…</span>
            )}

            {phase === "connecting" && (
              <span className="stamp live text-gold">Connecting…</span>
            )}

            {(phase === "connected" || phase === "wrong-network") && address ? (
              <button
                onClick={disconnect}
                title={`${walletName ?? "Wallet"} — ${address}. Click to disconnect.`}
                className="group flex items-center gap-2 border border-rule px-3 py-[6px] transition-colors hover:border-rule-strong"
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    phase === "connected" ? "bg-verified" : "bg-critical"
                  }`}
                  aria-hidden
                />
                <span className="mono text-[12px] text-paper-dim group-hover:text-paper">
                  {short(address)}
                </span>
              </button>
            ) : phase === "disconnected" ? (
              <button
                onClick={() => setDialog(true)}
                className="stamp border-gold text-gold transition-colors hover:bg-[var(--gold-wash)]"
              >
                Connect wallet
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {dialog && <ConnectDialog onClose={() => setDialog(false)} />}
    </>
  );
}
