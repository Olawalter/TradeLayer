"use client";

import Link from "next/link";
import { useRead } from "@/lib/hooks";
import { gen } from "@/lib/format";
import type { ProtocolConfig, TradeList } from "@/lib/contract";
import { Mark } from "@/components/Mark";

export default function Landing() {
  const { data: config } = useRead<ProtocolConfig>("get_config", [], 60_000);
  const { data: list } = useRead<TradeList>("list_trades", [0, 50], 60_000);

  const items = list?.items ?? [];
  const escrow = items.reduce((s, t) => s + BigInt(t.deposited_amount || "0"), 0n);
  const settledVolume = items
    .filter((t) => t.status === "settled")
    .reduce((s, t) => s + BigInt(t.agreed_amount || "0"), 0n);

  return (
    <div>
      {/* ── hero ──────────────────────────────────────────────────────── */}
      <section className="px-6 pb-16 pt-20 md:px-10 md:pb-24 md:pt-28">
        <p className="label label-bracket mb-8">Cross-border trade escrow</p>

        <h1 className="display max-w-[16ch] text-[clamp(2.75rem,9vw,7.5rem)] text-paper">
          Trust infrastructure for{" "}
          <span className="display-italic text-gold">global trade.</span>
        </h1>

        <p className="mt-10 max-w-[62ch] text-[15px] leading-relaxed text-paper-dim">
          An importer in Lagos and a supplier in Shenzhen agree terms. The money sits
          in an Intelligent Contract. When they disagree, a GenLayer panel reads the
          frozen evidence and returns findings — and the contract settles using
          remedies <span className="text-paper">both parties agreed before the goods
          shipped</span>.
        </p>

        <p className="mt-4 max-w-[62ch] text-[15px] leading-relaxed text-paper-dim">
          The panel is never asked how to split the money. It cannot see a number,
          so it cannot move one.
        </p>

        <div className="mt-12 flex flex-wrap items-center gap-4">
          <Link
            href="/create"
            className="stamp border border-gold px-5 py-2.5 text-gold transition-colors hover:bg-[var(--gold-wash)]"
          >
            Create trade
          </Link>
          <Link
            href="/protocol"
            className="stamp border border-rule-strong px-5 py-2.5 text-paper-dim transition-colors hover:border-paper-dim hover:text-paper"
          >
            Explore protocol
          </Link>
          <Link href="/register" className="label ml-2 hover:text-paper">
            View the register →
          </Link>
        </div>
      </section>

      {/* ── the live record ───────────────────────────────────────────── */}
      <section className="grid grid-cols-2 border-t border-rule md:grid-cols-4">
        {[
          ["Trades opened", config ? String(config.trade_count) : "—"],
          ["Held in escrow", `${gen(escrow.toString(), 3)} GEN`],
          ["Settled volume", `${gen(settledVolume.toString(), 3)} GEN`],
          ["Adjudicable issues", config ? String(config.issues.length) : "—"],
        ].map(([k, v], i) => (
          <div
            key={k}
            className={`px-6 py-8 md:px-10 ${i % 2 === 1 ? "border-l border-rule" : ""} ${
              i >= 2 ? "border-t border-rule md:border-t-0" : ""
            } ${i === 2 ? "md:border-l" : ""} ${i === 3 ? "md:border-l" : ""}`}
          >
            <p className="label mb-3">{k}</p>
            <p className="mono text-[26px] leading-none text-paper">{v}</p>
          </div>
        ))}
      </section>

      {/* ── why this needs GenLayer ───────────────────────────────────── */}
      <section className="border-t border-rule px-6 py-16 md:px-10 md:py-24">
        <p className="label label-bracket mb-10">Why an ordinary chain cannot do this</p>

        <div className="grid gap-x-12 gap-y-10 md:grid-cols-3">
          {[
            {
              n: "01",
              h: "Read the record",
              b: "No EVM opcode fetches a URL. The contract retrieves the carrier record itself, from a host fixed in its own code, using a reference the seller bound at shipment — before anyone knew what would be contested.",
            },
            {
              n: "02",
              h: "Weigh the documents",
              b: "Whether a bill of lading contradicts an invoice is judgment, not arithmetic. An oracle can deliver a price. No oracle delivers that sentence.",
            },
            {
              n: "03",
              h: "Make it binding",
              b: "An off-chain call is one party's word. Validators execute the adjudication independently and must agree on every field the outcome depends on, or it does not stand.",
            },
          ].map((c) => (
            <div key={c.n}>
              <p className="mono mb-4 text-[11px] text-gold">{c.n}</p>
              <h3 className="display mb-3 text-[26px] text-paper">{c.h}</h3>
              <p className="text-[14px] leading-relaxed text-paper-dim">{c.b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── the evidence model, which is also the mark ────────────────── */}
      <section className="border-t border-rule px-6 py-16 md:px-10 md:py-24">
        <div className="flex flex-col gap-12 md:flex-row md:items-start md:gap-20">
          <div className="shrink-0">
            <Mark size={84} className="text-gold" />
          </div>
          <div className="max-w-[62ch]">
            <p className="label label-bracket mb-6">Evidence has provenance</p>
            <h2 className="display mb-6 text-[clamp(1.9rem,4vw,3rem)] text-paper">
              A claim does not become true{" "}
              <span className="display-italic text-gold">by being stored on a blockchain.</span>
            </h2>
            <p className="mb-8 text-[15px] leading-relaxed text-paper-dim">
              Writing to a chain proves somebody said a thing at a time. It does not
              make the thing true. So evidence carries a tier, and the tiers are not
              interchangeable.
            </p>

            <dl className="border-t border-rule">
              {[
                ["Authoritative", "Retrieved by the contract from a source it fixed. Independent proof.", "text-verified"],
                ["Supporting", "Filed by a party, anchored to a sha256. Corroboration.", "text-gold"],
                ["Party claim", "A statement. Establishes nothing on its own.", "text-paper-faint"],
              ].map(([k, v, tone]) => (
                <div key={k} className="flex flex-col gap-1 border-b border-rule py-4 sm:flex-row sm:gap-6">
                  <dt className={`stamp shrink-0 self-start ${tone}`}>{k}</dt>
                  <dd className="text-[14px] leading-relaxed text-paper-dim">{v}</dd>
                </div>
              ))}
            </dl>

            <p className="mt-6 text-[13px] leading-relaxed text-paper-faint">
              No party can write the authoritative tier. There is no parameter for it,
              and no caller for whom that branch is reachable.
            </p>
          </div>
        </div>
      </section>

      {/* ── close ─────────────────────────────────────────────────────── */}
      <section className="border-t border-rule px-6 py-20 md:px-10 md:py-28">
        <h2 className="display max-w-[20ch] text-[clamp(2rem,5vw,4rem)] text-paper">
          Agree the remedy before the goods ship.{" "}
          <span className="display-italic text-gold">Then nobody has to be trusted.</span>
        </h2>
        <Link
          href="/create"
          className="stamp mt-10 inline-block border border-gold px-5 py-2.5 text-gold transition-colors hover:bg-[var(--gold-wash)]"
        >
          Create trade
        </Link>
      </section>
    </div>
  );
}
