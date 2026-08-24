/**
 * Probe the bound carrier source ON CHAIN, before any money depends on it.
 *
 * `preview_adjudication` runs the real retrieval + panel pipeline and returns
 * the case JSON without touching state or any balance. What we want from it is
 * one boolean — `carrier.readable` — plus the excerpt, because a source that
 * silently fails and a source that returns a 404 page as "the authoritative
 * record" look identical from the outside and are very different problems.
 *
 * Run:  npx tsx scripts/probe_carrier.ts <trade-id>
 */

import { TransactionStatus } from "genlayer-js/types";
import {
  signer, read, contractAddress, revertReason, sleep,
} from "./genlayer.js";

/**
 * The return value of a successful write lives on the LEADER receipt, at
 * consensus_data.leader_receipt[0].result.payload — and it arrives double
 * encoded: the payload object holds the returned `str`, which is itself the
 * JSON we want. Reading it anywhere else finds nothing.
 */
function returnedJson(receipt: any): string | null {
  const lr = receipt?.consensus_data?.leader_receipt;
  const leader = Array.isArray(lr) ? lr[0] : lr;
  const payload = leader?.result?.payload;
  if (payload == null) return null;
  const values = typeof payload === "string" ? [payload] : Object.values(payload);
  for (const v of values) {
    if (typeof v !== "string") continue;
    let text = v;
    try { const inner = JSON.parse(text); if (typeof inner === "string") text = inner; }
    catch { /* already plain */ }
    if (text.includes('"carrier"')) return text;
  }
  return null;
}

async function main() {
  const tradeId = process.argv[2] ?? "TL-1000";
  const client = signer("BUYER_PK");

  const t: any = await read("get_trade", [tradeId]);
  console.log("TradeLayer — carrier source probe");
  console.log("  contract :", contractAddress());
  console.log("  trade    :", tradeId, `(${t.status})`);
  console.log("  carrier  :", t.carrier, "ref", t.carrier_reference);
  console.log("");

  const hash: any = await client.writeContract({
    address: contractAddress(),
    functionName: "preview_adjudication",
    args: [tradeId],
    value: 0n,
  });
  console.log("  tx preview_adjudication:", hash);

  let receipt: any = null;
  for (let i = 0; i < 40 && !receipt; i++) {
    try {
      receipt = await client.waitForTransactionReceipt({
        hash, status: TransactionStatus.FINALIZED, interval: 5_000, retries: 12,
      });
    } catch {
      await sleep(6_000);
    }
  }
  if (!receipt) throw new Error("no receipt after polling");

  const reason = revertReason(receipt);
  if (reason) {
    console.log("  REVERTED:", reason);
    process.exit(1);
  }

  const json = returnedJson(receipt);
  if (!json) {
    console.log("  could not locate the returned case JSON on the receipt.");
    console.log("  receipt keys:", Object.keys(receipt));
    process.exit(2);
  }

  const start = json.indexOf("{");
  const parsed = JSON.parse(json.slice(start, json.lastIndexOf("}") + 1));
  const carrier = parsed.carrier ?? {};

  console.log("");
  console.log("  source url : ", carrier.source);
  console.log("  READABLE   : ", carrier.readable);
  console.log("  digest     : ", carrier.digest || "(none)");
  console.log("  excerpt    : ", JSON.stringify(String(carrier.excerpt ?? "").slice(0, 400)));
  console.log("");
  console.log("  ok         : ", parsed.ok);
  for (const f of parsed.findings ?? []) {
    console.log(`    ${f.issue.padEnd(18)} ${f.result}`);
  }

  if (!carrier.readable) {
    console.log("");
    console.log("  → the contract could NOT retrieve the bound record. The panel");
    console.log("    was told so explicitly and no authoritative block was built.");
  } else if (/404|not found/i.test(String(carrier.excerpt))) {
    console.log("");
    console.log("  → WARNING: the fetch succeeded but returned an error page.");
    console.log("    A 404 body must never be presented as an authoritative record.");
    process.exit(3);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
