"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useRead } from "@/lib/hooks";
import { useWallet } from "@/lib/wallet";
import { useTx } from "@/lib/useTx";
import { read } from "@/lib/genlayer";
import { bps, toWei } from "@/lib/format";
import type { ProtocolConfig } from "@/lib/contract";
import { Button, Note, Section } from "@/components/primitives";
import { TxLifecycle, WalletGate } from "@/components/TxLifecycle";
import { ConnectDialog } from "@/components/ConnectDialog";

const MIN_ADJUDICATION_TIME = 600;

interface Line {
  issue: string;
  buyer_bps: string;
  requirement: string;
}

const DEFAULT_LINES: Line[] = [
  { issue: "PRODUCT_MODEL", buyer_bps: "6500", requirement: "Goods are the model specified in the agreement" },
  { issue: "QUANTITY", buyer_bps: "2000", requirement: "The agreed quantity is delivered in full" },
  { issue: "QUALITY_GRADE", buyer_bps: "1000", requirement: "Quality meets the agreed inspection grade" },
  { issue: "SHIPPING_DEADLINE", buyer_bps: "500", requirement: "Shipped on board before the shipping deadline" },
];

export default function CreateTrade() {
  const router = useRouter();
  const { address, provider, phase, switchNetwork } = useWallet();
  const { state, send, reset } = useTx();
  const { data: config } = useRead<ProtocolConfig>("get_config", [], 0);
  const [dialog, setDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [seller, setSeller] = useState("");
  const [product, setProduct] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [quantity, setQuantity] = useState("1000");
  const [amount, setAmount] = useState("0.5");
  const [quality, setQuality] = useState("");
  const [destination, setDestination] = useState("");
  const [carrier, setCarrier] = useState("");
  const [shipDays, setShipDays] = useState("14");
  const [deliverDays, setDeliverDays] = useState("45");
  const [disputeDays, setDisputeDays] = useState("7");
  const [appealHours, setAppealHours] = useState("24");
  const [inspection, setInspection] = useState(true);
  const [lines, setLines] = useState<Line[]>(DEFAULT_LINES);

  const carriers = config?.carriers ?? [];
  const issues = config?.issues ?? [];
  if (carriers.length && !carrier) setCarrier(carriers[0]);

  const totalBps = lines.reduce((s, l) => s + (Number(l.buyer_bps) || 0), 0);

  /* The resolution window is DERIVED, never typed. The contract requires it to
     leave room for the seller's response window, the appeal window, and time
     to actually hear a round — so computing it removes a whole class of
     rejection the user cannot reasonably be expected to pre-empt. */
  const responseWindow = config?.response_window ?? 3 * 24 * 3600;
  const appealWindow = Math.round((Number(appealHours) || 0) * 3600);
  const resolutionWindow = responseWindow + appealWindow + MIN_ADJUDICATION_TIME + 3600;

  const problems = useMemo(() => {
    const p: string[] = [];
    if (!/^0x[0-9a-fA-F]{40}$/.test(seller.trim())) p.push("The seller must be a 0x address.");
    else if (address && seller.trim().toLowerCase() === address.toLowerCase())
      p.push("The buyer and the seller must be different accounts.");
    if (!product.trim()) p.push("Describe the goods.");
    if (!identifier.trim()) p.push("Give a product identifier.");
    if (!(Number(quantity) > 0)) p.push("Quantity must be a positive number.");
    try {
      const wei = toWei(amount);
      if (config && wei < BigInt(config.min_trade_value_wei))
        p.push("The trade value is below the protocol minimum.");
    } catch (e) { p.push((e as Error).message); }
    if (!quality.trim()) p.push("State the quality requirement.");
    if (!destination.trim()) p.push("Give a destination.");
    if (!carrier) p.push("Choose a carrier.");
    if (!(Number(shipDays) > 0)) p.push("The shipping deadline must be in the future.");
    if (Number(deliverDays) <= Number(shipDays))
      p.push("The delivery deadline must follow the shipping deadline.");
    const disputeWindow = Math.round((Number(disputeDays) || 0) * 86400);
    const minW = config?.min_window ?? 120;
    if (disputeWindow < minW) p.push("The dispute window is too short to be usable.");
    if (appealWindow < minW) p.push("The appeal window is too short to be usable.");
    if (lines.length === 0) p.push("Agree at least one issue.");
    if (new Set(lines.map((l) => l.issue)).size !== lines.length)
      p.push("Each issue may appear only once.");
    lines.forEach((l, i) => {
      const v = Number(l.buyer_bps);
      if (!(v >= 1 && v <= 10000)) p.push(`Remedy ${i + 1} must be between 1 and 10000 bps.`);
      if (!l.requirement.trim()) p.push(`Issue ${i + 1} needs a stated requirement.`);
    });
    if (totalBps > 10000)
      p.push(`The remedies total ${bps(totalBps)} — they cannot exceed the whole trade.`);
    return p;
  }, [seller, product, identifier, quantity, amount, quality, destination, carrier,
      shipDays, deliverDays, disputeDays, appealWindow, lines, totalBps, config, address]);

  const ready = problems.length === 0 && phase === "connected";

  async function submit() {
    if (!address || !provider || !ready) return;
    setError(null);
    const now = Math.floor(Date.now() / 1000);
    const before = (await read<ProtocolConfig>("get_config", [])).trade_count;

    const ok = await send(address, provider, {
      label: "Create trade",
      functionName: "create_trade",
      args: [
        seller.trim(),
        product.trim(),
        identifier.trim(),
        Number(quantity),
        toWei(amount),
        quality.trim(),
        destination.trim(),
        carrier,
        now + Math.round(Number(shipDays) * 86400),
        now + Math.round(Number(deliverDays) * 86400),
        Math.round(Number(disputeDays) * 86400),
        resolutionWindow,
        appealWindow,
        inspection,
        lines.map((l) => l.issue),
        lines.map((l) => Number(l.buyer_bps)),
        lines.map((l) => l.requirement.trim()),
      ],
      settled: async () =>
        (await read<ProtocolConfig>("get_config", [])).trade_count > before,
    });

    if (ok) router.push(`/trade/TL-${1000 + before}`);
  }

  const busy = !["idle", "finalized", "reverted", "error"].includes(state.phase);

  return (
    <div>
      <div className="px-6 pb-8 pt-12 md:px-10">
        <p className="label label-bracket mb-4">New agreement</p>
        <h1 className="display max-w-[20ch] text-[clamp(2rem,5vw,3.5rem)] text-paper">
          Agree the remedy before the goods ship
        </h1>
        <p className="mt-6 max-w-[64ch] text-[15px] leading-relaxed text-paper-dim">
          You are writing the terms a panel will later be measured against — and,
          separately, the amount each breach is worth. Both are fixed here and
          neither can be changed afterwards.
        </p>
      </div>

      <div className="grid border-t border-rule lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="lg:border-r lg:border-rule">
          <Section label="Counterparty and goods">
            <div className="grid gap-x-6 sm:grid-cols-2">
              <F k="Seller address" hint="The account that must accept, ship and deliver. It cannot be you.">
                <input className="mono" value={seller} onChange={(e) => setSeller(e.target.value)}
                  placeholder="0x…" spellCheck={false} />
              </F>
              <F k="Trade value (GEN)" hint="The buyer must fund this EXACTLY. Over and under are both refused.">
                <input className="mono" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.5" />
              </F>
              <F k="Goods" hint="What is being bought, in the words both parties would use.">
                <input value={product} onChange={(e) => setProduct(e.target.value)}
                  placeholder="1,000 industrial pumps, model XP-200, Grade A" maxLength={1200} />
              </F>
              <F k="Product identifier">
                <input className="mono" value={identifier} onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="XP-200" maxLength={300} />
              </F>
              <F k="Quantity">
                <input className="mono" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="1000" />
              </F>
              <F k="Destination">
                <input value={destination} onChange={(e) => setDestination(e.target.value)}
                  placeholder="Lagos, Nigeria" maxLength={300} />
              </F>
              <F k="Quality requirement" hint="The standard a breach would be measured against.">
                <input value={quality} onChange={(e) => setQuality(e.target.value)}
                  placeholder="Grade A per SGS inspection standard" maxLength={1200} />
              </F>
              <F k="Carrier" hint="Fixes WHERE the contract will look for the authoritative record. The reference itself is bound later, at shipment.">
                <select value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                  {carriers.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </F>
            </div>

            <label className="mt-2 flex cursor-pointer items-center gap-3">
              <input type="checkbox" checked={inspection} onChange={(e) => setInspection(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--gold)]" style={{ width: "auto" }} />
              <span className="text-[13px] text-paper-dim">Pre-shipment inspection required</span>
            </label>
          </Section>

          {/* ── the remedy table ─────────────────────────────────────── */}
          <Section
            label="The remedy table"
            action={
              <span className={`stamp ${totalBps > 10000 ? "text-critical" : "text-gold"}`}>
                Total {bps(totalBps)}
              </span>
            }
          >
            <Note tone="gold">
              This is the part that makes the rest safe. For each issue you agree{" "}
              <span className="text-paper">now</span> what a breach is worth. If the panel
              later finds that issue breached, the contract adds up these numbers — the
              panel is never asked how to split the money, and there is nowhere for it to
              put a number even if it volunteered one.
            </Note>

            <div className="mt-5 flex flex-col gap-4">
              {lines.map((line, i) => (
                <div key={i} className="border border-rule px-4 py-4">
                  <div className="mb-3 flex flex-wrap items-center gap-3">
                    <select
                      value={line.issue}
                      onChange={(e) => setLines(lines.map((l, j) => j === i ? { ...l, issue: e.target.value } : l))}
                      style={{ width: "auto" }}
                      className="min-w-[200px]"
                    >
                      {issues.map((iss) => (
                        <option key={iss} value={iss}>{iss.replace(/_/g, " ")}</option>
                      ))}
                    </select>

                    <div className="flex items-center gap-2">
                      <input
                        className="mono w-[110px]"
                        style={{ width: "110px" }}
                        value={line.buyer_bps}
                        onChange={(e) => setLines(lines.map((l, j) => j === i ? { ...l, buyer_bps: e.target.value } : l))}
                      />
                      <span className="label">bps to buyer</span>
                      <span className="mono text-[12px] text-gold">
                        {bps(Number(line.buyer_bps) || 0)}
                      </span>
                    </div>

                    {lines.length > 1 && (
                      <button
                        onClick={() => setLines(lines.filter((_, j) => j !== i))}
                        className="label ml-auto hover:text-critical"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  <input
                    value={line.requirement}
                    onChange={(e) => setLines(lines.map((l, j) => j === i ? { ...l, requirement: e.target.value } : l))}
                    placeholder="The requirement, stated so a reader could check it"
                    maxLength={1200}
                  />
                </div>
              ))}
            </div>

            {lines.length < issues.length && (
              <button
                onClick={() => {
                  const unused = issues.find((i) => !lines.some((l) => l.issue === i));
                  if (unused) setLines([...lines, { issue: unused, buyer_bps: "500", requirement: "" }]);
                }}
                className="stamp mt-4 border border-rule-strong px-3 py-2 text-paper-dim hover:border-paper-dim hover:text-paper"
              >
                Add issue
              </button>
            )}

            <p className="mt-4 text-[12px] leading-relaxed text-paper-faint">
              Remedies may total less than 100% — anything unallocated stays with the seller
              even if every agreed issue is breached. They may never total more.
            </p>
          </Section>

          {/* ── windows ──────────────────────────────────────────────── */}
          <Section label="Deadlines and windows">
            <div className="grid gap-x-6 sm:grid-cols-2">
              <F k="Ship within (days)"><input className="mono" value={shipDays} onChange={(e) => setShipDays(e.target.value)} /></F>
              <F k="Deliver within (days)"><input className="mono" value={deliverDays} onChange={(e) => setDeliverDays(e.target.value)} /></F>
              <F k="Dispute window (days)" hint="How long the buyer has after delivery to raise a claim. Once it closes with no dispute, the trade settles to the seller.">
                <input className="mono" value={disputeDays} onChange={(e) => setDisputeDays(e.target.value)} />
              </F>
              <F k="Appeal window (hours)" hint="How long a proposed verdict can be appealed. It is clamped so it can never outlive the point where another round could still be heard.">
                <input className="mono" value={appealHours} onChange={(e) => setAppealHours(e.target.value)} />
              </F>
            </div>

            <Note>
              The <span className="text-paper">resolution window is derived, not typed</span>:{" "}
              <span className="mono text-paper">
                {Math.round(resolutionWindow / 86400 * 10) / 10} days
              </span>{" "}
              = the seller’s {responseWindow / 86400}-day response window + your appeal
              window + time to actually hear a round. The contract refuses anything shorter,
              because a seller who simply stays silent must never be able to run the clock
              out and make adjudication impossible.
            </Note>
          </Section>
        </div>

        {/* ── right rail ───────────────────────────────────────────── */}
        <div className="border-t border-rule lg:border-t-0">
          <div className="sticky top-14">
            <Section label="Before you sign">
              {phase !== "connected" && (
                <div className="mb-4">
                  <WalletGate phase={phase} onConnect={() => setDialog(true)} onSwitch={() => void switchNetwork()} />
                </div>
              )}

              <TxLifecycle state={state} onDismiss={reset} />

              {problems.length > 0 ? (
                <div className="mt-4">
                  <p className="label mb-2 text-critical">Not ready</p>
                  <ul className="flex flex-col gap-1.5">
                    {problems.map((p) => (
                      <li key={p} className="text-[12px] leading-relaxed text-paper-dim">— {p}</li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="mt-4">
                  <p className="label mb-2 text-verified">Ready</p>
                  <p className="text-[12px] leading-relaxed text-paper-dim">
                    Creating the trade costs nothing and moves nothing. The seller must accept
                    before you can fund it, and no value is at risk until you do.
                  </p>
                </div>
              )}

              {error && <Note tone="critical">{error}</Note>}

              <div className="mt-5">
                <Button tone="primary" disabled={!ready || busy} onClick={() => void submit()}>
                  {busy ? "Working…" : "Create trade"}
                </Button>
              </div>
            </Section>
          </div>
        </div>
      </div>

      {dialog && <ConnectDialog onClose={() => setDialog(false)} />}
    </div>
  );
}

function F({ k, hint, children }: { k: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="mb-5 block">
      <span className="label mb-1.5 block">{k}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[12px] leading-relaxed text-paper-faint">{hint}</span>}
    </label>
  );
}
