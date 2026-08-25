"use client";

import { useRead } from "@/lib/hooks";
import { duration } from "@/lib/format";
import { CONTRACT_ADDRESS, EXPLORER, CHAIN_ID } from "@/lib/contract";
import type { ProtocolConfig } from "@/lib/contract";
import { Empty, Field, Note, Section } from "@/components/primitives";

/**
 * The rules of the venue, read from the contract itself.
 *
 * Anyone being asked to commit funds should be able to check the rules without
 * taking this interface's word for them — so every constant here is a live read
 * of `get_config`, not a number typed into the page.
 */
export default function Protocol() {
  const { data: c, error } = useRead<ProtocolConfig>("get_config", [], 60_000);

  return (
    <div>
      <div className="px-6 pb-8 pt-12 md:px-10">
        <p className="label label-bracket mb-4">The protocol</p>
        <h1 className="display max-w-[22ch] text-[clamp(2rem,5vw,3.5rem)] text-paper">
          The rules of the venue, read from the contract
        </h1>
        <p className="mt-6 max-w-[64ch] text-[15px] leading-relaxed text-paper-dim">
          Every value on this page is read live from the deployed contract. None of it is
          typed into the interface — if the deployment changed, this page would change with
          it.
        </p>
      </div>

      <div className="border-t border-rule px-6 py-6 md:px-10">
        <dl>
          <Field
            k="Contract"
            v={
              <a href={`${EXPLORER}/address/${CONTRACT_ADDRESS}`} target="_blank" rel="noreferrer noopener"
                 className="text-gold underline decoration-rule-strong underline-offset-4 hover:decoration-gold">
                {CONTRACT_ADDRESS}
              </a>
            }
            mono
          />
          <Field k="Network" v={`GenLayer StudioNet · chain ${CHAIN_ID}`} mono />
          <Field k="Trades opened" v={c ? String(c.trade_count) : "—"} mono />
        </dl>
      </div>

      {error && (
        <div className="px-6 pb-6 md:px-10">
          <Note tone="critical">Could not read the protocol config: {error}</Note>
        </div>
      )}

      <Section label="What the panel may decide">
        <Note tone="gold">
          The panel answers one bounded question per agreed issue and returns a finding.
          It is never asked how to split the money — the remedy for each breach was agreed
          by both parties before the goods shipped, and the contract does the arithmetic.
        </Note>
        <div className="mt-5 grid gap-8 md:grid-cols-2">
          <div>
            <p className="label mb-3">Adjudicable issues</p>
            {c ? (
              <ul className="flex flex-col gap-1.5">
                {c.issues.map((i) => (
                  <li key={i} className="stamp border-0 px-0 text-paper-dim">{i.replace(/_/g, " ")}</li>
                ))}
              </ul>
            ) : <Empty>Reading…</Empty>}
          </div>
          <div>
            <p className="label mb-3">Possible findings</p>
            {c ? (
              <dl className="flex flex-col gap-3">
                {[
                  ["CONFORMING", "The evidence establishes the term was met."],
                  ["BREACH", "The evidence establishes a breach."],
                  ["INSUFFICIENT", "The evidence establishes neither. The claimant carries the burden of proof, so this moves no money."],
                ].filter(([k]) => c.findings.includes(k as never)).map(([k, v]) => (
                  <div key={k}>
                    <dt className="stamp border-0 px-0 text-paper">{k}</dt>
                    <dd className="text-[13px] leading-relaxed text-paper-dim">{v}</dd>
                  </div>
                ))}
              </dl>
            ) : <Empty>Reading…</Empty>}
          </div>
        </div>
      </Section>

      <Section label="Evidence tiers">
        <div className="overflow-x-auto">
          <table>
            <thead>
              <tr className="border-b border-rule-strong">
                {["Tier", "Written by", "What it establishes"].map((h) => (
                  <th key={h} className="label px-3 py-2 text-left first:pl-0">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                ["AUTHORITATIVE", "The contract only, from a source it fetched itself", "Independent proof", "text-verified"],
                ["SUPPORTING", "A party, with a sha256 and a storage reference", "Corroboration", "text-gold"],
                ["PARTY_CLAIM", "A party, free text", "Nothing on its own", "text-paper-faint"],
              ].map(([tier, who, what, tone]) => (
                <tr key={tier} className="border-b border-rule">
                  <td className="py-3 pr-3"><span className={`stamp ${tone}`}>{tier.replace(/_/g, " ")}</span></td>
                  <td className="px-3 py-3 text-[13px] text-paper-dim">{who}</td>
                  <td className="px-3 py-3 text-[13px] text-paper-dim">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-4 max-w-[70ch] text-[13px] leading-relaxed text-paper-faint">
          No party can write the authoritative tier — `submit_evidence` refuses it outright,
          and there is no caller for whom that branch is reachable. A statement can only ever
          be a party claim, whatever hash is attached to it: hashing a sentence you wrote
          yourself anchors your own sentence.
        </p>
      </Section>

      <Section label="Windows and limits">
        {c ? (
          <div className="grid gap-x-10 md:grid-cols-2">
            <dl>
              <Field k="Settlement delay" v={duration(c.settlement_delay)} mono
                title="Gap between finalization and any payout." />
              <Field k="Seller response window" v={duration(c.response_window)} mono />
              <Field k="Recovery grace" v={duration(c.recovery_grace)} mono
                title="After the resolution deadline, before the buyer can recover." />
              <Field k="Shortest usable window" v={duration(c.min_window)} mono />
            </dl>
            <dl>
              <Field k="Longest window" v={duration(c.max_window)} mono />
              <Field k="Appeals per trade" v={String(c.max_appeals)} mono />
              <Field k="Evidence items per trade" v={String(c.max_evidence_per_trade)} mono />
              <Field k="Basis-point denominator" v={String(c.bps_denominator)} mono />
            </dl>
          </div>
        ) : <Empty>Reading…</Empty>}
      </Section>

      <Section label="Bound carrier sources">
        {c ? (
          <>
            <ul className="flex flex-wrap gap-2">
              {c.carriers.map((x) => <li key={x} className="stamp text-paper-dim">{x}</li>)}
            </ul>
            <p className="mt-4 max-w-[70ch] text-[13px] leading-relaxed text-paper-faint">
              The HOST is a contract constant and the REFERENCE is bound at shipment, before
              any dispute exists. So a disputing party can neither choose where the contract
              looks nor change what it looks for. That ordering is the whole guarantee —
              swapping this list for real carrier endpoints changes the data source, not the
              trust argument.
            </p>
          </>
        ) : <Empty>Reading…</Empty>}
      </Section>

      <Section label="What this does not do">
        <ul className="flex max-w-[74ch] flex-col gap-4 text-[13px] leading-relaxed text-paper-dim">
          <li>
            <span className="text-paper">The settlement delay is an armed window, not a
            finality read.</span> The contract cannot ask the chain whether it is final. It
            separates the verdict from the payout and refuses to settle for{" "}
            {c ? duration(c.settlement_delay) : "a set period"} afterwards. That is real
            protection, and it is not the same thing.
          </li>
          <li>
            <span className="text-paper">A document hash is anchored, never verified.</span>{" "}
            The contract records a sha256; it cannot fetch the file to confirm the bytes. It
            proves which document was filed, not that the file says what its description says.
          </li>
          <li>
            <span className="text-paper">The panel’s judgment is constrained, not
            eliminated.</span> It cannot pick a payout, invent an issue, or answer partially.
            But a confidently wrong reading of genuinely retrieved evidence still maps to a
            real remedy.
          </li>
          <li>
            <span className="text-paper">A source outage moves cases toward INSUFFICIENT</span>,
            which favours the seller. That is the correct failure — the buyer carries the
            burden of proof — but infrastructure availability does shape outcomes.
          </li>
        </ul>
      </Section>
    </div>
  );
}
