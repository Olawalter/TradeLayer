"use client";

import Link from "next/link";
import { use } from "react";
import { useRead, useNow } from "@/lib/hooks";
import { useWallet } from "@/lib/wallet";
import { roleOf } from "@/lib/actions";
import { bps, gen, titleCase, until, utc } from "@/lib/format";
import type {
  AgreementTerms, Dispute, EvidencePackage, Findings, ProtocolConfig,
  Settlement, Trade,
} from "@/lib/contract";
import {
  AddressLink, DecisionStamp, Empty, Field, FindingStamp, Note, Section,
  StatusStamp, TierStamp,
} from "@/components/primitives";
import { Lifecycle } from "@/components/Lifecycle";
import { TradeActions } from "@/components/TradeActions";

export default function TradeRoom({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const now = useNow();
  const { address } = useWallet();

  const trade = useRead<Trade>("get_trade", [id], 20_000);
  const terms = useRead<AgreementTerms>("get_agreement_terms", [id], 60_000);
  const evidence = useRead<EvidencePackage>("get_evidence", [id], 20_000);
  const dispute = useRead<Dispute>("get_dispute", [id], 20_000);
  const findings = useRead<Findings>("get_findings", [id], 20_000);
  const settlement = useRead<Settlement>("get_settlement", [id], 20_000);
  const config = useRead<ProtocolConfig>("get_config", [], 0);

  const t = trade.data;
  const role = roleOf(t, address);

  const refreshAll = () => {
    void trade.refresh(); void evidence.refresh(); void dispute.refresh();
    void findings.refresh(); void settlement.refresh(); void terms.refresh();
  };

  if (trade.error) {
    return (
      <div className="px-6 py-20 md:px-10">
        <p className="label label-bracket mb-4">Not found</p>
        <h1 className="display mb-6 text-[2.5rem] text-paper">No such trade</h1>
        <p className="mb-6 max-w-[60ch] text-[14px] text-paper-dim">
          The contract has no trade with id <span className="mono text-paper">{id}</span>.
        </p>
        <Link href="/register" className="stamp border border-rule-strong px-4 py-2 text-paper-dim hover:text-paper">
          Back to the register
        </Link>
      </div>
    );
  }

  if (!t) {
    return (
      <div className="px-6 py-20 md:px-10">
        <p className="label live">Reading contract state…</p>
      </div>
    );
  }

  return (
    <div>
      {/* ── header ────────────────────────────────────────────────────── */}
      <div className="px-6 pb-6 pt-10 md:px-10">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <Link href="/register" className="label hover:text-paper">← Register</Link>
          <span className="mono text-[13px] text-gold">{t.id}</span>
          <StatusStamp status={t.status} />
          {t.decision && <DecisionStamp decision={t.decision} />}
          {role !== "observer" && (
            <span className="label text-gold">You are the {role}</span>
          )}
        </div>

        <h1 className="display max-w-[24ch] text-[clamp(1.8rem,4.5vw,3.2rem)] text-paper">
          {t.product_description}
        </h1>

        <div className="mt-6 flex flex-wrap items-baseline gap-x-10 gap-y-3">
          <Amount k="Trade value" v={`${gen(t.agreed_amount)} GEN`} note="a TERM of the agreement" />
          <Amount
            k="Held in escrow"
            v={`${gen(t.deposited_amount)} GEN`}
            note="what the contract ACTUALLY holds"
            tone={BigInt(t.deposited_amount) > 0n ? "gold" : undefined}
          />
          {t.status === "settled" && (
            <>
              <Amount k="Paid to buyer" v={`${gen(t.buyer_paid)} GEN`} />
              <Amount k="Paid to seller" v={`${gen(t.seller_paid)} GEN`} />
            </>
          )}
        </div>
      </div>

      <div className="grid gap-0 border-t border-rule lg:grid-cols-[minmax(0,1fr)_380px]">
        {/* ── left: the case file ─────────────────────────────────────── */}
        <div className="lg:border-r lg:border-rule">
          <Section label="Agreement">
            <dl>
              <Field k="Buyer" v={<AddressLink address={t.buyer} />} />
              <Field k="Seller" v={<AddressLink address={t.seller} />} />
              <Field k="Product identifier" v={t.product_identifier} mono />
              <Field k="Quantity" v={t.quantity.toLocaleString()} mono />
              <Field k="Quality requirement" v={t.quality_requirements} />
              <Field k="Destination" v={t.destination} />
              <Field
                k="Carrier"
                v={
                  <>
                    {t.carrier}
                    {t.carrier_reference ? (
                      <>
                        {" · "}
                        <span className="mono text-gold">{t.carrier_reference}</span>
                        <span className="ml-2 text-[12px] text-paper-faint">
                          bound at shipment, before any dispute existed
                        </span>
                      </>
                    ) : (
                      <span className="ml-2 text-[12px] text-paper-faint">
                        reference is bound when the seller marks the trade shipped
                      </span>
                    )}
                  </>
                }
              />
              <Field k="Inspection required" v={t.inspection_required ? "Yes" : "No"} />
              <Field k="Shipping deadline" v={utc(t.shipping_deadline)} mono />
              <Field k="Delivery deadline" v={utc(t.delivery_deadline)} mono />
            </dl>
          </Section>

          {/* ── the remedy table ─────────────────────────────────────── */}
          <Section label="Agreed remedies">
            <Note tone="gold">
              Both parties agreed this table <span className="text-paper">before the goods
              shipped</span>, and it cannot be changed. When the panel finds a breach, the
              contract adds up the agreed remedies for the breached issues. This is why the
              panel never picks a number — and why it cannot.
            </Note>

            {terms.data && terms.data.terms.length > 0 ? (
              <div className="mt-4 overflow-x-auto">
                <table>
                  <thead>
                    <tr className="border-b border-rule-strong">
                      {["Issue", "Requirement", "Remedy to buyer"].map((h) => (
                        <th key={h} className="label px-3 py-2 text-left first:pl-0 last:pr-0 last:text-right">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {terms.data.terms.map((term) => {
                      const finding = findings.data?.findings.find((f) => f.issue === term.issue);
                      return (
                        <tr key={term.issue} className="border-b border-rule align-top">
                          <td className="py-3 pr-3">
                            <span className="stamp border-0 px-0 text-paper">
                              {term.issue.replace(/_/g, " ")}
                            </span>
                            {finding && (
                              <div className="mt-1.5"><FindingStamp result={finding.result} /></div>
                            )}
                          </td>
                          <td className="px-3 py-3 text-[13px] leading-relaxed text-paper-dim">
                            {term.requirement}
                            {finding?.rationale && (
                              <p className="mt-1.5 border-l border-rule pl-3 text-[12px] text-paper-faint">
                                {finding.rationale}
                              </p>
                            )}
                          </td>
                          <td className="mono whitespace-nowrap py-3 pl-3 text-right text-[13px] text-gold">
                            {bps(term.buyer_bps)}
                          </td>
                        </tr>
                      );
                    })}
                    <tr>
                      <td colSpan={2} className="label py-3 pr-3 text-right">Total agreed</td>
                      <td className="mono py-3 pl-3 text-right text-[13px] text-paper">
                        {bps(terms.data.total_bps)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty>Reading the agreed terms…</Empty>
            )}
          </Section>

          {/* ── evidence room ────────────────────────────────────────── */}
          <Section
            label="Evidence room"
            action={
              evidence.data?.frozen ? (
                <span className="stamp text-gold" title={`Digest ${evidence.data.frozen_digest}`}>
                  Frozen
                </span>
              ) : (
                <span className="label">Open for filing</span>
              )
            }
          >
            {evidence.data?.frozen && (
              <Note tone="gold">
                The package is frozen. An ordered digest was recorded when the case opened,
                and adjudication refuses to run if the package no longer matches it.
                <span className="mono mt-2 block break-all text-[11px] text-paper-faint">
                  {evidence.data.frozen_digest}
                </span>
              </Note>
            )}

            {!evidence.data || evidence.data.rows.length === 0 ? (
              <Empty>Nothing has been filed against this trade yet.</Empty>
            ) : (
              <ul className="mt-4 flex flex-col">
                {evidence.data.rows.map((row) => (
                  <li key={row.id} className="border-t border-rule py-4 first:border-t-0 first:pt-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <TierStamp tier={row.tier} />
                      <span className="stamp border-0 px-0 text-paper-dim">
                        {titleCase(row.type)}
                      </span>
                      <span className="mono ml-auto text-[11px] text-paper-faint">{row.id}</span>
                    </div>
                    {row.description && (
                      <p className="mb-2 text-[13px] leading-relaxed text-paper">{row.description}</p>
                    )}
                    <dl className="grid gap-x-6 text-[12px] sm:grid-cols-2">
                      <Meta k="Filed by" v={<AddressLink address={row.submitted_by} />} />
                      <Meta k="Filed at" v={<span className="mono">{utc(row.submitted_at)}</span>} />
                      {row.document_hash && (
                        <Meta k="sha256" v={<span className="mono break-all">{row.document_hash}</span>} />
                      )}
                      {row.storage_reference && (
                        <Meta k="Stored at" v={<span className="mono break-all">{row.storage_reference}</span>} />
                      )}
                    </dl>
                    {row.tier === "SUPPORTING" && (
                      <p className="mt-2 text-[12px] text-paper-faint">
                        The digest proves WHICH document was filed. The contract cannot fetch
                        it to confirm the bytes — that is anchoring, not verification.
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* ── dispute ──────────────────────────────────────────────── */}
          {dispute.data?.exists && (
            <Section label="Dispute case">
              <div className="grid gap-6 md:grid-cols-2">
                <div>
                  <p className="label mb-2">Buyer’s claim</p>
                  <p className="border-l-2 border-critical bg-ink-lift px-4 py-3 text-[13px] leading-relaxed text-paper">
                    {dispute.data.buyer_claim}
                  </p>
                  <p className="mt-2 text-[12px] text-paper-faint">
                    Opened {utc(dispute.data.opened_at)}
                  </p>
                </div>
                <div>
                  <p className="label mb-2">Seller’s response</p>
                  {Number(dispute.data.responded_at ?? 0) > 0 ? (
                    <>
                      <p className="border-l-2 border-rule-strong bg-ink-lift px-4 py-3 text-[13px] leading-relaxed text-paper">
                        {dispute.data.seller_response}
                      </p>
                      <p className="mt-2 text-[12px] text-paper-faint">
                        Filed {utc(dispute.data.responded_at)}
                      </p>
                    </>
                  ) : (
                    <div className="border border-dashed border-rule px-4 py-6">
                      <p className="text-[13px] text-paper-faint">
                        No response yet. Due {utc(t.response_deadline)} ({until(t.response_deadline, now)}).
                      </p>
                      <p className="mt-2 text-[12px] text-paper-faint">
                        The case can open without it once the window closes — a silent seller
                        cannot stall the trade indefinitely.
                      </p>
                    </div>
                  )}
                </div>
              </div>
              <p className="mt-5 text-[12px] leading-relaxed text-paper-faint">
                Both statements are advocacy. The panel is told so in as many words, and the
                buyer carries the burden of proof.
              </p>
            </Section>
          )}

          {/* ── adjudication ─────────────────────────────────────────── */}
          {findings.data && findings.data.findings.length > 0 && (
            <Section label="GenLayer adjudication">
              <dl className="mb-5">
                <Field k="Decision" v={<DecisionStamp decision={findings.data.decision} />} />
                <Field
                  k="Buyer’s share"
                  v={<span className="text-gold">{bps(findings.data.payout_bps)}</span>}
                  mono
                  title="Derived by the contract from the agreed remedies. The panel never supplies this."
                />
                <Field k="Material breach" v={findings.data.material_breach ? "Yes" : "No"} />
                <Field k="Reason code" v={findings.data.reason_code || "—"} mono />
                <Field
                  k="Rounds run"
                  v={`${findings.data.adjudication_count} of ${Number(t.max_appeals) + 1} · ${t.appeal_count} appeal(s) used`}
                  mono
                />
              </dl>

              <Note>
                Every agreed issue has a finding — a verdict missing one is rejected outright
                rather than treated as a discount. Findings for issues nobody agreed are
                discarded, so the panel cannot invent a remedy.
              </Note>
            </Section>
          )}

          {/* ── settlement ───────────────────────────────────────────── */}
          {settlement.data && (
            <Section label="Settlement">
              <dl>
                <Field
                  k="Settleable"
                  v={
                    settlement.data.settleable ? (
                      <span className="text-verified">Yes</span>
                    ) : (
                      <span className="text-paper-dim">
                        No — {settlement.data.reason || "not yet"}
                      </span>
                    )
                  }
                />
                {Number(settlement.data.settlement_unlock) > 0 && (
                  <Field
                    k="Settlement unlocks"
                    v={`${utc(settlement.data.settlement_unlock)} (${until(settlement.data.settlement_unlock, now)})`}
                    mono
                  />
                )}
                <Field k="Buyer’s share" v={bps(settlement.data.payout_bps)} mono />
                <Field
                  k={t.status === "settled" ? "Paid to buyer" : "Projected to buyer"}
                  v={`${gen(t.status === "settled" ? settlement.data.buyer_paid : settlement.data.buyer_amount)} GEN`}
                  mono
                />
                <Field
                  k={t.status === "settled" ? "Paid to seller" : "Projected to seller"}
                  v={`${gen(t.status === "settled" ? settlement.data.seller_paid : settlement.data.seller_amount)} GEN`}
                  mono
                />
              </dl>

              {t.status === "finalized" && (
                <Note tone="gold">
                  The verdict and the money are two transactions at two different times. The
                  settlement delay is an armed window, not a finality read — the contract
                  cannot ask the chain whether it is final, so it refuses to settle for 300
                  seconds after finalization and relies on GenLayer executing the outbound
                  value message only at finalization.
                </Note>
              )}
            </Section>
          )}
        </div>

        {/* ── right: spine + actions ──────────────────────────────────── */}
        <div className="border-t border-rule lg:border-t-0">
          <div className="sticky top-14">
            <Section label="Lifecycle">
              <Lifecycle trade={t} now={now} />
            </Section>

            <Section label="Actions">
              <TradeActions
                trade={t}
                dispute={dispute.data}
                config={config.data}
                role={role}
                now={now}
                onDone={refreshAll}
              />
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}

function Amount({
  k, v, note, tone,
}: {
  k: string; v: string; note?: string; tone?: "gold";
}) {
  return (
    <div>
      <p className="label mb-1.5">{k}</p>
      <p className={`mono text-[20px] leading-none ${tone === "gold" ? "text-gold" : "text-paper"}`}>
        {v}
      </p>
      {note && <p className="mt-1.5 text-[11px] text-paper-faint">{note}</p>}
    </div>
  );
}

function Meta({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-2 py-0.5">
      <dt className="label shrink-0">{k}</dt>
      <dd className="min-w-0 text-paper-dim">{v}</dd>
    </div>
  );
}
