"use client";

import { useState } from "react";
import { useWallet } from "@/lib/wallet";
import { useTx } from "@/lib/useTx";
import { read, returnedJson } from "@/lib/genlayer";
import { actionsFor, type ActionId, type Role } from "@/lib/actions";
import { gen, titleCase } from "@/lib/format";
import type { Dispute, EvidencePackage, ProtocolConfig, Trade } from "@/lib/contract";
import { Button, Note } from "./primitives";
import { TxLifecycle, WalletGate } from "./TxLifecycle";
import { ConnectDialog } from "./ConnectDialog";

/** Evidence types that may never be filed as a document. */
const STATEMENT_ONLY = new Set(["statement"]);

export function TradeActions({
  trade, dispute, config, role, now, onDone,
}: {
  trade: Trade;
  dispute: Dispute | null;
  config: ProtocolConfig | null;
  role: Role;
  now: number;
  onDone: () => void;
}) {
  const { address, provider, phase, switchNetwork } = useWallet();
  const { state, send, reset } = useTx();
  const [open, setOpen] = useState<ActionId | null>(null);
  const [dialog, setDialog] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const connected = phase === "connected";
  const actions = actionsFor(trade, dispute, role, now, connected);

  // Form state
  const [carrierRef, setCarrierRef] = useState("");
  const [claim, setClaim] = useState("");
  const [response, setResponse] = useState("");
  const [evType, setEvType] = useState("inspection_report");
  const [evTier, setEvTier] = useState<"SUPPORTING" | "PARTY_CLAIM">("SUPPORTING");
  const [evHash, setEvHash] = useState("");
  const [evRef, setEvRef] = useState("");
  const [evDesc, setEvDesc] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const tid = trade.id;
  const t = () => read<Trade>("get_trade", [tid]);

  async function run(
    id: ActionId,
    label: string,
    functionName: string,
    args: unknown[],
    settled: () => Promise<boolean>,
    value = 0n,
    timeoutMs?: number
  ) {
    if (!address || !provider) return;
    setFormError(null);
    const ok = await send(address, provider, {
      label, functionName, args, value, settled, timeoutMs,
    });
    if (ok) {
      setOpen(null);
      setCarrierRef(""); setClaim(""); setResponse("");
      setEvHash(""); setEvRef(""); setEvDesc("");
      onDone();
    }
  }

  /** The probe returns its JSON on the receipt; it changes nothing. */
  async function runPreview() {
    if (!address || !provider) return;
    setPreview(null);
    setFormError(null);
    const { writeClient } = await import("@/lib/genlayer");
    const { CONTRACT_ADDRESS } = await import("@/lib/contract");
    const { TransactionStatus } = await import("genlayer-js/types");
    try {
      const client = writeClient(address, provider);
      const hash = (await client.writeContract({
        address: CONTRACT_ADDRESS,
        functionName: "preview_adjudication",
        args: [tid],
        value: 0n,
      } as never)) as `0x${string}`;
      setPreview("Running the real retrieval and the real panel — this takes minutes.");
      const receipt = await client.waitForTransactionReceipt({
        hash, status: TransactionStatus.FINALIZED, interval: 5_000, retries: 40,
      } as never);
      const json = returnedJson(receipt);
      setPreview(json ?? "The probe returned nothing readable.");
    } catch (e) {
      setFormError((e as Error).message ?? "The probe could not be run.");
      setPreview(null);
    }
  }

  const busy = !["idle", "finalized", "reverted", "error"].includes(state.phase);

  return (
    <div className="flex flex-col gap-4">
      {phase !== "connected" && (
        <WalletGate
          phase={phase}
          onConnect={() => setDialog(true)}
          onSwitch={() => void switchNetwork()}
        />
      )}

      <TxLifecycle state={state} onDismiss={reset} />

      {actions.length === 0 && (
        <p className="text-[13px] text-paper-faint">
          Nothing to do at this stage.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {actions.map((a) => {
          const isOpen = open === a.id;
          const needsForm = ["ship", "evidence", "dispute", "respond"].includes(a.id);

          return (
            <div key={a.id} className="border border-rule">
              <div className="flex flex-wrap items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3">
                    <span className="text-[14px] text-paper">{a.label}</span>
                    <span className="label">{a.who}</span>
                  </div>
                  <p className="mt-1 text-[12px] leading-relaxed text-paper-dim">{a.blurb}</p>
                  {!a.enabled && a.reason && (
                    <p className="mt-2 text-[12px] text-paper-faint">
                      <span className="text-critical">Unavailable</span> — {a.reason}
                    </p>
                  )}
                </div>

                <Button
                  tone={a.tone === "critical" ? "critical" : a.tone === "primary" ? "primary" : "ghost"}
                  disabled={!a.enabled || busy}
                  onClick={() => {
                    if (a.id === "preview") return void runPreview();
                    if (needsForm) return setOpen(isOpen ? null : a.id);
                    // No-input actions go straight through.
                    switch (a.id) {
                      case "accept":
                        return void run(a.id, "Accept trade", "accept_trade", [tid],
                          async () => (await t()).status === "accepted");
                      case "cancel":
                        return void run(a.id, "Cancel trade", "cancel_trade", [tid],
                          async () => (await t()).status === "cancelled");
                      case "fund":
                        return void run(a.id, `Fund ${gen(trade.agreed_amount)} GEN`, "fund_trade", [tid],
                          async () => (await t()).deposited_amount === trade.agreed_amount,
                          BigInt(trade.agreed_amount));
                      case "deliver":
                        return void run(a.id, "Record delivery", "mark_delivered", [tid],
                          async () => (await t()).status === "delivered");
                      case "begin":
                        return void run(a.id, "Freeze evidence & open the case", "begin_adjudication", [tid],
                          async () => (await t()).status === "adjudicating");
                      case "adjudicate":
                        return void run(a.id, "Run adjudication", "adjudicate", [tid],
                          async () => (await t()).status !== "adjudicating", 0n, 900_000);
                      case "appeal":
                        return void run(a.id, "Appeal the verdict", "submit_appeal", [tid],
                          async () => (await t()).status === "adjudicating");
                      case "finalize":
                        return void run(a.id, "Finalize verdict", "finalize", [tid],
                          async () => (await t()).status === "finalized");
                      case "close_undisputed":
                        return void run(a.id, "Close undisputed", "close_undisputed", [tid],
                          async () => (await t()).status === "finalized");
                      case "settle":
                        return void run(a.id, "Settle", "settle", [tid],
                          async () => (await t()).status === "settled");
                      case "recover":
                        return void run(a.id, "Claim timeout refund", "claim_timeout_refund", [tid],
                          async () => (await t()).status === "settled");
                    }
                  }}
                >
                  {a.id === "fund" ? `Fund ${gen(trade.agreed_amount)} GEN` : a.label}
                </Button>
              </div>

              {/* ── forms ────────────────────────────────────────────── */}
              {isOpen && (
                <div className="border-t border-rule bg-ink-lift px-4 py-4">
                  {a.id === "ship" && (
                    <Form
                      submit="Bind reference & mark shipped"
                      disabled={busy || carrierRef.trim().length < 4}
                      onSubmit={() =>
                        void run(a.id, "Mark shipped", "mark_shipped", [tid, carrierRef.trim()],
                          async () => (await t()).status === "shipped")
                      }
                    >
                      <L k="Carrier reference" hint={`Bound to ${trade.carrier} and fixed permanently. The contract will look this up at ${trade.carrier} — and only there.`}>
                        <input
                          className="mono"
                          value={carrierRef}
                          onChange={(e) => setCarrierRef(e.target.value)}
                          placeholder="MAEU-4471-2026"
                          maxLength={64}
                        />
                      </L>
                    </Form>
                  )}

                  {a.id === "dispute" && (
                    <Form
                      submit="Open dispute"
                      tone="critical"
                      disabled={busy || claim.trim().length === 0}
                      onSubmit={() =>
                        void run(a.id, "Open dispute", "open_dispute", [tid, claim.trim()],
                          async () => (await t()).status === "disputed")
                      }
                    >
                      <L k="Your claim" hint="Advocacy, not proof. The panel is told so explicitly, and the burden of proof is yours.">
                        <textarea rows={4} maxLength={1200} value={claim}
                          onChange={(e) => setClaim(e.target.value)}
                          placeholder="The goods do not match the agreed specification: model XP-100 was delivered." />
                      </L>
                    </Form>
                  )}

                  {a.id === "respond" && (
                    <Form
                      submit="File response"
                      disabled={busy || response.trim().length === 0}
                      onSubmit={() =>
                        void run(a.id, "Respond to dispute", "respond_to_dispute", [tid, response.trim()],
                          async () => Number((await read<Dispute>("get_dispute", [tid])).responded_at ?? 0) > 0)
                      }
                    >
                      <L k="Your response" hint="Also advocacy. Both positions are weighed against the evidence, not against each other.">
                        <textarea rows={4} maxLength={1200} value={response}
                          onChange={(e) => setResponse(e.target.value)}
                          placeholder="The goods match the agreement; the inspection report certifies model XP-200 Grade A." />
                      </L>
                    </Form>
                  )}

                  {a.id === "evidence" && (
                    <EvidenceForm
                      config={config}
                      evType={evType} setEvType={setEvType}
                      evTier={evTier} setEvTier={setEvTier}
                      evHash={evHash} setEvHash={setEvHash}
                      evRef={evRef} setEvRef={setEvRef}
                      evDesc={evDesc} setEvDesc={setEvDesc}
                      busy={busy}
                      error={formError}
                      onSubmit={() => {
                        const tier = STATEMENT_ONLY.has(evType) ? "PARTY_CLAIM" : evTier;
                        if (tier === "SUPPORTING") {
                          if (!/^(0x)?[0-9a-fA-F]{64}$/.test(evHash.trim())) {
                            return setFormError("Supporting evidence needs a sha256 digest — 64 hex characters.");
                          }
                          if (!evRef.trim()) {
                            return setFormError("Supporting evidence needs a storage reference.");
                          }
                        } else if (evHash.trim() && !/^(0x)?[0-9a-fA-F]{64}$/.test(evHash.trim())) {
                          return setFormError("A party claim may carry no digest, or a real sha256 — never free text.");
                        }
                        const before = Number(trade.evidence_count);
                        void run(a.id, "File evidence", "submit_evidence",
                          [tid, evType, tier, evHash.trim(), evRef.trim(), evDesc],
                          async () => Number((await read<EvidencePackage>("get_evidence", [tid])).count) > before);
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {formError && <Note tone="critical">{formError}</Note>}

      {preview && (
        <div className="border-l-2 border-gold bg-ink-lift px-4 py-3">
          <p className="label label-bracket mb-2">Source probe</p>
          <PreviewResult raw={preview} />
        </div>
      )}

      {dialog && <ConnectDialog onClose={() => setDialog(false)} />}
    </div>
  );
}

/* ── form scaffolding ───────────────────────────────────────────────────── */

function L({ k, hint, children }: { k: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="mb-4 block">
      <span className="label mb-1.5 block">{k}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[12px] leading-relaxed text-paper-faint">{hint}</span>}
    </label>
  );
}

function Form({
  children, submit, onSubmit, disabled, tone = "primary",
}: {
  children: React.ReactNode;
  submit: string;
  onSubmit: () => void;
  disabled: boolean;
  tone?: "primary" | "critical";
}) {
  return (
    <div>
      {children}
      <Button tone={tone} disabled={disabled} onClick={onSubmit}>{submit}</Button>
    </div>
  );
}

function EvidenceForm(p: {
  config: ProtocolConfig | null;
  evType: string; setEvType: (v: string) => void;
  evTier: "SUPPORTING" | "PARTY_CLAIM"; setEvTier: (v: "SUPPORTING" | "PARTY_CLAIM") => void;
  evHash: string; setEvHash: (v: string) => void;
  evRef: string; setEvRef: (v: string) => void;
  evDesc: string; setEvDesc: (v: string) => void;
  busy: boolean; error: string | null; onSubmit: () => void;
}) {
  const statementOnly = STATEMENT_ONLY.has(p.evType);
  const tier = statementOnly ? "PARTY_CLAIM" : p.evTier;

  return (
    <div>
      <Note tone="gold">
        You can file <span className="text-paper">Supporting</span> or{" "}
        <span className="text-paper">Party claim</span>. You cannot file{" "}
        <span className="text-paper">Authoritative</span> — the contract writes that
        tier itself, from a source it fetched. No party may self-declare authority.
      </Note>

      <div className="mt-4 grid gap-x-5 sm:grid-cols-2">
        <L k="Evidence type">
          <select value={p.evType} onChange={(e) => p.setEvType(e.target.value)}>
            {(p.config?.evidence_types ?? ["inspection_report", "statement"]).map((t) => (
              <option key={t} value={t}>{titleCase(t)}</option>
            ))}
          </select>
        </L>

        <L k="Tier" hint={statementOnly ? "A statement is an assertion, so it can only ever be a party claim." : undefined}>
          <select
            value={tier}
            disabled={statementOnly}
            onChange={(e) => p.setEvTier(e.target.value as "SUPPORTING" | "PARTY_CLAIM")}
            className={statementOnly ? "opacity-60" : ""}
          >
            <option value="SUPPORTING">Supporting — a document, anchored to a hash</option>
            <option value="PARTY_CLAIM">Party claim — a statement</option>
          </select>
        </L>
      </div>

      <L
        k="Document sha256"
        hint={
          tier === "SUPPORTING"
            ? "Required. 64 hex characters. This anchors WHICH document was filed; the contract cannot fetch it to confirm the bytes."
            : "Optional, and it must be a real digest or empty. Free text is refused here because this field is printed into the panel's prompt."
        }
      >
        <input className="mono" value={p.evHash} onChange={(e) => p.setEvHash(e.target.value)}
          placeholder={tier === "SUPPORTING" ? "a1b2c3…" : "(none)"} maxLength={66} />
      </L>

      {tier === "SUPPORTING" && (
        <L k="Storage reference" hint="Where the document lives — IPFS CID, URL, or an internal reference.">
          <input value={p.evRef} onChange={(e) => p.setEvRef(e.target.value)}
            placeholder="ipfs://Qm…" maxLength={300} />
        </L>
      )}

      <L k="Description" hint="Treated as untrusted material. Fence delimiters are defused before the panel sees it.">
        <textarea rows={3} maxLength={1200} value={p.evDesc}
          onChange={(e) => p.setEvDesc(e.target.value)}
          placeholder="SGS pre-shipment inspection, Grade A" />
      </L>

      {p.error && <Note tone="critical">{p.error}</Note>}

      <div className="mt-3">
        <Button tone="primary" disabled={p.busy} onClick={p.onSubmit}>File evidence</Button>
      </div>
    </div>
  );
}

function PreviewResult({ raw }: { raw: string }) {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf("{")));
  } catch {
    /* not JSON — show it as text */
  }
  if (!parsed) {
    return <p className="text-[13px] leading-relaxed text-paper-dim">{raw}</p>;
  }

  const carrier = (parsed.carrier ?? {}) as Record<string, unknown>;
  const readable = Boolean(carrier.readable);
  const findings = (parsed.findings ?? []) as { issue: string; result: string; rationale: string }[];

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="label mb-1">Bound source</p>
        <p className="mono break-all text-[12px] text-paper-dim">{String(carrier.source ?? "—")}</p>
      </div>
      <div className="flex items-center gap-3">
        <span className={`stamp ${readable ? "text-verified" : "text-critical"}`}>
          {readable ? "Retrieved" : "Not retrievable"}
        </span>
        <span className="text-[12px] text-paper-faint">
          {readable
            ? "Validators reached the authoritative record."
            : "The contract could not reach it, and the panel was told so. It is not told to assume anything."}
        </span>
      </div>
      {readable && Boolean(carrier.excerpt) && (
        <pre className="mono max-h-52 overflow-auto whitespace-pre-wrap border border-rule p-3 text-[11px] leading-relaxed text-paper-dim">
          {String(carrier.excerpt)}
        </pre>
      )}
      {findings.length > 0 && (
        <div>
          <p className="label mb-2">Findings this run would produce</p>
          <ul className="flex flex-col gap-1">
            {findings.map((f) => (
              <li key={f.issue} className="flex flex-wrap items-baseline gap-2 text-[12px]">
                <span className="label w-[150px] shrink-0">{f.issue.replace(/_/g, " ")}</span>
                <span className="text-paper">{f.result}</span>
                <span className="text-paper-faint">{f.rationale}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[12px] text-paper-faint">
        This changed no state and moved no value. A live panel is not deterministic,
        so a real adjudication may differ.
      </p>
    </div>
  );
}
