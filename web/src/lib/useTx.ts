"use client";

/**
 * The transaction lifecycle, stated honestly.
 *
 * The prompt's required stages, and what each one actually means here:
 *
 *   awaiting-wallet   the wallet is asking the user to sign. Nothing sent.
 *   submitted         a hash exists. The network has not agreed to anything.
 *   pending           waiting for a receipt.
 *   consensus         GenLayer validators are executing and agreeing. For an
 *                     adjudication this is where the model actually runs, and
 *                     it takes minutes — it is NOT block time.
 *   reconciling       the transaction finalized WITHOUT a revert; now we poll a
 *                     VIEW until contract state actually reflects it.
 *   finalized         state changed. Only now is the write done.
 *   reverted          finalized AND rejected. Distinct from an error.
 *   error             never reached the chain, or the wallet refused.
 *
 * Two rules this exists to enforce:
 *   - "Finalized" is never shown because a transaction was submitted.
 *   - A revert is never shown as a success. GenLayer finalizes reverts, so the
 *     receipt must be interrogated, not merely awaited.
 */

import { useCallback, useRef, useState } from "react";
import { TransactionStatus } from "genlayer-js/types";
import { CONTRACT_ADDRESS } from "./contract";
import { revertReason, sleep, writeClient } from "./genlayer";
import type { Eip1193Provider } from "./wallet";

export type TxPhase =
  | "idle" | "awaiting-wallet" | "submitted" | "pending"
  | "consensus" | "reconciling" | "finalized" | "reverted" | "error";

export const PHASE_COPY: Record<Exclude<TxPhase, "idle">, string> = {
  "awaiting-wallet": "Confirm in your wallet",
  submitted: "Submitted",
  pending: "Pending",
  consensus: "GenLayer consensus",
  reconciling: "Reconciling contract state",
  finalized: "Finalized",
  reverted: "Rejected by the contract",
  error: "Failed",
};

/** Ordered, for the progress rail. Terminal states are not steps. */
export const PHASE_STEPS: TxPhase[] = [
  "awaiting-wallet", "submitted", "pending", "consensus", "reconciling", "finalized",
];

export interface TxState {
  phase: TxPhase;
  hash: `0x${string}` | null;
  message: string | null;
  label: string | null;
}

const IDLE: TxState = { phase: "idle", hash: null, message: null, label: null };

export interface SendOptions {
  /** Human label for the action, e.g. "Fund escrow". */
  label: string;
  functionName: string;
  args: unknown[];
  value?: bigint;
  /**
   * A VIEW predicate that returns true once contract state reflects the write.
   * Required: the receipt waiter intermittently reports failure for a
   * transaction that landed, so state is the authority, not the receipt.
   */
  settled: () => Promise<boolean>;
  /** Nondeterministic writes take minutes; give them a longer leash. */
  timeoutMs?: number;
}

export function useTx() {
  const [state, setState] = useState<TxState>(IDLE);
  const running = useRef(false);

  const reset = useCallback(() => setState(IDLE), []);

  const send = useCallback(
    async (
      address: `0x${string}`,
      provider: Eip1193Provider,
      opts: SendOptions
    ): Promise<boolean> => {
      if (running.current) return false;
      running.current = true;

      const set = (p: Partial<TxState>) =>
        setState((s) => ({ ...s, label: opts.label, ...p }));

      set({ phase: "awaiting-wallet", hash: null, message: null });

      const client = writeClient(address, provider);
      let hash: `0x${string}`;

      try {
        hash = (await client.writeContract({
          address: CONTRACT_ADDRESS,
          functionName: opts.functionName,
          args: opts.args,
          value: opts.value ?? 0n,
        } as never)) as `0x${string}`;
      } catch (e) {
        const err = e as { code?: number; message?: string; shortMessage?: string };
        running.current = false;
        set({
          phase: "error",
          message:
            err.code === 4001
              ? "You rejected the transaction in your wallet. Nothing was sent."
              : err.shortMessage ?? err.message ?? "The transaction could not be sent.",
        });
        return false;
      }

      set({ phase: "submitted", hash });
      await sleep(300);
      set({ phase: "pending" });

      // ── consensus ────────────────────────────────────────────────────────
      set({ phase: "consensus" });
      let receipt: unknown = null;
      try {
        receipt = await client.waitForTransactionReceipt({
          hash,
          status: TransactionStatus.FINALIZED,
          interval: 5_000,
          retries: 14,
        } as never);
      } catch {
        // The waiter is unreliable on StudioNet. State polling decides.
      }

      // A finalized receipt is not a successful one.
      if (receipt) {
        const reason = revertReason(receipt);
        if (reason) {
          running.current = false;
          set({ phase: "reverted", message: reason });
          return false;
        }
      }

      // ── reconcile against contract state ─────────────────────────────────
      set({ phase: "reconciling" });
      const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
      while (Date.now() < deadline) {
        try {
          if (await opts.settled()) {
            running.current = false;
            set({ phase: "finalized" });
            return true;
          }
        } catch {
          /* transient read failure; keep polling */
        }
        await sleep(4_000);
      }

      running.current = false;
      set({
        phase: "error",
        message:
          "The transaction was submitted but contract state has not changed yet. " +
          "It may still settle — check the explorer before retrying, so you do " +
          "not send it twice.",
      });
      return false;
    },
    []
  );

  // `busy` is deliberately NOT returned from the ref: reading a ref during
  // render is unreliable. Every caller derives it from state.phase.
  return { state, send, reset };
}
