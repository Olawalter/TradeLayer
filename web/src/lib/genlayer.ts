"use client";

/**
 * The GenLayer boundary.
 *
 * Two hard-won rules live here, both learned from sibling deployments:
 *
 * 1. A FINALIZED transaction is not a SUCCESSFUL one. GenLayer finalizes
 *    reverts too, and on StudioNet the verdict is only in the leader receipt —
 *    the top-level camelCase fields a normal EVM client would read are
 *    undefined there. A frontend reading those reports every rejection as
 *    "Finalized on-chain", which is the worst possible lie for an escrow.
 *
 * 2. The receipt waiter intermittently reports a fetch failure for a
 *    transaction that in fact landed. So a write is only "done" once a VIEW
 *    predicate says the state actually changed.
 */

import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { CONTRACT_ADDRESS, RPC_URL } from "./contract";

let reader: ReturnType<typeof createClient> | null = null;

export function readClient() {
  if (!reader) {
    reader = createClient({ chain: studionet, endpoint: RPC_URL } as never);
  }
  return reader;
}

export async function read<T>(functionName: string, args: unknown[] = []): Promise<T> {
  return (await readClient().readContract({
    address: CONTRACT_ADDRESS,
    functionName,
    args,
  } as never)) as T;
}

/**
 * A signer bound to the connected injected wallet.
 *
 * Both `account` and `provider` are passed: the address identifies the signer,
 * the provider is what actually signs. No private key ever enters this app.
 */
export function writeClient(account: `0x${string}`, provider: unknown) {
  return createClient({
    chain: studionet,
    endpoint: RPC_URL,
    account,
    provider,
  } as never);
}

export async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await res.json();
  if (payload.error) throw new Error(payload.error.message ?? "RPC error");
  return payload.result as T;
}

export async function balanceOf(address: string): Promise<bigint> {
  const hex = await rpc<string>("eth_getBalance", [address, "latest"]);
  return BigInt(hex ?? "0x0");
}

/**
 * The revert reason of a finalized transaction, or null if it genuinely
 * succeeded.
 *
 * `consensus_data.leader_receipt[0].execution_result === "ERROR"` with the
 * message at `.result.payload`. `txExecutionResultName` and `messages[]` are
 * undefined and empty on StudioNet — anything reading those is reading nothing.
 */
export function revertReason(receipt: unknown): string | null {
  const r = (receipt ?? {}) as Record<string, unknown>;
  const consensus = r.consensus_data as Record<string, unknown> | undefined;
  const lr = consensus?.leader_receipt;
  const leader = (Array.isArray(lr) ? lr[0] : lr) as Record<string, unknown> | undefined;

  const exec = String(leader?.execution_result ?? "").toUpperCase();
  const legacy = String(r.txExecutionResultName ?? "").toUpperCase();
  const result = leader?.result as Record<string, unknown> | undefined;
  const rolledBack = String(result?.status ?? "").toLowerCase() === "rollback";

  if (!exec.includes("ERROR") && !legacy.includes("ERROR") && !rolledBack) return null;

  const payload = typeof result?.payload === "string" ? result.payload : "";
  return (
    payload.replace(/^\[(EXPECTED|TRANSIENT|EXTERNAL|LLM_ERROR)\]\s*/, "").trim() ||
    "The contract rejected this transaction."
  );
}

/**
 * The return value of a successful write, which arrives DOUBLE ENCODED: the
 * payload object holds the returned `str`, which is itself the JSON. Reading
 * it anywhere else on the receipt finds nothing.
 */
export function returnedJson(receipt: unknown): string | null {
  const r = (receipt ?? {}) as Record<string, unknown>;
  const consensus = r.consensus_data as Record<string, unknown> | undefined;
  const lr = consensus?.leader_receipt;
  const leader = (Array.isArray(lr) ? lr[0] : lr) as Record<string, unknown> | undefined;
  const payload = (leader?.result as Record<string, unknown> | undefined)?.payload;
  if (payload == null) return null;

  const values = typeof payload === "string" ? [payload] : Object.values(payload);
  for (const v of values) {
    if (typeof v !== "string") continue;
    let text = v;
    try {
      const inner = JSON.parse(text);
      if (typeof inner === "string") text = inner;
    } catch {
      /* already plain */
    }
    if (text.trimStart().startsWith("{")) return text;
  }
  return null;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
