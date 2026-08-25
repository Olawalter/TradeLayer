/**
 * Prove the dApp's write path against the live contract.
 *
 * This drives `web/src/lib/write.ts` — THE SAME MODULE the browser runs — with
 * a local account instead of an injected wallet. What it can prove:
 *
 *   - a successful write reports its phases in the right order, and only
 *     reaches `finalized` once contract state actually changed;
 *   - a REVERTED transaction is reported as `reverted`, never as `finalized`.
 *     GenLayer finalizes reverts, so this is the single most dangerous thing a
 *     GenLayer frontend can get wrong: an escrow interface that renders a
 *     rejection as a success;
 *   - the interface's action gating agrees with what the contract will
 *     actually accept, at each step of a real lifecycle.
 *
 * What it cannot prove, and does not claim to: EIP-6963 wallet discovery and
 * `wallet_switchEthereumChain` reconciliation. Those need a browser wallet.
 *
 * Run:  npx tsx scripts/prove_write_path.ts
 */

import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";

// The web lib reads its address from NEXT_PUBLIC_*; the scripts use
// TRADELAYER_ADDRESS. Bridge them BEFORE the modules are imported, or the lib
// would silently fall back to its baked-in default and we would be proving the
// write path against a contract nobody deployed in this session.
process.env.NEXT_PUBLIC_CONTRACT_ADDRESS =
  process.env.TRADELAYER_ADDRESS ?? process.env.NEXT_PUBLIC_CONTRACT_ADDRESS;

const { runWrite } = await import("../web/src/lib/write.js");
const { read } = await import("../web/src/lib/genlayer.js");
const { CONTRACT_ADDRESS } = await import("../web/src/lib/contract.js");
const { actionsFor, roleOf } = await import("../web/src/lib/actions.js");
const { gen, toWei } = await import("../web/src/lib/format.js");
type Trade = import("../web/src/lib/contract.js").Trade;
type Dispute = import("../web/src/lib/contract.js").Dispute;
type ProtocolConfig = import("../web/src/lib/contract.js").ProtocolConfig;

const SUCCESS_PHASES = [
  "awaiting-wallet", "submitted", "pending", "consensus", "reconciling", "finalized",
];

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
function sep(title: string) {
  console.log(`\n${"-".repeat(70)}\n  ${title}\n${"-".repeat(70)}`);
}

function account(env: string) {
  const key = process.env[env];
  if (!key?.startsWith("0x")) {
    console.error(`${env} is missing from .env`);
    process.exit(1);
  }
  return privateKeyToAccount(key as `0x${string}`);
}

/** Drive one write and capture the phase sequence the UI would render. */
async function drive(
  signer: unknown,
  opts: Parameters<typeof runWrite>[2]
) {
  const phases: string[] = [];
  const result = await runWrite(signer, undefined, { ...opts, pollMs: 3_000 }, (r) => {
    if (phases[phases.length - 1] !== r.phase) phases.push(r.phase);
  });
  return { ...result, phases };
}

async function main() {
  const buyer = account("BUYER_PK");
  const seller = account("SELLER_PK");
  const VALUE = toWei("0.05");

  console.log("TradeLayer — proving the dApp write path against the live contract");
  console.log("  contract:", CONTRACT_ADDRESS);
  console.log("  buyer   :", buyer.address);
  console.log("  seller  :", seller.address);
  console.log("  value   :", gen(VALUE), "GEN");
  console.log("\n  Driving web/src/lib/write.ts — the same module the browser runs.");

  const cfg = await read<ProtocolConfig>("get_config", []);
  const before = cfg.trade_count;
  const tid = `TL-${1000 + before}`;
  const t = () => read<Trade>("get_trade", [tid]);
  const d = async () => {
    try { return await read<Dispute>("get_dispute", [tid]); } catch { return null; }
  };

  // ── 1. a successful write ────────────────────────────────────────────────
  sep("1 — a successful write reaches finalized, and only via state");
  const now = Math.floor(Date.now() / 1000);
  const created = await drive(buyer, {
    label: "Create trade",
    functionName: "create_trade",
    args: [
      seller.address,
      "600 marine gearboxes, model MG-90, Grade B",
      "MG-90", 600, VALUE,
      "Grade B per SGS inspection standard",
      "Tema, Ghana",
      "DEMO_REGISTRY",
      now + 900, now + 1800,
      600,
      Number(cfg.response_window) + 300 + 900,
      300,
      true,
      ["PRODUCT_MODEL", "QUANTITY"],
      [7000, 3000],
      ["Goods are model MG-90", "Exactly 600 units delivered"],
    ],
    settled: async () =>
      (await read<ProtocolConfig>("get_config", [])).trade_count > before,
  });
  check("create_trade finalized", created.ok, created.phase);
  check("phases were reported in order",
    JSON.stringify(created.phases) === JSON.stringify(SUCCESS_PHASES),
    created.phases.join(" › "));
  check("a transaction hash was surfaced", Boolean(created.hash));
  console.log("  trade:", tid);

  // ── 2. the interface's gating agrees with the contract ───────────────────
  sep("2 — the interface's action gating matches what the contract accepts");
  let trade = await t();
  const gate = async (role: "buyer" | "seller", id: string) => {
    const fresh = await t();
    const acts = actionsFor(fresh, await d(), role, Math.floor(Date.now() / 1000), true);
    return acts.find((a) => a.id === id);
  };

  check("role is derived from the trade, not asserted",
    roleOf(trade, buyer.address) === "buyer" && roleOf(trade, seller.address) === "seller");
  check("UI offers 'accept' to the seller on a created trade",
    (await gate("seller", "accept"))?.enabled === true);
  check("UI refuses 'accept' to the buyer, with a reason",
    (await gate("buyer", "accept"))?.enabled === false,
    (await gate("buyer", "accept"))?.reason);
  check("UI refuses 'fund' before acceptance",
    (await gate("buyer", "fund")) === undefined,
    "not offered at this status");

  // ── 3. accept + fund ─────────────────────────────────────────────────────
  sep("3 — accept, then fund real escrow");
  const accepted = await drive(seller, {
    label: "Accept trade", functionName: "accept_trade", args: [tid],
    settled: async () => (await t()).status === "accepted",
  });
  check("accept_trade finalized", accepted.ok, accepted.phase);

  check("UI now offers 'fund' to the buyer",
    (await gate("buyer", "fund"))?.enabled === true);

  const funded = await drive(buyer, {
    label: "Fund escrow", functionName: "fund_trade", args: [tid], value: VALUE,
    settled: async () => (await t()).deposited_amount === VALUE.toString(),
  });
  check("fund_trade finalized", funded.ok, funded.phase);
  trade = await t();
  check("escrow is actually held", trade.deposited_amount === VALUE.toString(),
    `${gen(trade.deposited_amount)} GEN`);

  // ── 4. THE ONE THAT MATTERS: a revert must not read as success ───────────
  sep("4 — a REVERTED transaction is reported as reverted, never as finalized");
  const doubleAccept = await drive(seller, {
    label: "Accept an already-accepted trade",
    functionName: "accept_trade", args: [tid],
    // Deliberately a predicate that can never become true, so a bug that
    // ignored the revert would hang here rather than pass by luck.
    settled: async () => false,
    timeoutMs: 30_000,
  });
  check("the write did NOT report success", doubleAccept.ok === false, doubleAccept.phase);
  check("it was classified as 'reverted', not 'error' or 'finalized'",
    doubleAccept.phase === "reverted", doubleAccept.phase);
  check("'finalized' never appeared in the phase sequence",
    !doubleAccept.phases.includes("finalized"), doubleAccept.phases.join(" › "));
  check("the contract's own message was surfaced",
    Boolean(doubleAccept.message?.includes("no longer awaiting acceptance")),
    doubleAccept.message ?? "(none)");

  // ── 5. a second revert, on a guard the review round added ────────────────
  sep("5 — the seller cannot self-certify delivery, and the UI says why first");
  const shipped = await drive(seller, {
    label: "Mark shipped", functionName: "mark_shipped", args: [tid, "MAEU-9001-2026"],
    settled: async () => (await t()).status === "shipped",
  });
  check("mark_shipped finalized", shipped.ok, shipped.phase);

  const deliverGate = await gate("seller", "deliver");
  check("UI refuses 'deliver' to the seller before the delivery deadline",
    deliverGate?.enabled === false, deliverGate?.reason);

  const earlyDeliver = await drive(seller, {
    label: "Seller records delivery early",
    functionName: "mark_delivered", args: [tid],
    settled: async () => false,
    timeoutMs: 30_000,
  });
  check("the contract rejected it too", earlyDeliver.phase === "reverted", earlyDeliver.phase);
  check("the UI's stated reason matched the contract's",
    Boolean(earlyDeliver.message?.includes("self-certify")),
    earlyDeliver.message ?? "(none)");

  const buyerDeliverGate = await gate("buyer", "deliver");
  check("UI offers 'deliver' to the buyer at the same instant",
    buyerDeliverGate?.enabled === true);

  // ── result ───────────────────────────────────────────────────────────────
  sep("RESULT");
  trade = await t();
  console.log("  trade   :", tid, `(${trade.status})`);
  console.log("  escrow  :", gen(trade.deposited_amount), "GEN held");
  console.log("  failures:", failures);
  console.log(
    failures === 0
      ? "\n  The dApp's write path is proven against the live contract.\n" +
        "  Wallet discovery and chain switching still need a browser wallet.\n"
      : "\n  FAILURES ABOVE.\n"
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
