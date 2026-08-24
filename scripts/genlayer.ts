/**
 * Shared StudioNet plumbing for the deploy and verification scripts.
 * One source of truth for the chain, the endpoint and the contract address.
 */

import "dotenv/config";
import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { privateKeyToAccount } from "viem/accounts";
import { TransactionStatus } from "genlayer-js/types";

export const STUDIO_URL =
  process.env.GENLAYER_RPC_URL ?? "https://studio.genlayer.com/api";

export const CHAIN_ID = 61999;
export const GEN = 1_000_000_000_000_000_000n;

export function contractAddress(): `0x${string}` {
  const addr = process.env.TRADELAYER_ADDRESS ?? process.env.NEXT_PUBLIC_CONTRACT_ADDRESS;
  if (!addr) {
    console.error("TRADELAYER_ADDRESS is not set (deploy first, or export it).");
    process.exit(1);
  }
  return addr as `0x${string}`;
}

export function account(envName: string) {
  const key = process.env[envName];
  if (!key || !key.startsWith("0x")) {
    console.error(`${envName} is missing from the environment.`);
    process.exit(1);
  }
  return privateKeyToAccount(key as `0x${string}`);
}

export function signer(envName: string) {
  return createClient({
    chain: studionet,
    account: account(envName),
    endpoint: STUDIO_URL,
  } as never);
}

export function reader() {
  return createClient({ chain: studionet, endpoint: STUDIO_URL } as never);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function balanceOf(address: string): Promise<bigint> {
  const res = await fetch(STUDIO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_getBalance",
      params: [address, "latest"],
    }),
  }).then((r) => r.json());
  return BigInt(res.result ?? "0x0");
}

export async function read(fn: string, args: any[] = []) {
  return reader().readContract({
    address: contractAddress(), functionName: fn, args,
  });
}

/**
 * Detect a reverted-but-FINALIZED transaction.
 *
 * GenLayer finalizes reverted transactions, so a finalized receipt is not a
 * successful one. On StudioNet the verdict lives in the leader receipt — the
 * top-level camelCase fields are undefined there, so reading only those reports
 * every revert as a success.
 */
export function revertReason(receipt: unknown): string | null {
  const r = (receipt ?? {}) as Record<string, unknown>;
  const lr = (r.consensus_data as Record<string, unknown> | undefined)?.leader_receipt;
  const leader = (Array.isArray(lr) ? lr[0] : lr) as Record<string, unknown> | undefined;
  const exec = String(leader?.execution_result ?? "").toUpperCase();
  const result = leader?.result as Record<string, unknown> | undefined;
  const rolledBack = String(result?.status ?? "").toLowerCase() === "rollback";
  if (!exec.includes("ERROR") && !rolledBack) return null;
  const payload = typeof result?.payload === "string" ? result.payload : "";
  return payload.replace(/^\[(EXPECTED|TRANSIENT|EXTERNAL|LLM_ERROR)\]\s*/, "").trim()
    || "the contract rejected this transaction";
}

/**
 * Submit a write and settle by STATE POLLING rather than trusting the receipt
 * waiter alone: StudioNet's waiter intermittently reports a fetch failure for a
 * transaction that in fact landed.
 */
export async function writeAndSettle(
  client: any,
  label: string,
  fn: string,
  args: any[],
  value: bigint,
  settled: () => Promise<boolean>,
  timeoutMs = 600_000,
): Promise<`0x${string}`> {
  const address = contractAddress();
  const hash = (await client.writeContract({
    address, functionName: fn, args, value,
  })) as `0x${string}`;
  console.log(`  tx ${label}: ${hash}`);
  const started = Date.now();
  try {
    await client.waitForTransactionReceipt({
      hash, status: TransactionStatus.FINALIZED, interval: 5_000, retries: 14,
    });
  } catch {
    /* fall through to state polling */
  }
  while (Date.now() - started < timeoutMs) {
    try {
      if (await settled()) {
        console.log(`  ok ${label}`);
        return hash;
      }
    } catch {
      /* transient read failure */
    }
    await sleep(6_000);
  }
  throw new Error(`[${label}] state never settled within ${timeoutMs / 1000}s`);
}

/** Expect an on-chain revert: the guarded state must be unchanged afterwards. */
export async function expectRevert(
  client: any,
  label: string,
  fn: string,
  args: any[],
  value: bigint,
  unchanged: () => Promise<boolean>,
): Promise<boolean> {
  const address = contractAddress();
  const hash = (await client.writeContract({
    address, functionName: fn, args, value,
  })) as `0x${string}`;
  console.log(`  tx ${label}: ${hash}`);
  try {
    const r = await client.waitForTransactionReceipt({
      hash, status: TransactionStatus.FINALIZED, interval: 5_000, retries: 24,
    });
    const why = revertReason(r);
    if (why) {
      console.log(`     rejected: ${why.slice(0, 90)}`);
      return true;
    }
  } catch {
    /* decide from state below */
  }
  await sleep(10_000);
  return unchanged();
}

export function sep(title: string) {
  console.log(`\n${"-".repeat(68)}\n  ${title}\n${"-".repeat(68)}`);
}

export const gen = (wei: bigint) => `${Number(wei) / 1e18} GEN`;
