import type { Dispute, Trade } from "./contract";

/**
 * What each party may do right now, and — when they may not — WHY.
 *
 * Every rule below is a mirror of a guard in `contracts/tradelayer.py`. It is
 * UX ONLY. The contract is the authority: it re-checks all of this against its
 * own consensus clock, so a stale page or a skewed browser clock can produce a
 * button that looks live and a transaction that is correctly rejected. That is
 * the safe direction for the mistake to run, and the rejection is surfaced
 * verbatim rather than swallowed.
 *
 * The rule this file exists to honour: never hide an action the user might
 * expect. Show it with the reason it is unavailable, so the interface explains
 * the protocol instead of concealing it.
 */

export type Role = "buyer" | "seller" | "observer";

export type ActionId =
  | "accept" | "cancel" | "fund" | "ship" | "deliver"
  | "evidence" | "dispute" | "respond" | "begin" | "adjudicate"
  | "preview" | "appeal" | "finalize" | "close_undisputed"
  | "settle" | "recover";

export interface ActionSpec {
  id: ActionId;
  label: string;
  /** Who the contract lets call this. */
  who: string;
  /** One line on what it does, in the protocol's own terms. */
  blurb: string;
  /** True when this action belongs on screen at all for this status. */
  relevant: boolean;
  /** True when the connected wallet may actually send it now. */
  enabled: boolean;
  /** Why not, if not. Empty when enabled. */
  reason: string;
  tone?: "primary" | "critical";
}

const MIN_ADJUDICATION_TIME = 600;

export function actionsFor(
  trade: Trade | null,
  dispute: Dispute | null,
  role: Role,
  now: number,
  connected: boolean
): ActionSpec[] {
  if (!trade) return [];

  const s = trade.status;
  const isBuyer = role === "buyer";
  const isSeller = role === "seller";
  const isParty = isBuyer || isSeller;
  const n = (v: string | undefined) => Number(v ?? 0);
  const held = BigInt(trade.deposited_amount || "0");

  const gate = (
    ok: boolean,
    reason: string
  ): { enabled: boolean; reason: string } => {
    if (!connected) return { enabled: false, reason: "Connect a wallet to act." };
    if (!ok) return { enabled: false, reason };
    return { enabled: true, reason: "" };
  };

  const A: ActionSpec[] = [];
  const push = (
    id: ActionId, label: string, who: string, blurb: string,
    relevant: boolean, ok: boolean, reason: string,
    tone?: "primary" | "critical"
  ) => {
    const g = gate(ok, reason);
    A.push({ id, label, who, blurb, relevant, ...g, tone });
  };

  push("accept", "Accept trade", "Seller",
    "Accepts the terms and the remedy table as written. They cannot be changed afterwards.",
    s === "created", isSeller, isSeller ? "" : "Only the named seller may accept.", "primary");

  push("cancel", "Cancel", "Buyer or seller",
    "Only possible while nothing is deposited. Cancellation never moves value.",
    (s === "created" || s === "accepted") && held === 0n,
    isParty, isParty ? "" : "Only a party to this trade may cancel.");

  push("fund", "Fund escrow", "Buyer",
    "Sends the agreed amount into the contract. It must match exactly — over and under are both refused.",
    s === "accepted", isBuyer, isBuyer ? "" : "Only the buyer may fund.", "primary");

  push("ship", "Mark shipped", "Seller",
    "Binds the carrier reference. This happens BEFORE any dispute exists, which is what stops a party choosing their own evidence later.",
    s === "funded",
    isSeller && now <= n(trade.shipping_deadline),
    !isSeller ? "Only the seller may mark this shipped."
      : "The shipping deadline has passed.", "primary");

  const sellerMayDeliver =
    now >= n(trade.delivery_deadline) && now <= n(trade.recovery_deadline);
  push("deliver", "Record delivery", "Buyer any time; seller only from the delivery deadline",
    "Starts the dispute window and fixes every downstream deadline — which is why the seller cannot pick the moment.",
    s === "shipped",
    isBuyer || (isSeller && sellerMayDeliver),
    !isParty ? "Only a party to this trade may record delivery."
      : now < n(trade.delivery_deadline)
      ? "Before the agreed delivery deadline only the buyer may record delivery — the seller cannot self-certify it early."
      : "The buyer's recovery deadline has passed; the seller can no longer record delivery.",
    "primary");

  push("evidence", "File evidence", "Buyer or seller",
    "Adds a document or a statement to the package. Filing closes the moment a case opens.",
    ["funded", "shipped", "delivered", "disputed"].includes(s),
    isParty && n(trade.evidence_count) < 24,
    !isParty ? "Only a party to this trade may file evidence."
      : "This trade already holds the maximum number of evidence items.");

  push("dispute", "Open dispute", "Buyer",
    "Raises a claim inside the agreed window. The seller then has a response window before the case can open.",
    s === "delivered",
    isBuyer && now <= n(trade.dispute_deadline),
    !isBuyer ? "Only the buyer may open a dispute."
      : "The dispute window has closed — this trade settles to the seller.",
    "critical");

  const responded = n(dispute?.responded_at) > 0;
  push("respond", "Respond to dispute", "Seller",
    "The seller's answer. Adjudication can open once this is filed, or once the window closes without it.",
    s === "disputed" && !responded,
    isSeller && now <= n(trade.response_deadline),
    !isSeller ? "Only the seller may respond."
      : "The response window has closed.", "primary");

  push("begin", "Freeze evidence & open the case", "Anyone",
    "Records a digest over the evidence package and freezes it. Permissionless, so settlement never depends on a counterparty staying interested.",
    s === "disputed",
    (responded || now > n(trade.response_deadline)) && now <= n(trade.resolution_deadline),
    now > n(trade.resolution_deadline)
      ? "The resolution deadline has passed — this trade can only be recovered now."
      : "The seller may still respond. The case opens after their response, or once their window closes.",
    "primary");

  push("adjudicate", "Run adjudication", "Anyone",
    "Puts the frozen package to a GenLayer panel. Findings only — the payout is contract arithmetic over the agreed remedies.",
    s === "adjudicating",
    now <= n(trade.resolution_deadline),
    "The resolution deadline has passed — this trade can only be recovered now.",
    "primary");

  push("preview", "Probe the sources", "Anyone",
    "Runs the real retrieval and the real panel and RETURNS the result without touching state or any balance. A source that silently fails looks exactly like a feature that was never built.",
    !["created", "accepted", "cancelled"].includes(s), true, "");

  const appealsLeft = n(trade.max_appeals) - n(trade.appeal_count);
  push("appeal", "Appeal the verdict", "Buyer or seller",
    "Reopens adjudication on the SAME frozen package. An appeal buys a second reading, not a second chance to file evidence.",
    s === "verdict_proposed",
    isParty && appealsLeft > 0 && now <= n(trade.appeal_deadline)
      && now + MIN_ADJUDICATION_TIME <= n(trade.resolution_deadline),
    !isParty ? "Only a party to this trade may appeal."
      : appealsLeft <= 0 ? `This trade has used all ${trade.max_appeals} appeals.`
      : now > n(trade.appeal_deadline) ? "The appeal window has closed."
      : "There is not enough time left before the resolution deadline to hear an appeal.",
    "critical");

  push("finalize", "Finalize verdict", "Anyone",
    "Closes the appeal window and arms the settlement delay. Value still cannot move for another 300 seconds.",
    s === "verdict_proposed",
    now > n(trade.appeal_deadline),
    "The appeal window is still open.", "primary");

  push("close_undisputed", "Close undisputed", "Anyone",
    "Nobody disputed inside the window, so the trade settles to the seller. Permissionless.",
    s === "delivered",
    now > n(trade.dispute_deadline),
    "The dispute window is still open.", "primary");

  push("settle", "Settle", "Anyone",
    "Releases the escrow at the payout the findings produced. The ledger is zeroed before any value is emitted.",
    s === "finalized",
    now >= n(trade.settlement_unlock),
    "The settlement window is still arming.", "primary");

  const undisputedDelivered =
    s === "delivered" && !dispute?.exists && now > n(trade.dispute_deadline);
  push("recover", "Claim timeout refund", "Buyer",
    "The escape hatch, so funds cannot strand behind a trade that never resolved. It answers silence — it is not a way to win a decided case.",
    !["settled", "cancelled"].includes(s) && held > 0n,
    isBuyer && now > n(trade.recovery_deadline) && !undisputedDelivered,
    !isBuyer ? "Only the buyer may claim a timeout refund."
      : undisputedDelivered
      ? "This delivered trade was never disputed — it settles to the seller through Close undisputed, which anyone may call."
      : "The recovery deadline has not passed yet.",
    "critical");

  return A.filter((a) => a.relevant);
}

export function roleOf(trade: Trade | null, address?: string | null): Role {
  if (!trade || !address) return "observer";
  const me = address.toLowerCase();
  if (trade.buyer.toLowerCase() === me) return "buyer";
  if (trade.seller.toLowerCase() === me) return "seller";
  return "observer";
}
