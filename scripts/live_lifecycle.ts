/**
 * The whole protocol, proven against the deployed contract with real value.
 *
 *   create -> accept -> fund (real escrow) -> ship -> deliver -> evidence ->
 *   dispute -> respond -> FREEZE -> GenLayer adjudication -> appeal window ->
 *   finalize -> settlement delay -> settle -> BALANCES ASSERTED ->
 *   double-settle rejected
 *
 * The assertions that matter most, and that a happy-path demo usually skips:
 *   1. both parties' WALLET BALANCES move by exactly the derived split —
 *      contract state looking right while no GEN moved is a real failure mode;
 *   2. the payout equals the PRE-AGREED remedy for the issues found breached,
 *      so the panel demonstrably never chose the number;
 *   3. a second settlement moves nothing.
 *
 * This runs in real time: the appeal window and settlement delay are wall
 * clock, so expect roughly 10-15 minutes.
 *
 * Run:  npm run lifecycle
 */

import {
  signer, read, writeAndSettle, expectRevert, balanceOf, sleep, sep, gen, GEN,
} from "./genlayer.js";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const VALUE = GEN / 2n;                       // 0.5 GEN stands in for $50,000
const CARRIER_REF = "MAEU-4471-2026";

// The agreed remedy table: what each breach is worth, fixed before shipment.
const ISSUES = ["PRODUCT_MODEL", "QUANTITY", "QUALITY_GRADE", "SHIPPING_DEADLINE"];
const REMEDIES = [6500, 2000, 1000, 500];
const REQUIREMENTS = [
  "Goods are model XP-200 as specified in the agreement",
  "Exactly 1,000 units delivered",
  "Grade A quality per the agreed inspection standard",
  "Shipped on board before the shipping deadline",
];

async function main() {
  const buyer = signer("BUYER_PK");
  const seller = signer("SELLER_PK");
  const buyerAddr = (buyer as any).account.address as string;
  const sellerAddr = (seller as any).account.address as string;

  console.log("TradeLayer — live lifecycle proof");
  console.log("  buyer (Nigeria) :", buyerAddr);
  console.log("  seller (China)  :", sellerAddr);
  console.log("  trade value     :", gen(VALUE));

  const cfg: any = await read("get_config");
  const settlementDelay = Number(cfg.settlement_delay);
  const responseWindow = Number(cfg.response_window);
  const before = Number(cfg.trade_count);

  // ── 1. create ───────────────────────────────────────────────────────────
  sep("STEP 1 — buyer creates the trade (also proves the consensus clock)");
  const now = Math.floor(Date.now() / 1000);
  await writeAndSettle(
    buyer, "create_trade", "create_trade",
    [
      sellerAddr,
      "1,000 industrial pumps, model XP-200, Grade A",
      "XP-200",
      1000,
      VALUE,
      "Grade A per SGS inspection standard",
      "Lagos, Nigeria",
      "DEMO_REGISTRY",
      now + 900,                    // shipping deadline
      now + 1800,                   // delivery deadline
      600,                          // dispute window
      responseWindow + 300 + 900,   // resolution window: response + appeal + slack
      300,                          // appeal window (short, so the demo completes)
      true,
      ISSUES, REMEDIES, REQUIREMENTS,
    ],
    0n,
    async () => Number((await read("get_config") as any).trade_count) > before,
  );
  const tid = `TL-${1000 + before}`;
  console.log("  trade id:", tid);

  let t: any = await read("get_trade", [tid]);
  check("status is created", t.status === "created");
  check("agreed amount recorded as a TERM", t.agreed_amount === VALUE.toString());
  check("nothing deposited yet", t.deposited_amount === "0");

  const terms: any = await read("get_agreement_terms", [tid]);
  console.log("  agreed remedy table:");
  for (const x of terms.terms) console.log(`    ${x.issue.padEnd(18)} ${x.buyer_bps} bps`);
  check("remedies total 100% or less", terms.total_bps <= 10000, `${terms.total_bps} bps`);

  // ── 2. accept + fund ────────────────────────────────────────────────────
  sep("STEP 2 — seller accepts, buyer funds REAL escrow");
  await writeAndSettle(seller, "accept_trade", "accept_trade", [tid], 0n,
    async () => ((await read("get_trade", [tid])) as any).status === "accepted");

  const buyerBefore = await balanceOf(buyerAddr);
  await writeAndSettle(buyer, `fund_trade ${gen(VALUE)}`, "fund_trade", [tid], VALUE,
    async () => ((await read("get_trade", [tid])) as any).deposited_amount === VALUE.toString());
  const buyerAfterFund = await balanceOf(buyerAddr);
  check("buyer balance fell — GEN entered contract custody",
    buyerAfterFund < buyerBefore, `${buyerBefore} -> ${buyerAfterFund}`);

  sep("STEP 2b — underfunding must be refused");
  const under = await expectRevert(
    buyer, "underfund attempt", "fund_trade", [tid], VALUE / 2n,
    async () => ((await read("get_trade", [tid])) as any).deposited_amount === VALUE.toString(),
  );
  check("second/incorrect funding rejected, ledger unchanged", under);

  // ── 3. ship + deliver ───────────────────────────────────────────────────
  sep("STEP 3 — seller ships (binds the carrier reference) and delivery is recorded");
  await writeAndSettle(seller, "mark_shipped", "mark_shipped", [tid, CARRIER_REF], 0n,
    async () => ((await read("get_trade", [tid])) as any).status === "shipped");
  t = await read("get_trade", [tid]);
  check("carrier reference bound before any dispute exists",
    t.carrier_reference === CARRIER_REF, t.carrier_reference);

  // The seller must NOT be able to record delivery before the agreed delivery
  // deadline: doing so starts every clock that protects the buyer, and the
  // dispute window would expire while the cargo is still at sea.
  const earlyDelivery = await expectRevert(
    seller, "seller self-certifies delivery early", "mark_delivered", [tid], 0n,
    async () => ((await read("get_trade", [tid])) as any).status === "shipped",
  );
  check("the seller cannot self-certify delivery before the agreed deadline",
    earlyDelivery);

  await writeAndSettle(buyer, "buyer records delivery", "mark_delivered", [tid], 0n,
    async () => ((await read("get_trade", [tid])) as any).status === "delivered");

  // ── 4. evidence ─────────────────────────────────────────────────────────
  sep("STEP 4 — both sides file evidence, and provenance is enforced");
  await writeAndSettle(
    seller, "seller files inspection report", "submit_evidence",
    [tid, "inspection_report", "SUPPORTING", "a".repeat(64),
     "ipfs://QmInspectionReportXP200", "SGS pre-shipment inspection, Grade A"],
    0n,
    async () => Number(((await read("get_trade", [tid])) as any).evidence_count) >= 1,
  );
  await writeAndSettle(
    buyer, "buyer files a statement", "submit_evidence",
    [tid, "statement", "PARTY_CLAIM", "", "", "Units received are model XP-100, not XP-200."],
    0n,
    async () => Number(((await read("get_trade", [tid])) as any).evidence_count) >= 2,
  );

  const selfAuth = await expectRevert(
    seller, "seller self-declares AUTHORITATIVE", "submit_evidence",
    [tid, "customs_document", "AUTHORITATIVE", "b".repeat(64), "ipfs://x", "customs"],
    0n,
    async () => Number(((await read("get_trade", [tid])) as any).evidence_count) === 2,
  );
  check("a party cannot self-declare AUTHORITATIVE evidence", selfAuth);

  // ── 5. dispute ──────────────────────────────────────────────────────────
  sep("STEP 5 — buyer disputes conformity, seller responds");
  await writeAndSettle(
    buyer, "open_dispute", "open_dispute",
    [tid, "The goods do not match the agreed product specification: model XP-100 was delivered."],
    0n,
    async () => ((await read("get_trade", [tid])) as any).status === "disputed",
  );
  await writeAndSettle(
    seller, "respond_to_dispute", "respond_to_dispute",
    [tid, "The goods match the agreement; the inspection report certifies model XP-200 Grade A."],
    0n,
    async () => Number(((await read("get_dispute", [tid])) as any).responded_at) > 0,
  );

  // ── 6. freeze + adjudicate ──────────────────────────────────────────────
  sep("STEP 6 — evidence FREEZES and GenLayer adjudicates");
  await writeAndSettle(buyer, "begin_adjudication", "begin_adjudication", [tid], 0n,
    async () => ((await read("get_trade", [tid])) as any).status === "adjudicating");
  t = await read("get_trade", [tid]);
  check("evidence package frozen with a digest", t.frozen_digest.length === 64);

  const frozenOut = await expectRevert(
    buyer, "file evidence while frozen", "submit_evidence",
    [tid, "product_photograph", "SUPPORTING", "c".repeat(64), "ipfs://late", "late photo"],
    0n,
    async () => Number(((await read("get_trade", [tid])) as any).evidence_count) === 2,
  );
  check("frozen package cannot be added to", frozenOut);

  console.log("  running adjudication (nondeterministic; allow a few minutes)...");
  await writeAndSettle(buyer, "adjudicate", "adjudicate", [tid], 0n,
    async () => ((await read("get_trade", [tid])) as any).status !== "adjudicating",
    900_000);

  t = await read("get_trade", [tid]);
  const f: any = await read("get_findings", [tid]);
  console.log(`\n  decision  : ${t.decision}`);
  console.log(`  payout_bps: ${t.payout_bps}  (buyer's share, DERIVED)`);
  console.log(`  reason    : ${t.reason_code}`);
  console.log("  findings:");
  for (const x of f.findings) console.log(`    ${x.issue.padEnd(18)} ${x.result}`);

  if (t.status === "disputed") {
    console.log("\n  The panel returned no usable verdict, so nothing was decided —");
    console.log("  the fail-closed path. Escrow is untouched and the case stays open.");
    check("failing closed left the escrow intact", t.deposited_amount === VALUE.toString());
    check("nothing was decided", t.decision === "");
    sep("RESULT");
    console.log(`  trade ${tid} · failures ${failures}`);
    process.exit(failures > 0 ? 1 : 0);
  }

  check("a verdict was proposed", t.status === "verdict_proposed", t.status);
  check("every agreed issue has a finding", f.findings.length === ISSUES.length);

  // The decisive check: the payout equals the pre-agreed remedies for exactly
  // the issues found in breach. The panel never emitted a number.
  const breached = f.findings.filter((x: any) => x.result === "BREACH").map((x: any) => x.issue);
  const expectedBps = Math.min(
    10000,
    breached.reduce((acc: number, issue: string) => acc + REMEDIES[ISSUES.indexOf(issue)], 0),
  );
  check("payout_bps equals the agreed remedies for the breached issues",
    Number(t.payout_bps) === expectedBps,
    `breached [${breached.join(", ")}] -> expected ${expectedBps}, got ${t.payout_bps}`);

  // ── 7. finality ─────────────────────────────────────────────────────────
  sep("STEP 7 — the appeal window and the armed settlement delay");
  const earlyFinal = await expectRevert(
    buyer, "finalize during appeal window", "finalize", [tid], 0n,
    async () => ((await read("get_trade", [tid])) as any).status === "verdict_proposed",
  );
  check("finalization refused while the appeal window is open", earlyFinal);

  const appealDeadline = Number(t.appeal_deadline);
  let wait = Math.max(0, appealDeadline - Math.floor(Date.now() / 1000)) + 20;
  console.log(`  waiting ${wait}s for the appeal window to close...`);
  await sleep(wait * 1000);

  await writeAndSettle(buyer, "finalize", "finalize", [tid], 0n,
    async () => ((await read("get_trade", [tid])) as any).status === "finalized");

  const earlySettle = await expectRevert(
    buyer, "settle before the delay elapses", "settle", [tid], 0n,
    async () => ((await read("get_trade", [tid])) as any).deposited_amount === VALUE.toString(),
  );
  check("settlement refused while the delay is arming", earlySettle);

  t = await read("get_trade", [tid]);
  wait = Math.max(0, Number(t.settlement_unlock) - Math.floor(Date.now() / 1000)) + 20;
  console.log(`  waiting ${wait}s for the ${settlementDelay}s settlement delay...`);
  await sleep(wait * 1000);

  // ── 8. settle ───────────────────────────────────────────────────────────
  sep("STEP 8 — settlement: both WALLET BALANCES must actually move");
  const projected: any = await read("get_settlement", [tid]);
  console.log(`  contract projects buyer ${gen(BigInt(projected.buyer_amount))}, ` +
              `seller ${gen(BigInt(projected.seller_amount))}`);

  const bBefore = await balanceOf(buyerAddr);
  const sBefore = await balanceOf(sellerAddr);

  await writeAndSettle(buyer, "settle", "settle", [tid], 0n,
    async () => ((await read("get_trade", [tid])) as any).status === "settled",
    900_000);
  await sleep(20_000);      // the payout message executes on finalization

  const bAfter = await balanceOf(buyerAddr);
  const sAfter = await balanceOf(sellerAddr);
  const bDelta = bAfter - bBefore;
  const sDelta = sAfter - sBefore;

  console.log(`\n  buyer  ${bBefore} -> ${bAfter}  (delta ${bDelta})`);
  console.log(`  seller ${sBefore} -> ${sAfter}  (delta ${sDelta})`);

  check("buyer received exactly the contract's projected amount",
    bDelta === BigInt(projected.buyer_amount),
    `expected ${projected.buyer_amount}, got ${bDelta}`);
  check("seller received exactly the contract's projected amount",
    sDelta === BigInt(projected.seller_amount),
    `expected ${projected.seller_amount}, got ${sDelta}`);
  check("the two payouts reconstitute the escrow exactly",
    bDelta + sDelta === VALUE, `${bDelta} + ${sDelta} vs ${VALUE}`);

  t = await read("get_trade", [tid]);
  check("escrow ledger zeroed", t.deposited_amount === "0");
  check("trade is settled", t.status === "settled");

  // ── 9. double settle ────────────────────────────────────────────────────
  sep("STEP 9 — a second settlement must move nothing");
  const bBefore2 = await balanceOf(buyerAddr);
  const second = await expectRevert(
    buyer, "second settle", "settle", [tid], 0n,
    async () => ((await read("get_trade", [tid])) as any).deposited_amount === "0",
  );
  await sleep(15_000);
  const bAfter2 = await balanceOf(buyerAddr);
  check("second settlement rejected", second);
  check("no additional value left the contract", bAfter2 === bBefore2,
    `${bBefore2} -> ${bAfter2}`);

  sep("RESULT");
  console.log(`  trade    : ${tid}`);
  console.log(`  decision : ${t.decision} (${t.payout_bps} bps to the buyer)`);
  console.log(`  failures : ${failures}`);
  if (failures > 0) process.exit(1);
  console.log("\n  Full trade lifecycle proven against the deployed contract.");
}

main().catch((e) => {
  console.error("\nlifecycle failed:", e?.message ?? e);
  process.exit(1);
});
