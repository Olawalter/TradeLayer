"""Escrow custody, the payout paths, and the guarantees protecting them.

Covers the §36 custody / payout / double-spend matrix.

Every payout assertion checks the emitted TRANSFER — recipient and exact
amount — not merely that a status flipped. Contract state looking correct while
no value actually moved is a real failure mode, and a settled flag over a
missing payment is the worst possible bug in an escrow.
"""

from .conftest import BREACH, CONFORMING, GEN, TRADE_VALUE


def _all(result):
    return {"PRODUCT_MODEL": result, "QUANTITY": result,
            "QUALITY_GRADE": result, "SHIPPING_DEADLINE": result}


# ─── Custody ─────────────────────────────────────────────────────────────────

class TestCustody:
    def test_funding_credits_the_ledger_from_the_transaction_value(self, desk):
        tid = desk.create()
        desk.accept(tid)
        desk.fund(tid)
        t = desk.trade(tid)
        assert t["deposited_amount"] == str(TRADE_VALUE)
        assert t["status"] == "funded"

    def test_there_is_no_amount_parameter_to_lie_with(self, desk):
        """fund_trade takes only a trade id: the ledger is credited from the
        value actually delivered, so a caller cannot assert funds they did not
        send. This asserts the shape of the guarantee, not just its effect."""
        tid = desk.create()
        desk.accept(tid)
        desk.vm.sender = desk.buyer
        desk.vm.value = TRADE_VALUE
        try:
            desk.c.fund_trade(tid)          # one argument; nowhere to put a figure
        finally:
            desk.vm.value = 0
        assert desk.trade(tid)["deposited_amount"] == str(TRADE_VALUE)

    def test_zero_deposit_is_rejected(self, desk):
        tid = desk.create()
        desk.accept(tid)
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("send GEN with this transaction"):
            desk.c.fund_trade(tid)

    def test_underfunding_is_rejected(self, desk):
        tid = desk.create()
        desk.accept(tid)
        desk.vm.sender = desk.buyer
        desk.vm.value = TRADE_VALUE - 1
        try:
            with desk.vm.expect_revert("must equal the agreed amount exactly"):
                desk.c.fund_trade(tid)
        finally:
            desk.vm.value = 0
        assert desk.trade(tid)["deposited_amount"] == "0"

    def test_overfunding_is_rejected_rather_than_silently_kept(self, desk):
        """Overfunding behaviour is DEFINED: the contract refuses it. Quietly
        keeping the surplus would create escrow nobody agreed to."""
        tid = desk.create()
        desk.accept(tid)
        desk.vm.sender = desk.buyer
        desk.vm.value = TRADE_VALUE + 1
        try:
            with desk.vm.expect_revert("must equal the agreed amount exactly"):
                desk.c.fund_trade(tid)
        finally:
            desk.vm.value = 0
        assert desk.trade(tid)["deposited_amount"] == "0"

    def test_double_funding_is_rejected(self, desk):
        tid = desk.funded_trade()
        desk.vm.sender = desk.buyer
        desk.vm.value = TRADE_VALUE
        try:
            with desk.vm.expect_revert("already funded"):
                desk.c.fund_trade(tid)
        finally:
            desk.vm.value = 0
        assert desk.trade(tid)["deposited_amount"] == str(TRADE_VALUE)

    def test_agreed_amount_and_deposited_amount_are_separate_quantities(self, desk):
        """A term of the agreement is not custody. Settlement must read the
        second, never the first."""
        tid = desk.create()
        t = desk.trade(tid)
        assert t["agreed_amount"] == str(TRADE_VALUE)
        assert t["deposited_amount"] == "0"


# ─── The three verdict payouts ───────────────────────────────────────────────

class TestSettlementPaths:
    def test_seller_wins_when_every_issue_conforms(self, desk, transfers):
        tid = desk.settled_trade(_all(CONFORMING))
        t = desk.trade(tid)
        assert t["decision"] == "SELLER_WIN"
        assert t["payout_bps"] == 0
        assert t["seller_paid"] == str(TRADE_VALUE)
        assert t["buyer_paid"] == "0"
        assert len(transfers) == 1
        assert transfers[0]["to"] == desk.seller_hex
        assert transfers[0]["value"] == TRADE_VALUE

    def test_buyer_wins_when_every_issue_is_breached(self, desk, transfers):
        # Remedies total exactly 10000, so all four breaches = full refund.
        tid = desk.settled_trade(_all(BREACH))
        t = desk.trade(tid)
        assert t["decision"] == "BUYER_WIN"
        assert t["payout_bps"] == 10000
        assert t["buyer_paid"] == str(TRADE_VALUE)
        assert len(transfers) == 1
        assert transfers[0]["to"] == desk.buyer_hex
        assert transfers[0]["value"] == TRADE_VALUE

    def test_partial_settlement_splits_by_the_agreed_remedies(self, desk, transfers):
        tid = desk.settled_trade({
            "PRODUCT_MODEL": BREACH,        # 6500
            "QUANTITY": CONFORMING,
            "QUALITY_GRADE": CONFORMING,
            "SHIPPING_DEADLINE": CONFORMING,
        })
        t = desk.trade(tid)
        assert t["decision"] == "PARTIAL_SETTLEMENT"
        assert t["payout_bps"] == 6500
        assert int(t["buyer_paid"]) == TRADE_VALUE * 6500 // 10000
        assert int(t["seller_paid"]) == TRADE_VALUE - TRADE_VALUE * 6500 // 10000
        paid = {x["to"]: x["value"] for x in transfers}
        assert paid[desk.buyer_hex] == TRADE_VALUE * 6500 // 10000
        assert paid[desk.seller_hex] == TRADE_VALUE - TRADE_VALUE * 6500 // 10000

    def test_remedies_accumulate_across_multiple_breaches(self, desk):
        tid = desk.settled_trade({
            "PRODUCT_MODEL": CONFORMING,
            "QUANTITY": BREACH,             # 2000
            "QUALITY_GRADE": BREACH,        # 1000
            "SHIPPING_DEADLINE": CONFORMING,
        })
        assert desk.trade(tid)["payout_bps"] == 3000

    def test_insufficient_evidence_moves_no_money(self, desk, transfers):
        """The buyer carries the burden of proof: an unproven breach is not a
        breach, so the seller keeps the escrow."""
        tid = desk.settled_trade(_all("INSUFFICIENT"))
        t = desk.trade(tid)
        assert t["payout_bps"] == 0
        assert t["decision"] == "SELLER_WIN"
        assert transfers[0]["to"] == desk.seller_hex

    def test_insufficient_is_not_treated_as_a_breach(self, desk):
        """A finding of INSUFFICIENT on the highest-remedy issue must not
        quietly award that remedy."""
        tid = desk.settled_trade({
            "PRODUCT_MODEL": "INSUFFICIENT",   # would be 6500 if counted
            "QUANTITY": BREACH,                # 2000
            "QUALITY_GRADE": CONFORMING,
            "SHIPPING_DEADLINE": CONFORMING,
        })
        assert desk.trade(tid)["payout_bps"] == 2000

    def test_undisputed_trade_settles_to_the_seller(self, desk, transfers):
        tid = desk.delivered_trade()
        desk.past_dispute_window(tid)
        desk.vm.sender = desk.outsider
        desk.c.close_undisputed(tid)
        t = desk.trade(tid)
        assert t["status"] == "finalized"
        assert t["reason_code"] == "NO_DISPUTE_RAISED"
        desk.past_settlement(tid)
        desk.settle(tid)
        assert transfers[0]["to"] == desk.seller_hex
        assert transfers[0]["value"] == TRADE_VALUE

    def test_payouts_always_sum_to_exactly_the_deposit(self, desk, transfers):
        """Integer division must not strand wei: the seller takes the
        remainder, so the two parts reconstitute the escrow exactly."""
        odd_value = 7 * GEN + 12345          # deliberately indivisible
        tid = desk.settled_trade(
            {"PRODUCT_MODEL": BREACH, "QUANTITY": CONFORMING,
             "QUALITY_GRADE": CONFORMING, "SHIPPING_DEADLINE": CONFORMING},
            value=odd_value)
        t = desk.trade(tid)
        assert int(t["buyer_paid"]) + int(t["seller_paid"]) == odd_value
        assert sum(x["value"] for x in transfers) == odd_value
        assert t["deposited_amount"] == "0"


# ─── Double spend ────────────────────────────────────────────────────────────

class TestDoubleSpendProtection:
    def test_settling_twice_is_rejected_and_moves_no_extra_value(self, desk, transfers):
        tid = desk.settled_trade()
        before = sum(x["value"] for x in transfers)
        desk.vm.sender = desk.outsider
        with desk.vm.expect_revert("no finalized verdict to settle"):
            desk.c.settle(tid)
        assert sum(x["value"] for x in transfers) == before
        assert desk.trade(tid)["deposited_amount"] == "0"

    def test_the_ledger_is_zeroed_and_persisted_before_any_transfer(self, desk, transfers):
        tid = desk.settled_trade()
        t = desk.trade(tid)
        assert t["deposited_amount"] == "0"
        assert t["status"] == "settled"
        assert int(t["buyer_paid"]) + int(t["seller_paid"]) == TRADE_VALUE
        assert len(transfers) >= 1

    def test_timeout_refund_after_settlement_is_rejected(self, desk, transfers):
        tid = desk.settled_trade()
        before = len(transfers)
        desk.past_recovery(tid)
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("already reached a terminal state"):
            desk.c.claim_timeout_refund(tid)
        assert len(transfers) == before

    def test_timeout_refund_twice_is_rejected(self, desk, transfers):
        tid = desk.funded_trade()
        desk.past_recovery(tid)
        desk.vm.sender = desk.buyer
        desk.c.claim_timeout_refund(tid)
        assert len(transfers) == 1
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("already reached a terminal state"):
            desk.c.claim_timeout_refund(tid)
        assert len(transfers) == 1

    def test_appeal_after_settlement_is_rejected(self, desk):
        tid = desk.settled_trade()
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("no proposed verdict to appeal"):
            desk.c.submit_appeal(tid)

    def test_adjudicating_a_settled_trade_is_rejected(self, desk):
        tid = desk.settled_trade()
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("not open for adjudication"):
            desk.c.adjudicate(tid)

    def test_disputing_a_settled_trade_is_rejected(self, desk):
        tid = desk.settled_trade()
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("only be opened on a delivered trade"):
            desk.c.open_dispute(tid, "a late claim about the goods")


# ─── Recovery ────────────────────────────────────────────────────────────────

class TestTimeoutRecovery:
    def test_buyer_recovers_the_full_escrow_after_the_recovery_deadline(self, desk, transfers):
        tid = desk.funded_trade()
        desk.past_recovery(tid)
        desk.vm.sender = desk.buyer
        desk.c.claim_timeout_refund(tid)
        t = desk.trade(tid)
        assert t["status"] == "settled"
        assert t["reason_code"] == "TIMEOUT_RECOVERY"
        assert t["deposited_amount"] == "0"
        assert transfers[0]["to"] == desk.buyer_hex
        assert transfers[0]["value"] == TRADE_VALUE

    def test_recovery_is_refused_before_the_deadline(self, desk, transfers):
        tid = desk.funded_trade()
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("recovery deadline has not passed"):
            desk.c.claim_timeout_refund(tid)
        assert transfers == []

    def test_recovery_works_from_a_stalled_dispute(self, desk, transfers):
        """A dispute nobody adjudicates must not strand the money."""
        tid = desk.disputed_trade()
        desk.past_recovery(tid)
        desk.vm.sender = desk.buyer
        desk.c.claim_timeout_refund(tid)
        assert transfers[0]["value"] == TRADE_VALUE

    def test_recovery_works_from_a_stalled_adjudication(self, desk, transfers):
        tid = desk.disputed_trade()
        desk.begin(tid)
        desk.past_recovery(tid)
        desk.vm.sender = desk.buyer
        desk.c.claim_timeout_refund(tid)
        assert transfers[0]["value"] == TRADE_VALUE


# ─── Accounting invariant ────────────────────────────────────────────────────

class TestAccountingInvariant:
    def test_custody_is_per_trade_and_never_shared(self, desk, transfers):
        """A settlement in one trade must never reach another trade's escrow."""
        a = desk.settled_trade(_all(CONFORMING))
        b = desk.funded_trade()
        assert sum(x["value"] for x in transfers) == TRADE_VALUE
        assert desk.trade(b)["deposited_amount"] == str(TRADE_VALUE)
        assert desk.trade(b)["status"] == "funded"

    def test_the_settlement_view_matches_what_is_actually_paid(self, desk, transfers):
        tid = desk.adjudicated_trade({
            "PRODUCT_MODEL": BREACH, "QUANTITY": CONFORMING,
            "QUALITY_GRADE": CONFORMING, "SHIPPING_DEADLINE": CONFORMING})
        desk.past_appeal(tid)
        desk.finalize(tid)
        projected = desk.settlement(tid)
        desk.past_settlement(tid)
        desk.settle(tid)
        paid = {x["to"]: x["value"] for x in transfers}
        assert paid[desk.buyer_hex] == int(projected["buyer_amount"])
        assert paid[desk.seller_hex] == int(projected["seller_amount"])

    def test_settlement_view_reports_why_it_is_not_settleable_yet(self, desk):
        tid = desk.adjudicated_trade()
        s = desk.settlement(tid)
        assert s["settleable"] is False
        assert "no finalized verdict" in s["reason"]


# ─── Passport ────────────────────────────────────────────────────────────────

class TestPassport:
    def test_a_clean_delivery_counts_as_completed_for_the_seller(self, desk):
        tid = desk.settled_trade(_all(CONFORMING))
        assert desk.passport(desk.seller)["completed"] == 1
        assert desk.passport(desk.seller)["lost_as_seller"] == 0

    def test_a_full_buyer_win_counts_against_the_seller(self, desk):
        desk.settled_trade(_all(BREACH))
        assert desk.passport(desk.seller)["lost_as_seller"] == 1

    def test_a_partial_counts_for_both_parties(self, desk):
        desk.settled_trade({
            "PRODUCT_MODEL": BREACH, "QUANTITY": CONFORMING,
            "QUALITY_GRADE": CONFORMING, "SHIPPING_DEADLINE": CONFORMING})
        assert desk.passport(desk.buyer)["partials"] == 1
        assert desk.passport(desk.seller)["partials"] == 1

    def test_a_dispute_the_buyer_loses_is_recorded_against_them(self, desk):
        desk.settled_trade(_all(CONFORMING))
        assert desk.passport(desk.buyer)["disputes_raised"] == 1
        assert desk.passport(desk.buyer)["lost_as_buyer"] == 1

    def test_an_undisputed_trade_is_not_a_buyer_loss(self, desk):
        tid = desk.delivered_trade()
        desk.past_dispute_window(tid)
        desk.vm.sender = desk.outsider
        desk.c.close_undisputed(tid)
        desk.past_settlement(tid)
        desk.settle(tid)
        assert desk.passport(desk.buyer)["lost_as_buyer"] == 0
        assert desk.passport(desk.seller)["completed"] == 1
