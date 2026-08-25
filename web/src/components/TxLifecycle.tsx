"use client";

import { PHASE_COPY, PHASE_STEPS, type TxState } from "@/lib/useTx";
import { TxLink, Button } from "./primitives";

/**
 * The write lifecycle, rendered exactly as it is.
 *
 * Three things this deliberately does NOT do:
 *   - show "Finalized" because a hash exists;
 *   - render a revert as a success (GenLayer finalizes reverts, so "finalized"
 *     and "succeeded" are different facts);
 *   - hide an error behind a toast that disappears.
 */
export function TxLifecycle({
  state, onDismiss,
}: {
  state: TxState;
  onDismiss: () => void;
}) {
  if (state.phase === "idle") return null;

  const terminal = ["finalized", "reverted", "error"].includes(state.phase);
  const index = PHASE_STEPS.indexOf(state.phase);

  const tone =
    state.phase === "reverted" || state.phase === "error"
      ? "border-critical"
      : state.phase === "finalized"
      ? "border-verified"
      : "border-gold";

  return (
    <div className={`border-l-2 ${tone} bg-ink-lift px-5 py-4`} role="status" aria-live="polite">
      <div className="mb-3 flex items-center justify-between gap-4">
        <span className="label label-bracket">{state.label ?? "Transaction"}</span>
        {terminal && (
          <button onClick={onDismiss} className="label hover:text-paper">
            Dismiss
          </button>
        )}
      </div>

      {/* The rail. A step is only lit once it has genuinely been reached. */}
      {state.phase !== "reverted" && state.phase !== "error" && (
        <ol className="mb-3 flex flex-wrap gap-x-1 gap-y-2">
          {PHASE_STEPS.map((step, i) => {
            const done = index > i;
            const current = index === i;
            return (
              <li key={step} className="flex items-center gap-1">
                <span
                  className={`stamp border-0 px-0 ${
                    done ? "text-paper-dim" : current ? "text-gold live" : "text-paper-faint/45"
                  }`}
                >
                  {PHASE_COPY[step as keyof typeof PHASE_COPY]}
                </span>
                {i < PHASE_STEPS.length - 1 && (
                  <span className="px-1 text-[10px] text-rule-strong" aria-hidden>›</span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {state.phase === "consensus" && (
        <p className="mb-2 text-[12px] leading-relaxed text-paper-dim">
          Validators are executing this independently and must agree on every field
          the outcome depends on. For an adjudication the panel actually runs here,
          so this takes minutes — it is consensus, not block time.
        </p>
      )}

      {state.phase === "reconciling" && (
        <p className="mb-2 text-[12px] leading-relaxed text-paper-dim">
          The transaction finalized without a revert. Waiting until contract state
          actually reflects it, because the receipt alone is not proof that it did.
        </p>
      )}

      {state.phase === "reverted" && (
        <div className="mb-2">
          <p className="stamp mb-2 text-critical">Rejected by the contract</p>
          <p className="text-[13px] leading-relaxed text-paper">{state.message}</p>
          <p className="mt-2 text-[12px] text-paper-faint">
            This transaction finalized on-chain and was rejected. Nothing moved.
          </p>
        </div>
      )}

      {state.phase === "error" && (
        <div className="mb-2">
          <p className="stamp mb-2 text-critical">Failed</p>
          <p className="text-[13px] leading-relaxed text-paper">{state.message}</p>
        </div>
      )}

      {state.phase === "finalized" && (
        <p className="text-[13px] text-verified">
          Confirmed — contract state reflects this transaction.
        </p>
      )}

      {state.hash && (
        <div className="mt-3 flex items-center gap-3 border-t border-rule pt-3">
          <span className="label">Transaction</span>
          <TxLink hash={state.hash} />
        </div>
      )}
    </div>
  );
}

/** Shown when an action needs a wallet that is absent or on the wrong chain. */
export function WalletGate({
  phase, onConnect, onSwitch,
}: {
  phase: string;
  onConnect: () => void;
  onSwitch: () => void;
}) {
  if (phase === "connected") return null;
  if (phase === "wrong-network" || phase === "switching") {
    return (
      <div className="flex flex-wrap items-center gap-3 border-l-2 border-critical bg-ink-lift px-4 py-3">
        <span className="text-[13px] text-paper-dim">
          Your wallet is on a different network. Actions are disabled until it is on
          GenLayer StudioNet.
        </span>
        <Button tone="critical" onClick={onSwitch} disabled={phase === "switching"}>
          {phase === "switching" ? "Switching…" : "Switch network"}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3 border-l-2 border-rule bg-ink-lift px-4 py-3">
      <span className="text-[13px] text-paper-dim">
        Connect a wallet to act on this trade.
      </span>
      <Button tone="primary" onClick={onConnect}>Connect wallet</Button>
    </div>
  );
}
