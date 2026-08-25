/**
 * The deployed contract, and the exact shapes its views return.
 *
 * Every type here was read off `contracts/tradelayer.py`, not invented. Where
 * the contract returns a wei quantity it returns a decimal STRING, because
 * JSON numbers cannot hold 10^18 without losing precision — so these stay
 * strings all the way to the formatter and are never parsed into a Number.
 */

export const CHAIN_ID = 61999;
export const RPC_URL =
  process.env.NEXT_PUBLIC_GENLAYER_RPC ?? "https://studio.genlayer.com/api";
export const CONTRACT_ADDRESS = (process.env.NEXT_PUBLIC_CONTRACT_ADDRESS ??
  "0xE9b6e3FC11EbbB1adA32219CEBF43c9d4a3113e5") as `0x${string}`;
export const EXPLORER = "https://explorer-studio.genlayer.com";

export const CHAIN = {
  id: CHAIN_ID,
  name: "GenLayer StudioNet",
  nativeCurrency: { name: "GEN", symbol: "GEN", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "GenLayer Studio", url: EXPLORER } },
} as const;

/* ── lifecycle ──────────────────────────────────────────────────────────── */

export type TradeStatus =
  | "created" | "accepted" | "funded" | "shipped" | "delivered"
  | "disputed" | "adjudicating" | "verdict_proposed" | "finalized"
  | "settled" | "cancelled";

export type Decision = "" | "SELLER_WIN" | "BUYER_WIN" | "PARTIAL_SETTLEMENT";
export type FindingResult = "CONFORMING" | "BREACH" | "INSUFFICIENT";
export type Tier = "AUTHORITATIVE" | "SUPPORTING" | "PARTY_CLAIM";

/** Ordered for the lifecycle spine. `cancelled` is off-spine by design. */
export const LIFECYCLE: TradeStatus[] = [
  "created", "accepted", "funded", "shipped", "delivered",
  "disputed", "adjudicating", "verdict_proposed", "finalized", "settled",
];

export const STATUS_COPY: Record<TradeStatus, string> = {
  created: "Awaiting the seller",
  accepted: "Awaiting escrow",
  funded: "Escrow held — awaiting shipment",
  shipped: "In transit",
  delivered: "Dispute window open",
  disputed: "Dispute raised",
  adjudicating: "Evidence frozen — panel may run",
  verdict_proposed: "Verdict proposed — appeal window open",
  finalized: "Finalized — settlement arming",
  settled: "Settled",
  cancelled: "Cancelled",
};

/* ── view shapes ────────────────────────────────────────────────────────── */

export interface Trade {
  id: string;
  buyer: string;
  seller: string;
  product_description: string;
  product_identifier: string;
  quantity: number;
  agreed_amount: string;
  deposited_amount: string;
  quality_requirements: string;
  destination: string;
  carrier: string;
  carrier_reference: string;
  shipping_deadline: string;
  delivery_deadline: string;
  shipped_at: string;
  delivered_at: string;
  dispute_window: string;
  resolution_window: string;
  appeal_window: string;
  dispute_deadline: string;
  response_deadline: string;
  resolution_deadline: string;
  appeal_deadline: string;
  recovery_deadline: string;
  settlement_unlock: string;
  settlement_delay: string;
  inspection_required: boolean;
  status: TradeStatus;
  evidence_count: string;
  issue_count: string;
  appeal_count: string;
  max_appeals: string;
  adjudication_count: string;
  frozen_digest: string;
  decision: Decision;
  payout_bps: string;
  material_breach: boolean;
  reason_code: string;
  projected_buyer_amount: string;
  projected_seller_amount: string;
  buyer_paid: string;
  seller_paid: string;
  created_at: string;
  finalized_at: string;
}

export interface TradeListItem {
  id: string;
  buyer: string;
  seller: string;
  product_description: string;
  agreed_amount: string;
  deposited_amount: string;
  status: TradeStatus;
  decision: Decision;
  payout_bps: number;
  destination: string;
}

export interface TradeList {
  total: number;
  offset: number;
  count: number;
  items: TradeListItem[];
}

export interface AgreementTerm {
  issue: string;
  buyer_bps: number;
  requirement: string;
}

export interface AgreementTerms {
  trade_id: string;
  terms: AgreementTerm[];
  total_bps: number;
}

export interface EvidenceRow {
  id: string;
  type: string;
  tier: Tier;
  document_hash: string;
  storage_reference: string;
  description: string;
  submitted_by: string;
  submitted_at: string;
  source: string;
  verification_status: string;
  observed: string;
}

export interface EvidencePackage {
  trade_id: string;
  count: number;
  frozen: boolean;
  frozen_digest: string;
  rows: EvidenceRow[];
}

export interface Dispute {
  exists: boolean;
  trade_id: string;
  buyer_claim?: string;
  seller_response?: string;
  opened_at?: string;
  responded_at?: string;
  response_deadline?: string;
  resolution_deadline?: string;
  status?: TradeStatus;
}

export interface Finding {
  issue: string;
  result: FindingResult;
  rationale: string;
}

export interface Findings {
  trade_id: string;
  decision: Decision;
  payout_bps: number;
  material_breach: boolean;
  reason_code: string;
  adjudication_count: number;
  findings: Finding[];
}

export interface Settlement {
  trade_id: string;
  status: TradeStatus;
  settleable: boolean;
  reason: string;
  settlement_unlock: string;
  payout_bps: number;
  buyer_amount: string;
  seller_amount: string;
  buyer_paid: string;
  seller_paid: string;
}

export interface Passport {
  address: string;
  trades: number;
  completed: number;
  disputes_raised: number;
  lost_as_seller: number;
  lost_as_buyer: number;
  partials: number;
  volume_wei: string;
}

export interface ProtocolConfig {
  issues: string[];
  findings: FindingResult[];
  evidence_types: string[];
  tiers: Tier[];
  carriers: string[];
  bps_denominator: number;
  settlement_delay: number;
  response_window: number;
  recovery_grace: number;
  min_window: number;
  max_window: number;
  max_appeals: number;
  max_evidence_per_trade: number;
  min_trade_value_wei: string;
  trade_count: number;
}
