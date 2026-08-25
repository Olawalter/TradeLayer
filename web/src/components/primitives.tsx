"use client";

import Link from "next/link";
import React from "react";
import { EXPLORER, type Decision, type FindingResult, type TradeStatus, type Tier } from "@/lib/contract";
import { STATUS_COPY } from "@/lib/contract";

/* ── the stamp ──────────────────────────────────────────────────────────── */

const STATUS_TONE: Record<TradeStatus, string> = {
  created: "text-paper-faint",
  accepted: "text-paper-dim",
  funded: "text-gold",
  shipped: "text-gold",
  delivered: "text-gold",
  disputed: "text-critical",
  adjudicating: "text-critical",
  verdict_proposed: "text-gold-bright",
  finalized: "text-verified",
  settled: "text-verified",
  cancelled: "text-paper-faint",
};

export function StatusStamp({ status, title }: { status: TradeStatus; title?: boolean }) {
  return (
    <span className={`stamp ${STATUS_TONE[status] ?? "text-paper-dim"}`}
          title={title === false ? undefined : STATUS_COPY[status]}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

const DECISION_TONE: Record<Exclude<Decision, "">, string> = {
  SELLER_WIN: "text-verified",
  BUYER_WIN: "text-gold-bright",
  PARTIAL_SETTLEMENT: "text-gold",
};

export function DecisionStamp({ decision }: { decision: Decision }) {
  if (!decision) return <span className="text-paper-faint">—</span>;
  return (
    <span className={`stamp ${DECISION_TONE[decision]}`}>
      {decision.replace(/_/g, " ")}
    </span>
  );
}

const FINDING_TONE: Record<FindingResult, string> = {
  CONFORMING: "text-verified",
  BREACH: "text-critical",
  INSUFFICIENT: "text-paper-dim",
};

export function FindingStamp({ result }: { result: FindingResult }) {
  return <span className={`stamp ${FINDING_TONE[result]}`}>{result}</span>;
}

const TIER_TONE: Record<Tier, string> = {
  AUTHORITATIVE: "text-verified",
  SUPPORTING: "text-gold",
  PARTY_CLAIM: "text-paper-faint",
};

export function TierStamp({ tier }: { tier: Tier }) {
  const explain: Record<Tier, string> = {
    AUTHORITATIVE: "Retrieved by the contract itself from a source bound before any dispute existed. Independent proof.",
    SUPPORTING: "Filed by a party and anchored to a sha256. Corroboration, not proof.",
    PARTY_CLAIM: "A statement by a party. Establishes nothing on its own.",
  };
  return (
    <span className={`stamp ${TIER_TONE[tier]}`} title={explain[tier]}>
      {tier.replace(/_/g, " ")}
    </span>
  );
}

/* ── layout ─────────────────────────────────────────────────────────────── */

export function Section({
  label, children, action,
}: {
  label: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="sheet px-6 py-6 md:px-10">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="label label-bracket">{label}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Field({
  k, v, mono = false, title,
}: {
  k: string;
  v: React.ReactNode;
  mono?: boolean;
  title?: string;
}) {
  return (
    <div className="flex flex-col gap-1 border-t border-rule py-2.5 first:border-t-0 sm:flex-row sm:items-baseline sm:gap-4">
      <dt className="label w-full shrink-0 sm:w-[190px]" title={title}>{k}</dt>
      <dd className={`min-w-0 break-words text-[13px] text-paper ${mono ? "mono" : ""}`}>{v}</dd>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="border border-dashed border-rule px-4 py-8 text-center text-[13px] text-paper-faint">
      {children}
    </p>
  );
}

export function Note({
  tone = "neutral", children,
}: {
  tone?: "neutral" | "gold" | "critical" | "verified";
  children: React.ReactNode;
}) {
  const border = {
    neutral: "border-rule", gold: "border-gold",
    critical: "border-critical", verified: "border-verified",
  }[tone];
  return (
    <div className={`border-l-2 ${border} bg-ink-lift px-4 py-3 text-[13px] leading-relaxed text-paper-dim`}>
      {children}
    </div>
  );
}

/* ── buttons ────────────────────────────────────────────────────────────── */

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "ghost" | "critical";
};

export function Button({ tone = "ghost", className = "", ...rest }: BtnProps) {
  const tones = {
    primary:
      "border-gold text-gold hover:bg-[var(--gold-wash)] disabled:border-rule disabled:text-paper-faint",
    ghost:
      "border-rule-strong text-paper-dim hover:border-paper-dim hover:text-paper disabled:text-paper-faint",
    critical:
      "border-critical text-critical hover:bg-[var(--critical-wash)] disabled:border-rule disabled:text-paper-faint",
  }[tone];
  return (
    <button
      {...rest}
      className={`stamp cursor-pointer border transition-colors disabled:cursor-not-allowed ${tones} ${className}`}
    />
  );
}

export function TxLink({ hash, children }: { hash: string; children?: React.ReactNode }) {
  return (
    <a
      href={`${EXPLORER}/tx/${hash}`}
      target="_blank"
      rel="noreferrer noopener"
      className="mono text-[12px] text-gold underline decoration-rule-strong underline-offset-4 hover:decoration-gold"
    >
      {children ?? `${hash.slice(0, 10)}…${hash.slice(-8)}`}
    </a>
  );
}

export function AddressLink({ address }: { address: string }) {
  return (
    <Link
      href={`/passport/${address}`}
      className="mono text-[12px] text-paper-dim underline decoration-rule-strong underline-offset-4 hover:text-paper hover:decoration-paper-dim"
      title={address}
    >
      {address.slice(0, 10)}…{address.slice(-6)}
    </Link>
  );
}
