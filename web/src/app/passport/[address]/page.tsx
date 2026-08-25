"use client";

import Link from "next/link";
import { use } from "react";
import { useRead } from "@/lib/hooks";
import { useWallet } from "@/lib/wallet";
import { gen } from "@/lib/format";
import type { Passport, TradeList } from "@/lib/contract";
import { Empty, Field, Note, Section, StatusStamp, DecisionStamp } from "@/components/primitives";

export default function PassportPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = use(params);
  const { address: me } = useWallet();
  const { data, error } = useRead<Passport>("get_passport", [address], 60_000);
  const { data: list } = useRead<TradeList>("list_trades", [0, 50], 60_000);

  const mine = me?.toLowerCase() === address.toLowerCase();
  const theirs = (list?.items ?? []).filter(
    (t) =>
      t.buyer.toLowerCase() === address.toLowerCase() ||
      t.seller.toLowerCase() === address.toLowerCase()
  );

  return (
    <div>
      <div className="px-6 pb-8 pt-12 md:px-10">
        <p className="label label-bracket mb-4">Trade passport</p>
        <h1 className="display mb-3 break-all text-[clamp(1.4rem,3.5vw,2.4rem)] text-paper">
          <span className="mono text-[0.62em] text-paper-dim">{address}</span>
        </h1>
        {mine && <p className="label text-gold">This is your connected account</p>}
      </div>

      <div className="border-y border-rule px-6 py-6 md:px-10">
        <Note>
          A passport is <span className="text-paper">protocol history, not a rating</span>.
          Every counter below is derived from settled outcomes on this deployment, and there
          is deliberately no score: a number that compresses “lost two disputes” and “ran
          forty clean trades” into one figure would be inventing a judgement the protocol
          never made.
        </Note>
      </div>

      {error && (
        <div className="px-6 py-8 md:px-10">
          <Note tone="critical">Could not read this passport: {error}</Note>
        </div>
      )}

      <div className="grid grid-cols-2 border-b border-rule md:grid-cols-3 lg:grid-cols-6">
        {[
          ["Trades", data ? String(data.trades) : "—"],
          ["Completed", data ? String(data.completed) : "—"],
          ["Disputes raised", data ? String(data.disputes_raised) : "—"],
          ["Lost as seller", data ? String(data.lost_as_seller) : "—"],
          ["Lost as buyer", data ? String(data.lost_as_buyer) : "—"],
          ["Partials", data ? String(data.partials) : "—"],
        ].map(([k, v], i) => (
          <div key={k} className={`px-5 py-5 ${i % 2 === 1 ? "border-l border-rule" : ""} md:border-l md:first:border-l-0 ${i >= 2 ? "border-t border-rule md:border-t-0" : ""}`}>
            <p className="label mb-2">{k}</p>
            <p className="mono text-[19px] leading-none text-paper">{v}</p>
          </div>
        ))}
      </div>

      <Section label="Volume">
        <dl>
          <Field
            k="Settled volume"
            v={`${gen(data?.volume_wei)} GEN`}
            mono
            title="Summed across settled trades only."
          />
        </dl>
      </Section>

      <Section label="Trades involving this account">
        {theirs.length === 0 ? (
          <Empty>No trades on this deployment involve this address.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table>
              <thead>
                <tr className="border-b border-rule-strong">
                  {["Trade", "Role", "Goods", "Value", "Status", "Decision"].map((h) => (
                    <th key={h} className="label whitespace-nowrap px-3 py-2 text-left first:pl-0 last:pr-0">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {theirs.map((t) => (
                  <tr key={t.id} className="border-b border-rule hover:bg-ink-lift">
                    <td className="py-3 pr-3">
                      <Link href={`/trade/${t.id}`} className="mono text-[13px] text-gold hover:text-gold-bright">
                        {t.id}
                      </Link>
                    </td>
                    <td className="label px-3 py-3">
                      {t.buyer.toLowerCase() === address.toLowerCase() ? "Buyer" : "Seller"}
                    </td>
                    <td className="max-w-[280px] truncate px-3 py-3 text-[13px] text-paper-dim">
                      {t.product_description}
                    </td>
                    <td className="mono whitespace-nowrap px-3 py-3 text-right text-[13px] text-paper">
                      {gen(t.agreed_amount)}
                    </td>
                    <td className="px-3 py-3"><StatusStamp status={t.status} /></td>
                    <td className="py-3 pl-3"><DecisionStamp decision={t.decision} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
