/**
 * The write pipeline, with no React in it.
 *
 * This is deliberately not a hook. `useTx` is a thin wrapper that pipes the
 * phase reports into React state, and a headless harness drives this exact
 * function against the live contract — so the revert detection and the
 * state-reconciliation logic that the interface depends on are proven by
 * something that actually runs, rather than by a copy of them in a test.
 *
 * The phases and what each one really means:
 *
 *   awaiting-wallet   the wallet is asking the user to sign. Nothing sent.
 *   submitted         a hash exists. The network has not agreed to anything.
 *   pending           waiting for a receipt.
 *   consensus         GenLayer validators are executing and agreeing. For an
 *                     adjudication this is where the model actually runs, and
 *                     it takes minutes — it is NOT block time.
 *   reconciling       finalized WITHOUT a revert; now poll a VIEW until
 *                     contract state actually reflects it.
 *   finalized         state changed. Only now is the write done.
 *   reverted          finalized AND rejected. Distinct from an error.
 *   error             never reached the chain, or the wallet refused.
 */

import { TransactionStatus } from "genlayer-js/types";
import { CONTRACT_ADDRESS } from "./contract";
import { revertReason, sleep, writeClient } from "./genlayer";

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
  /** Poll interval while reconciling. Lowered by tests. */
  pollMs?: number;
}

export interface Report {
  phase: TxPhase;
  hash?: `0x${string}` | null;
  message?: string | null;
}

export interface WriteResult {
  ok: boolean;
  phase: TxPhase;
  hash: `0x${string}` | null;
  message: string | null;
}

/**
 * Run one write to completion.
 *
 * `signer` is whatever genlayer-js accepts as an account: an address in the
 * browser (where the injected provider signs), or a full local account in a
 * headless harness. No private key is ever handled by the browser path.
 */
export async function runWrite(
  signer: unknown,
  provider: unknown,
  opts: SendOptions,
  report: (r: Report) => void = () => {}
): Promise<WriteResult> {
  const done = (phase: TxPhase, hash: `0x${string}` | null, message: string | null): WriteResult => {
    report({ phase, hash, message });
    return { ok: phase === "finalized", phase, hash, message };
  };

  report({ phase: "awaiting-wallet", hash: null, message: null });

  const client = writeClient(signer, provider);
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
    return done(
      "error",
      null,
      err.code === 4001
        ? "You rejected the transaction in your wallet. Nothing was sent."
        : err.shortMessage ?? err.message ?? "The transaction could not be sent."
    );
  }

  report({ phase: "submitted", hash });
  report({ phase: "pending", hash });
  report({ phase: "consensus", hash });

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
    if (reason) return done("reverted", hash, reason);
  }

  report({ phase: "reconciling", hash });
  const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
  while (Date.now() < deadline) {
    try {
      if (await opts.settled()) return done("finalized", hash, null);
    } catch {
      /* transient read failure; keep polling */
    }
    await sleep(opts.pollMs ?? 4_000);
  }

  return done(
    "error",
    hash,
    "The transaction was submitted but contract state has not changed yet. " +
    "It may still settle — check the explorer before retrying, so you do " +
    "not send it twice."
  );
}
