/**
 * Unit tests for the pure logic behind the interface.
 *
 * Two things are worth pinning here and nowhere else:
 *
 *   1. Wei formatting. Every amount arrives as a decimal string and is handled
 *      as a BigInt, because parsing 10^18 into a Number silently loses
 *      precision — and an escrow interface that misreports a balance by a
 *      rounding error is worse than one that shows nothing.
 *
 *   2. Action gating. It mirrors the contract's guards, so it can drift from
 *      them. The live proof in scripts/prove_write_path.ts checks the two
 *      agree at each step of a real lifecycle; these check the table exhaustively
 *      without spending a request on a rate-limited endpoint.
 *
 * Run:  npm test
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bps, duration, gen, short, titleCase, toWei, until, utc } from "../src/lib/format.js";
import { actionsFor, roleOf, type Role } from "../src/lib/actions.js";
import type { Dispute, Trade, TradeStatus } from "../src/lib/contract.js";

/* ── format ─────────────────────────────────────────────────────────────── */

describe("gen()", () => {
  it("formats whole and fractional GEN", () => {
    assert.equal(gen("1000000000000000000"), "1");
    assert.equal(gen("500000000000000000"), "0.5");
    assert.equal(gen("1500000000000000000"), "1.5");
  });

  it("keeps precision far above Number.MAX_SAFE_INTEGER", () => {
    // 12345.678901234567891 GEN. Parsing this as a Number loses the tail; the
    // whole point of the BigInt path is that this digit survives.
    assert.equal(gen("12345678901234567891", 6), "12.345678");
    // And the integer part of a very large balance is exact.
    assert.equal(gen("123456789012345678901234567890", 0), "123,456,789,012");
  });

  it("trims trailing zeros rather than padding", () => {
    assert.equal(gen("100000000000000000"), "0.1");
    assert.equal(gen("2000000000000000000"), "2");
  });

  it("handles zero, empty and undefined without throwing", () => {
    assert.equal(gen("0"), "0");
    assert.equal(gen(""), "—");
    assert.equal(gen(undefined), "—");
    assert.equal(gen("not a number"), "—");
  });

  it("handles negatives", () => {
    assert.equal(gen("-500000000000000000"), "-0.5");
  });
});

describe("toWei()", () => {
  it("round-trips against gen()", () => {
    // gen() groups thousands for readability, so strip separators to compare.
    for (const v of ["0.5", "1", "1.5", "0.001", "1234.5678", "999999.000001"]) {
      assert.equal(gen(toWei(v).toString(), 18).replace(/,/g, ""), v);
    }
  });

  it("is exact at 18 decimal places", () => {
    assert.equal(toWei("0.000000000000000001"), 1n);
    assert.equal(toWei("1.000000000000000001"), 1000000000000000001n);
  });

  it("rejects rather than silently truncating", () => {
    assert.throws(() => toWei("0.0000000000000000001"), /18 decimal/);
    assert.throws(() => toWei("abc"), /number/);
    assert.throws(() => toWei(""), /number/);
    assert.throws(() => toWei("1.2.3"), /number/);
  });
});

describe("bps() and helpers", () => {
  it("renders basis points as a percentage", () => {
    assert.equal(bps(10000), "100%");
    assert.equal(bps(6500), "65%");
    assert.equal(bps(0), "0%");
    assert.equal(bps(1), "0.01%");
  });

  it("shortens addresses without losing the ends", () => {
    const a = "0xdD03B1A888a38e4C8b6f6CEE831DC9cd828d8102";
    assert.ok(short(a).startsWith("0xdD03"));
    assert.ok(short(a).endsWith("8102"));
    assert.equal(short(undefined), "—");
  });

  it("renders times as absolute UTC, never local", () => {
    assert.equal(utc("1787313600"), "2026-08-21 12:00:00 UTC");
    assert.equal(utc("0"), "not set");
  });

  it("renders durations coarsely above an hour", () => {
    assert.equal(duration(45), "45s");
    assert.equal(duration(3600), "1h 0m");
    assert.equal(duration(90000), "1d 1h");
    assert.equal(duration(-5), "0s");
  });

  it("signs the countdown so a passed deadline reads as passed", () => {
    assert.ok(until(1000, 500).startsWith("in "));
    assert.ok(until(500, 1000).endsWith(" ago"));
  });

  it("titleCases snake_case protocol values", () => {
    assert.equal(titleCase("inspection_report"), "Inspection Report");
  });
});

/* ── action gating ──────────────────────────────────────────────────────── */

const BUYER = "0x1111111111111111111111111111111111111111";
const SELLER = "0x2222222222222222222222222222222222222222";
const NOW = 1_800_000_000;

function trade(over: Partial<Trade> = {}): Trade {
  return {
    id: "TL-1000", buyer: BUYER, seller: SELLER,
    product_description: "goods", product_identifier: "X", quantity: 1,
    agreed_amount: "1000000000000000000", deposited_amount: "0",
    quality_requirements: "q", destination: "Lagos",
    carrier: "DEMO_REGISTRY", carrier_reference: "",
    shipping_deadline: String(NOW + 3600), delivery_deadline: String(NOW + 7200),
    shipped_at: "0", delivered_at: "0",
    dispute_window: "600", resolution_window: "300000", appeal_window: "3600",
    dispute_deadline: "0", response_deadline: "0", resolution_deadline: "0",
    appeal_deadline: "0", recovery_deadline: String(NOW + 999999),
    settlement_unlock: "0", settlement_delay: "300",
    inspection_required: true, status: "created",
    evidence_count: "0", issue_count: "2", appeal_count: "0", max_appeals: "2",
    adjudication_count: "0", frozen_digest: "", decision: "", payout_bps: "0",
    material_breach: false, reason_code: "",
    projected_buyer_amount: "0", projected_seller_amount: "0",
    buyer_paid: "0", seller_paid: "0",
    created_at: String(NOW), finalized_at: "0",
    ...over,
  };
}

const find = (t: Trade, role: Role, id: string, d: Dispute | null = null, now = NOW) =>
  actionsFor(t, d, role, now, true).find((a) => a.id === id);

describe("actionsFor()", () => {
  it("derives the role from the trade rather than trusting a caller", () => {
    const t = trade();
    assert.equal(roleOf(t, BUYER), "buyer");
    assert.equal(roleOf(t, SELLER), "seller");
    assert.equal(roleOf(t, "0x9999999999999999999999999999999999999999"), "observer");
    assert.equal(roleOf(t, null), "observer");
    assert.equal(roleOf(null, BUYER), "observer");
  });

  it("offers acceptance only to the named seller", () => {
    const t = trade({ status: "created" });
    assert.equal(find(t, "seller", "accept")?.enabled, true);
    assert.equal(find(t, "buyer", "accept")?.enabled, false);
    assert.equal(find(t, "observer", "accept")?.enabled, false);
  });

  it("never enables anything for a disconnected wallet", () => {
    const t = trade({ status: "created" });
    const acts = actionsFor(t, null, "seller", NOW, false);
    assert.ok(acts.length > 0, "actions are still SHOWN when disconnected");
    assert.ok(acts.every((a) => !a.enabled), "but none is enabled");
    assert.ok(acts.every((a) => a.reason.includes("Connect")));
  });

  it("always gives a reason when an action is disabled", () => {
    for (const status of ["created", "accepted", "funded", "shipped", "delivered",
                          "disputed", "adjudicating", "verdict_proposed",
                          "finalized"] as TradeStatus[]) {
      for (const role of ["buyer", "seller", "observer"] as Role[]) {
        for (const a of actionsFor(trade({ status }), null, role, NOW, true)) {
          if (!a.enabled) {
            assert.ok(a.reason.length > 0, `${status}/${role}/${a.id} disabled with no reason`);
          }
        }
      }
    }
  });

  it("refuses cancellation once anything is deposited", () => {
    assert.equal(find(trade({ status: "accepted" }), "buyer", "cancel")?.enabled, true);
    const funded = trade({ status: "accepted", deposited_amount: "1" });
    assert.equal(find(funded, "buyer", "cancel"), undefined);
  });

  it("lets only the buyer record delivery before the agreed deadline", () => {
    const t = trade({ status: "shipped" });
    assert.equal(find(t, "buyer", "deliver")?.enabled, true);
    const sellerGate = find(t, "seller", "deliver");
    assert.equal(sellerGate?.enabled, false);
    assert.match(sellerGate!.reason, /self-certify/);
  });

  it("lets the seller record delivery from the agreed deadline onward", () => {
    const t = trade({ status: "shipped" });
    assert.equal(find(t, "seller", "deliver", null, NOW + 7200)?.enabled, true);
  });

  it("stops the seller recording delivery once recovery has vested", () => {
    // Realistic ordering: recovery always falls AFTER the delivery deadline,
    // because the contract derives it from that deadline plus the windows and
    // the grace. An inverted fixture would trip the earlier guard instead and
    // quietly test nothing.
    const t = trade({
      status: "shipped",
      delivery_deadline: String(NOW + 100),
      recovery_deadline: String(NOW + 200),
    });
    // Inside the window the seller may act...
    assert.equal(find(t, "seller", "deliver", null, NOW + 150)?.enabled, true);
    // ...and once recovery vests, they may not.
    const gate = find(t, "seller", "deliver", null, NOW + 250);
    assert.equal(gate?.enabled, false);
    assert.match(gate!.reason, /recovery deadline/);
    // The buyer is never blocked by either bound.
    assert.equal(find(t, "buyer", "deliver", null, NOW + 250)?.enabled, true);
  });

  it("closes the dispute window on time", () => {
    const t = trade({ status: "delivered", dispute_deadline: String(NOW + 60) });
    assert.equal(find(t, "buyer", "dispute", null, NOW)?.enabled, true);
    assert.equal(find(t, "buyer", "dispute", null, NOW + 61)?.enabled, false);
  });

  it("refuses an appeal with no time left to hear it", () => {
    const t = trade({
      status: "verdict_proposed",
      appeal_deadline: String(NOW + 3600),
      resolution_deadline: String(NOW + 300), // less than MIN_ADJUDICATION_TIME
    });
    const gate = find(t, "buyer", "appeal");
    assert.equal(gate?.enabled, false);
    assert.match(gate!.reason, /not enough time/);
  });

  it("refuses an appeal once they are exhausted", () => {
    const t = trade({
      status: "verdict_proposed", appeal_count: "2",
      appeal_deadline: String(NOW + 3600), resolution_deadline: String(NOW + 999999),
    });
    assert.match(find(t, "buyer", "appeal")!.reason, /used all 2 appeals/);
  });

  it("refuses recovery on a delivered trade nobody disputed", () => {
    const t = trade({
      status: "delivered", deposited_amount: "1",
      dispute_deadline: String(NOW - 100), recovery_deadline: String(NOW - 50),
    });
    const gate = find(t, "buyer", "recover");
    assert.equal(gate?.enabled, false);
    assert.match(gate!.reason, /never disputed/);
  });

  it("allows recovery on a stalled dispute", () => {
    const t = trade({
      status: "disputed", deposited_amount: "1",
      dispute_deadline: String(NOW - 200), recovery_deadline: String(NOW - 50),
    });
    const dispute: Dispute = { exists: true, trade_id: "TL-1000", responded_at: "0" };
    assert.equal(find(t, "buyer", "recover", dispute)?.enabled, true);
  });

  it("never offers recovery to the seller", () => {
    const t = trade({
      status: "disputed", deposited_amount: "1",
      recovery_deadline: String(NOW - 50),
    });
    assert.equal(find(t, "seller", "recover")?.enabled, false);
  });

  it("keeps permissionless actions permissionless", () => {
    const finalize = trade({ status: "verdict_proposed", appeal_deadline: String(NOW - 10) });
    assert.equal(find(finalize, "observer", "finalize")?.enabled, true);

    const settle = trade({ status: "finalized", settlement_unlock: String(NOW - 10) });
    assert.equal(find(settle, "observer", "settle")?.enabled, true);
  });

  it("offers no STATE-CHANGING action on a terminal trade", () => {
    for (const status of ["settled", "cancelled"] as TradeStatus[]) {
      const enabled = actionsFor(trade({ status }), null, "buyer", NOW, true)
        .filter((a) => a.enabled)
        .map((a) => a.id);
      // `preview` is the deliberate exception: it runs the real retrieval and
      // the real panel and RETURNS the result, touching no state and no
      // balance. Probing a settled trade is exactly how an unreachable
      // authoritative source gets diagnosed after the fact.
      assert.deepEqual(
        enabled.filter((id) => id !== "preview"), [],
        `${status} offered a state-changing action`
      );
    }
    // And on a settled trade the probe IS still offered, on purpose.
    assert.equal(
      actionsFor(trade({ status: "settled" }), null, "observer", NOW, true)
        .find((a) => a.id === "preview")?.enabled,
      true
    );
    // A cancelled trade never had a case, so there is nothing to probe.
    assert.equal(
      actionsFor(trade({ status: "cancelled" }), null, "observer", NOW, true)
        .find((a) => a.id === "preview"),
      undefined
    );
  });
});
