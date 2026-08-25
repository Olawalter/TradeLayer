"use client";

import { LIFECYCLE, STATUS_COPY, type Trade, type TradeStatus } from "@/lib/contract";
import { until, utc } from "@/lib/format";

/**
 * The lifecycle spine.
 *
 * A stage is only marked reached when contract state says so — this never
 * infers progress from a transaction the user just sent. Deadlines shown here
 * are the contract's own absolute timestamps; the countdown next to them is
 * computed from the BROWSER clock and is decoration. The contract enforces
 * every window against its own consensus clock, so a wrong countdown cannot
 * let anyone act outside a window.
 */

const DEADLINE_FOR: Partial<Record<TradeStatus, [keyof Trade, string]>> = {
  shipped: ["delivery_deadline", "Delivery due"],
  delivered: ["dispute_deadline", "Dispute window closes"],
  disputed: ["response_deadline", "Seller response due"],
  adjudicating: ["resolution_deadline", "Resolution deadline"],
  verdict_proposed: ["appeal_deadline", "Appeal window closes"],
  finalized: ["settlement_unlock", "Settlement unlocks"],
};

export function Lifecycle({ trade, now }: { trade: Trade; now: number }) {
  if (trade.status === "cancelled") {
    return (
      <div className="border-l-2 border-rule-strong bg-ink-lift px-4 py-3">
        <p className="stamp mb-1 text-paper-faint">Cancelled</p>
        <p className="text-[13px] text-paper-dim">
          Cancelled before anything was deposited. No value ever entered the contract.
        </p>
      </div>
    );
  }

  const index = LIFECYCLE.indexOf(trade.status);
  // A trade that settled without a dispute never passes through the dispute
  // stages, so those are marked skipped rather than pending — showing them as
  // "not yet reached" on a settled trade would be a lie.
  const skippedDispute =
    ["finalized", "settled"].includes(trade.status) &&
    trade.reason_code === "NO_DISPUTE_RAISED";

  return (
    <ol className="flex flex-col">
      {LIFECYCLE.map((stage, i) => {
        const isDisputeStage = ["disputed", "adjudicating", "verdict_proposed"].includes(stage);
        const skipped = skippedDispute && isDisputeStage;
        const reached = !skipped && index >= i;
        const current = trade.status === stage;
        const deadline = DEADLINE_FOR[stage];
        const epoch = deadline ? (trade[deadline[0]] as string) : null;

        return (
          <li key={stage} className="flex gap-4">
            {/* rail */}
            <div className="flex w-3 shrink-0 flex-col items-center">
              <span
                className={`mt-[7px] h-[7px] w-[7px] shrink-0 ${
                  current
                    ? "bg-gold"
                    : reached
                    ? "bg-paper-dim"
                    : "border border-rule-strong"
                }`}
                aria-hidden
              />
              {i < LIFECYCLE.length - 1 && (
                <span
                  className={`w-px flex-1 ${reached ? "bg-rule-strong" : "bg-rule"}`}
                  aria-hidden
                />
              )}
            </div>

            <div className={`min-w-0 flex-1 pb-4 ${i === LIFECYCLE.length - 1 ? "pb-0" : ""}`}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span
                  className={`stamp border-0 px-0 ${
                    current
                      ? "text-gold"
                      : skipped
                      ? "text-paper-faint/50 line-through"
                      : reached
                      ? "text-paper"
                      : "text-paper-faint/50"
                  }`}
                >
                  {stage.replace(/_/g, " ")}
                </span>
                {current && (
                  <span className="text-[12px] text-paper-dim">{STATUS_COPY[stage]}</span>
                )}
                {skipped && (
                  <span className="text-[12px] text-paper-faint">
                    not reached — nobody disputed
                  </span>
                )}
              </div>

              {current && deadline && epoch && epoch !== "0" && (
                <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-[12px]">
                  <span className="label">{deadline[1]}</span>
                  <span className="mono text-paper-dim">{utc(epoch)}</span>
                  <span
                    className={
                      Number(epoch) - now < 0 ? "text-critical" : "text-gold"
                    }
                  >
                    {until(epoch, now)}
                  </span>
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
