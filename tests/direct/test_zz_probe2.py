"""Temporary probe 2 — appeal/round budget. Delete after reading."""
from .conftest import BREACH, CONFORMING, CARRIER_REF, DEFAULT_ISSUES, carrier_record, verdict


class TestProbe2:
    def test_one_transient_failure_plus_two_appeals_strands_the_verdict(self, desk):
        tid = desk.disputed_trade()
        desk.w.set_carrier(carrier_record(CARRIER_REF))

        # Round 1: a transient panel failure. Burns an adjudication round.
        desk.w.set_panel("garbage")
        desk.begin(tid)
        desk.adjudicate(tid)
        assert desk.trade(tid)["status"] == "disputed"
        assert desk.trade(tid)["adjudication_count"] == 1

        # Round 2: a clean seller win.
        desk.w.set_panel(verdict({i: CONFORMING for i in DEFAULT_ISSUES}))
        desk.begin(tid)
        desk.adjudicate(tid)
        t = desk.trade(tid)
        assert (t["status"], t["decision"], t["payout_bps"]) == (
            "verdict_proposed", "SELLER_WIN", 0)

        # The losing buyer appeals. Round 3 re-runs; say it confirms the seller.
        desk.appeal(tid, sender=desk.buyer)
        desk.adjudicate(tid)
        assert desk.trade(tid)["decision"] == "SELLER_WIN"
        assert desk.trade(tid)["adjudication_count"] == 3

        # The buyer appeals the second and last time. Status -> adjudicating.
        desk.appeal(tid, sender=desk.buyer)
        assert desk.trade(tid)["status"] == "adjudicating"

        # But no adjudication round is left. The verdict can never be reached.
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("exhausted its adjudication rounds"):
            desk.c.adjudicate(tid)

        # finalize needs verdict_proposed, which is now unreachable.
        desk.vm.sender = desk.outsider
        with desk.vm.expect_revert("no proposed verdict"):
            desk.c.finalize(tid)

        # ...so the escrow falls to the buyer in full, against the verdict.
        desk.past_recovery(tid)
        desk.vm.sender = desk.buyer
        desk.c.claim_timeout_refund(tid)
        t = desk.trade(tid)
        print("\nFINAL:", t["status"], t["decision"], t["payout_bps"],
              "buyer_paid", t["buyer_paid"], "seller_paid", t["seller_paid"])
        assert t["decision"] == "BUYER_WIN"
        assert t["seller_paid"] == "0"

    def test_a_failed_round_unfreezes_the_package_after_a_public_verdict(self, desk):
        tid = desk.disputed_trade()
        desk.w.set_carrier(carrier_record(CARRIER_REF))
        desk.w.set_panel(verdict({i: CONFORMING for i in DEFAULT_ISSUES}))
        desk.begin(tid)
        desk.adjudicate(tid)
        frozen_a = desk.evidence_of(tid)["frozen_digest"]
        # verdict + rationales are now public.
        assert desk.findings(tid)["findings"]

        desk.appeal(tid, sender=desk.buyer)
        desk.w.set_panel("garbage")           # round fails
        desk.adjudicate(tid)
        assert desk.trade(tid)["status"] == "disputed"
        assert desk.evidence_of(tid)["frozen"] is False

        # The losing party may now file NEW evidence, knowing the findings.
        desk.evidence(tid, sender=desk.buyer,
                      description="rebuttal drafted against the published rationale")
        desk.w.set_panel(verdict({i: BREACH for i in DEFAULT_ISSUES}))
        desk.begin(tid)
        frozen_b = desk.evidence_of(tid)["frozen_digest"]
        print("\nDIGEST A:", frozen_a[:16], "DIGEST B:", frozen_b[:16])
        assert frozen_a != frozen_b
        desk.adjudicate(tid)
        assert desk.trade(tid)["payout_bps"] == 10000
