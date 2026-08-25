"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRead } from "@/lib/hooks";
import { useWallet } from "@/lib/wallet";
import { gen } from "@/lib/format";
import type { TradeList, TradeListItem, TradeStatus } from "@/lib/contract";
import { STATUS_COPY } from "@/lib/contract";
import { StatusStamp, DecisionStamp, Empty, Note } from "@/components/primitives";

type Filter = "all" | "mine" | "open" | "disputed" | "settled";

const FILTERS: [Filter, string][] = [
  ["all", "All"],
  ["mine", "Mine"],
  ["open", "Open"],
  ["disputed", "In dispute"],
  ["settled", "Settled"],
];

const DISPUTE_STATES: TradeStatus[] = ["disputed", "adjudicating", "verdict_proposed"];

export default function Register() {
  const { address } = useWallet();
  const { data, error, loading, refresh } = useRead<TradeList>("list_trades", [0, 50], 30_000);
  const [filter, setFilter] = useState<Filter>("all");

  const items = useMemo(() => data?.items ?? [], [data]);

  const shown = useMemo(() => {
    const me = address?.toLowerCase();
    switch (filter) {
      case "mine":
        return items.filter(
          (t) => t.buyer.toLowerCase() === me || t.seller.toLowerCase() === me
        );
      case "open":
        return items.filter(
          (t) => !["settled", "cancelled"].includes(t.status)
        );
      case "disputed":
        return items.filter((t) => DISPUTE_STATES.includes(t.status));
      case "settled":
        return items.filter((t) => t.status === "settled");
      default:
        return items;
    }
  }, [items, filter, address]);

  const escrow = items.reduce((s, t) => s + BigInt(t.deposited_amount || "0"), 0n);
  const settledVol = items
    .filter((t) => t.status === "settled")
    .reduce((s, t) => s + BigInt(t.agreed_amount || "0"), 0n);

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-6 px-6 pb-8 pt-12 md:px-10">
        <div>
          <p className="label label-bracket mb-4">The register</p>
          <h1 className="display text-[clamp(2rem,5vw,3.5rem)] text-paper">
            Every trade on this deployment
          </h1>
        </div>
        <Link
          href="/create"
          className="stamp border border-gold px-4 py-2 text-gold transition-colors hover:bg-[var(--gold-wash)]"
        >
          Create trade
        </Link>
      </div>

      {/* ── the totals, computed from contract state only ─────────────── */}
      <div className="grid grid-cols-2 border-y border-rule md:grid-cols-4">
        {[
          ["Trades", String(data?.total ?? "—")],
          ["Held in escrow", `${gen(escrow.toString(), 3)} GEN`],
          ["In dispute", String(items.filter((t) => DISPUTE_STATES.includes(t.status)).length)],
          ["Settled volume", `${gen(settledVol.toString(), 3)} GEN`],
        ].map(([k, v], i) => (
          <div key={k} className={`px-6 py-5 md:px-10 ${i > 0 ? "border-l border-rule" : ""} ${i === 2 ? "border-t border-rule md:border-t-0" : ""} ${i === 3 ? "border-t border-rule md:border-t-0" : ""}`}>
            <p className="label mb-2">{k}</p>
            <p className="mono text-[19px] leading-none text-paper">{v}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-rule px-6 py-3 md:px-10">
        {FILTERS.map(([key, copy]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            disabled={key === "mine" && !address}
            className={`stamp border transition-colors disabled:opacity-40 ${
              filter === key
                ? "border-gold text-gold"
                : "border-rule text-paper-faint hover:border-rule-strong hover:text-paper-dim"
            }`}
          >
            {copy}
          </button>
        ))}
        <button onClick={() => void refresh()} className="label ml-auto hover:text-paper">
          {loading ? "Reading…" : "Refresh"}
        </button>
      </div>

      <div className="px-6 py-8 md:px-10">
        {error && (
          <Note tone="critical">
            Could not read the register: {error}
          </Note>
        )}

        {!error && shown.length === 0 && (
          <Empty>
            {loading
              ? "Reading contract state…"
              : filter === "mine"
              ? "No trades where your connected address is the buyer or the seller."
              : "No trades match this filter."}
          </Empty>
        )}

        {shown.length > 0 && (
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr className="border-b border-rule-strong">
                  {["Trade", "Goods", "Destination", "Value", "In custody", "Status", "Decision"].map((h) => (
                    <th key={h} className="label whitespace-nowrap px-3 py-2 text-left first:pl-0 last:pr-0">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <Row key={t.id} t={t} me={address ?? undefined} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ t, me }: { t: TradeListItem; me?: string }) {
  const role =
    me && t.buyer.toLowerCase() === me.toLowerCase()
      ? "buyer"
      : me && t.seller.toLowerCase() === me.toLowerCase()
      ? "seller"
      : null;

  return (
    <tr className="group border-b border-rule transition-colors hover:bg-ink-lift">
      <td className="whitespace-nowrap py-3 pr-3">
        <Link href={`/trade/${t.id}`} className="mono text-[13px] text-gold hover:text-gold-bright">
          {t.id}
        </Link>
        {role && <span className="label ml-2 text-paper-faint">you · {role}</span>}
      </td>
      <td className="max-w-[280px] px-3 py-3">
        <Link href={`/trade/${t.id}`} className="block truncate text-[13px] text-paper-dim group-hover:text-paper">
          {t.product_description}
        </Link>
      </td>
      <td className="whitespace-nowrap px-3 py-3 text-[13px] text-paper-dim">{t.destination}</td>
      <td className="mono whitespace-nowrap px-3 py-3 text-right text-[13px] text-paper">
        {gen(t.agreed_amount)}
      </td>
      <td className="mono whitespace-nowrap px-3 py-3 text-right text-[13px]">
        <span className={BigInt(t.deposited_amount || "0") > 0n ? "text-gold" : "text-paper-faint"}>
          {gen(t.deposited_amount)}
        </span>
      </td>
      <td className="whitespace-nowrap px-3 py-3" title={STATUS_COPY[t.status]}>
        <StatusStamp status={t.status} />
      </td>
      <td className="whitespace-nowrap py-3 pl-3">
        <DecisionStamp decision={t.decision} />
      </td>
    </tr>
  );
}
