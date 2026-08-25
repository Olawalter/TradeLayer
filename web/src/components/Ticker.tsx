"use client";

import { useRead } from "@/lib/hooks";
import { gen } from "@/lib/format";
import { CONTRACT_ADDRESS } from "@/lib/contract";
import type { ProtocolConfig, TradeList } from "@/lib/contract";

/**
 * The spine: a thin ticker of protocol facts, every one of them read from the
 * contract. There are no fabricated validator counts and no invented volume —
 * if a number is not on chain it is not here.
 */
export function Ticker() {
  const { data: config } = useRead<ProtocolConfig>("get_config", [], 60_000);
  const { data: list } = useRead<TradeList>("list_trades", [0, 50], 60_000);

  const items = list?.items ?? [];
  const escrow = items.reduce((sum, t) => sum + BigInt(t.deposited_amount || "0"), 0n);
  const disputed = items.filter((t) =>
    ["disputed", "adjudicating", "verdict_proposed"].includes(t.status)
  ).length;
  const settled = items.filter((t) => t.status === "settled").length;

  const facts: [string, string][] = [
    ["Trades", config ? String(config.trade_count) : "—"],
    ["In escrow", `${gen(escrow.toString())} GEN`],
    ["Under dispute", String(disputed)],
    ["Settled", String(settled)],
    ["Settlement delay", config ? `${config.settlement_delay}s` : "—"],
    ["Seller response window", config ? `${config.response_window / 86400}d` : "—"],
    ["Appeals", config ? `max ${config.max_appeals}` : "—"],
    ["Adjudicable issues", config ? String(config.issues.length) : "—"],
    ["Contract", `${CONTRACT_ADDRESS.slice(0, 10)}…${CONTRACT_ADDRESS.slice(-6)}`],
  ];

  const strip = (
    <span className="inline-flex shrink-0">
      {facts.map(([k, v]) => (
        <span key={k} className="inline-flex items-baseline gap-2 whitespace-nowrap px-6">
          <span className="label">{k}</span>
          <span className="mono text-[11px] text-paper-dim">{v}</span>
          <span className="text-rule-strong" aria-hidden>·</span>
        </span>
      ))}
    </span>
  );

  return (
    <div className="overflow-hidden border-b border-rule bg-ink-lift py-[7px]">
      <div className="ticker-track">
        {strip}
        <span aria-hidden>{strip}</span>
      </div>
    </div>
  );
}
