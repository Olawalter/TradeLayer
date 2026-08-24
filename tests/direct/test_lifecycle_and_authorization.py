"""Trade creation, the state machine, and who is allowed to do what.

Covers the §36 authorization matrix and the legitimate cancellation path.
Every state transition is asserted against contract state, never against a
return value alone.
"""

from .conftest import (
    DEFAULT_ISSUES, DEFAULT_REMEDIES, DEFAULT_REQUIREMENTS, GEN, TRADE_VALUE, to_hex,
)


# ─── Creation ────────────────────────────────────────────────────────────────

class TestCreateTrade:
    def test_creates_a_trade_awaiting_acceptance(self, desk):
        tid = desk.create()
        t = desk.trade(tid)
        assert tid == "TL-1000"
        assert t["status"] == "created"
        assert t["buyer"].lower() == desk.buyer_hex
        assert t["seller"].lower() == desk.seller_hex
        assert t["agreed_amount"] == str(TRADE_VALUE)
        # A term is not custody: nothing is deposited yet.
        assert t["deposited_amount"] == "0"

    def test_records_the_agreed_remedy_table(self, desk):
        tid = desk.create()
        terms = desk.terms(tid)
        assert [x["issue"] for x in terms["terms"]] == DEFAULT_ISSUES
        assert [x["buyer_bps"] for x in terms["terms"]] == DEFAULT_REMEDIES
        assert terms["total_bps"] == 10000

    def test_deadlines_start_unset_and_are_absolute_when_set(self, desk):
        """resolution_deadline is ALWAYS an absolute timestamp or zero — never a
        duration masquerading as one."""
        window = 4 * 24 * 3600
        tid = desk.create(resolution_window=window)
        t = desk.trade(tid)
        assert t["dispute_deadline"] == "0"
        assert t["response_deadline"] == "0"
        assert t["resolution_deadline"] == "0"
        assert t["resolution_window"] == str(window)

    def test_buyer_cannot_be_their_own_seller(self, desk):
        with desk.vm.expect_revert("must be different accounts"):
            desk.create(seller=desk.buyer)

    def test_rejects_empty_product_description(self, desk):
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("product description is required"):
            desk.c.create_trade(
                to_hex(desk.seller), "   ", "XP-200", 1000, TRADE_VALUE, "q", "Lagos",
                "DEMO_REGISTRY", desk.w.now + 3600, desk.w.now + 7200, 3600,
                4 * 24 * 3600, 3600, True, list(DEFAULT_ISSUES), list(DEFAULT_REMEDIES), list(DEFAULT_REQUIREMENTS))

    def test_rejects_zero_quantity(self, desk):
        with desk.vm.expect_revert("quantity must be positive"):
            desk.create(quantity=0)

    def test_rejects_dust_trade_value(self, desk):
        with desk.vm.expect_revert("below the minimum"):
            desk.create(value=100)

    def test_rejects_unknown_carrier(self, desk):
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("carrier must be one of"):
            desk.c.create_trade(
                to_hex(desk.seller), "pumps", "XP-200", 1000, TRADE_VALUE, "q", "Lagos",
                "NOT_A_CARRIER", desk.w.now + 3600, desk.w.now + 7200, 3600,
                4 * 24 * 3600, 3600, True, list(DEFAULT_ISSUES), list(DEFAULT_REMEDIES), list(DEFAULT_REQUIREMENTS))

    def test_rejects_delivery_before_shipping(self, desk):
        with desk.vm.expect_revert("delivery deadline must follow"):
            desk.create(ship_in=7200, deliver_in=3600)

    def test_rejects_a_shipping_deadline_in_the_past(self, desk):
        with desk.vm.expect_revert("meaningfully in the future"):
            desk.create(ship_in=10)


class TestRemedyTableValidation:
    """The remedy table is what makes settlement arithmetic safe, so it is
    validated hard at creation — the only place it can ever be set."""

    def test_rejects_remedies_totalling_over_100_percent(self, desk):
        with desk.vm.expect_revert("total more than 100%"):
            desk.create(remedies=[6500, 2000, 1000, 1000])   # 10500

    def test_accepts_remedies_totalling_exactly_100_percent(self, desk):
        tid = desk.create(remedies=[6500, 2000, 1000, 500])
        assert desk.terms(tid)["total_bps"] == 10000

    def test_accepts_remedies_totalling_under_100_percent(self, desk):
        tid = desk.create(remedies=[1000, 500, 500, 500])
        assert desk.terms(tid)["total_bps"] == 2500

    def test_rejects_zero_and_negative_remedies(self, desk):
        with desk.vm.expect_revert("between 1 and 10000 bps"):
            desk.create(remedies=[0, 2000, 1000, 500])

    def test_rejects_a_remedy_above_the_denominator(self, desk):
        with desk.vm.expect_revert("between 1 and 10000 bps"):
            desk.create(remedies=[10001, 1, 1, 1])

    def test_rejects_unknown_issue(self, desk):
        with desk.vm.expect_revert("unknown issue"):
            desk.create(issues=["NOT_AN_ISSUE"], remedies=[1000], requirements=["x"])

    def test_rejects_duplicate_issues(self, desk):
        with desk.vm.expect_revert("duplicate issue"):
            desk.create(issues=["QUANTITY", "QUANTITY"], remedies=[1000, 1000],
                        requirements=["a", "b"])

    def test_rejects_mismatched_table_lengths(self, desk):
        with desk.vm.expect_revert("each issue needs a remedy"):
            desk.create(issues=["QUANTITY"], remedies=[1000, 2000], requirements=["a"])

    def test_rejects_an_empty_issue_list(self, desk):
        with desk.vm.expect_revert("must declare 1.."):
            desk.create(issues=[], remedies=[], requirements=[])

    def test_rejects_an_issue_with_no_stated_requirement(self, desk):
        with desk.vm.expect_revert("stated requirement"):
            desk.create(issues=["QUANTITY"], remedies=[1000], requirements=["  "])

    def test_no_setter_exists_for_the_remedy_table(self, desk):
        """The table is agreed before money moves and is immutable after."""
        for name in ("set_remedies", "update_terms", "set_issue", "amend_trade",
                     "set_payout", "set_decision", "set_status", "withdraw",
                     "admin", "force_settle", "sweep"):
            assert not hasattr(desk.c, name), f"unexpected privileged method: {name}"


# ─── Acceptance and the state machine ────────────────────────────────────────

class TestStateMachine:
    def test_seller_accepts(self, desk):
        tid = desk.create()
        desk.accept(tid)
        assert desk.trade(tid)["status"] == "accepted"

    def test_only_the_named_seller_may_accept(self, desk):
        tid = desk.create()
        desk.vm.sender = desk.outsider
        with desk.vm.expect_revert("only the named seller"):
            desk.c.accept_trade(tid)

    def test_buyer_cannot_accept_their_own_trade(self, desk):
        tid = desk.create()
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("only the named seller"):
            desk.c.accept_trade(tid)

    def test_cannot_accept_twice(self, desk):
        tid = desk.create()
        desk.accept(tid)
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("no longer awaiting acceptance"):
            desk.c.accept_trade(tid)

    def test_cannot_fund_before_acceptance(self, desk):
        tid = desk.create()
        desk.vm.sender = desk.buyer
        desk.vm.value = TRADE_VALUE
        try:
            with desk.vm.expect_revert("must accept before"):
                desk.c.fund_trade(tid)
        finally:
            desk.vm.value = 0

    def test_cannot_ship_before_funding(self, desk):
        tid = desk.create()
        desk.accept(tid)
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("must be funded before shipment"):
            desk.c.mark_shipped(tid, "MAEU-1")

    def test_cannot_deliver_before_shipping(self, desk):
        tid = desk.funded_trade()
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("must be shipped first"):
            desk.c.mark_delivered(tid)

    def test_cannot_dispute_before_delivery(self, desk):
        tid = desk.funded_trade()
        desk.ship(tid)
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("only be opened on a delivered trade"):
            desk.c.open_dispute(tid, "claim about the goods")

    def test_the_happy_path_walks_every_state(self, desk):
        tid = desk.create()
        assert desk.trade(tid)["status"] == "created"
        desk.accept(tid)
        assert desk.trade(tid)["status"] == "accepted"
        desk.fund(tid)
        assert desk.trade(tid)["status"] == "funded"
        desk.ship(tid)
        assert desk.trade(tid)["status"] == "shipped"
        desk.deliver(tid)
        assert desk.trade(tid)["status"] == "delivered"
        desk.dispute(tid)
        assert desk.trade(tid)["status"] == "disputed"

    def test_shipment_binds_the_carrier_reference(self, desk):
        tid = desk.funded_trade()
        desk.ship(tid, ref="maeu 4471 2026")
        t = desk.trade(tid)
        # Normalized: uppercase, whitespace stripped.
        assert t["carrier_reference"] == "MAEU44712026"

    def test_a_carrier_reference_is_mandatory(self, desk):
        tid = desk.funded_trade()
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("carrier reference of at least"):
            desk.c.mark_shipped(tid, "ab")

    def test_no_setter_exists_to_change_the_carrier_reference(self, desk):
        """The reference is bound before any dispute exists — that is what stops
        a disputing party pointing the lookup somewhere convenient later."""
        tid = desk.funded_trade()
        desk.ship(tid)
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("must be funded before shipment"):
            desk.c.mark_shipped(tid, "MAEU-DIFFERENT-REF")
        assert desk.trade(tid)["carrier_reference"] == "MAEU-4471-2026"


# ─── Authorization ───────────────────────────────────────────────────────────

class TestAuthorization:
    def test_outsider_cannot_fund(self, desk):
        tid = desk.create()
        desk.accept(tid)
        desk.vm.sender = desk.outsider
        desk.vm.value = TRADE_VALUE
        try:
            with desk.vm.expect_revert("only the buyer funds"):
                desk.c.fund_trade(tid)
        finally:
            desk.vm.value = 0

    def test_seller_cannot_fund(self, desk):
        tid = desk.create()
        desk.accept(tid)
        desk.vm.sender = desk.seller
        desk.vm.value = TRADE_VALUE
        try:
            with desk.vm.expect_revert("only the buyer funds"):
                desk.c.fund_trade(tid)
        finally:
            desk.vm.value = 0

    def test_only_the_seller_may_mark_shipped(self, desk):
        tid = desk.funded_trade()
        for who in (desk.buyer, desk.outsider):
            desk.vm.sender = who
            with desk.vm.expect_revert("only the seller may mark"):
                desk.c.mark_shipped(tid, "MAEU-1234")

    def test_outsider_cannot_record_delivery(self, desk):
        tid = desk.funded_trade()
        desk.ship(tid)
        desk.vm.sender = desk.outsider
        with desk.vm.expect_revert("only a trade party may record delivery"):
            desk.c.mark_delivered(tid)

    def test_only_the_buyer_may_open_a_dispute(self, desk):
        tid = desk.delivered_trade()
        for who in (desk.seller, desk.outsider):
            desk.vm.sender = who
            with desk.vm.expect_revert("only the buyer may open a dispute"):
                desk.c.open_dispute(tid, "a claim about the goods")

    def test_only_the_seller_may_respond(self, desk):
        tid = desk.delivered_trade()
        desk.dispute(tid)
        for who in (desk.buyer, desk.outsider):
            desk.vm.sender = who
            with desk.vm.expect_revert("only the seller may respond"):
                desk.c.respond_to_dispute(tid, "a response")

    def test_outsider_cannot_submit_evidence(self, desk):
        tid = desk.funded_trade()
        desk.vm.sender = desk.outsider
        with desk.vm.expect_revert("only a trade party may submit evidence"):
            desk.c.submit_evidence(tid, "inspection_report", "SUPPORTING",
                                   "a" * 64, "ipfs://x", "report")

    def test_outsider_cannot_appeal(self, desk):
        tid = desk.adjudicated_trade()
        desk.vm.sender = desk.outsider
        with desk.vm.expect_revert("only a trade party may appeal"):
            desk.c.submit_appeal(tid)

    def test_only_the_buyer_may_claim_a_timeout_refund(self, desk):
        tid = desk.funded_trade()
        desk.past_recovery(tid)
        for who in (desk.seller, desk.outsider):
            desk.vm.sender = who
            with desk.vm.expect_revert("only the buyer may claim"):
                desk.c.claim_timeout_refund(tid)

    def test_settlement_is_permissionless(self, desk, transfers):
        """Money must not depend on a counterparty staying interested."""
        tid = desk.adjudicated_trade()
        desk.past_appeal(tid)
        desk.vm.sender = desk.outsider
        desk.c.finalize(tid)
        desk.past_settlement(tid)
        desk.vm.sender = desk.outsider
        desk.c.settle(tid)
        assert desk.trade(tid)["status"] == "settled"
        assert sum(x["value"] for x in transfers) == TRADE_VALUE

    def test_unknown_trade_reverts(self, desk):
        with desk.vm.expect_revert("trade not found"):
            desk.c.get_trade("TL-9999")


# ─── Cancellation ────────────────────────────────────────────────────────────

class TestCancellation:
    def test_either_party_may_cancel_before_funding(self, desk):
        for who in (desk.buyer, desk.seller):
            tid = desk.create()
            desk.accept(tid)
            desk.vm.sender = who
            desk.c.cancel_trade(tid)
            assert desk.trade(tid)["status"] == "cancelled"

    def test_cancellation_is_impossible_once_escrow_is_funded(self, desk):
        tid = desk.funded_trade()
        for who in (desk.buyer, desk.seller):
            desk.vm.sender = who
            with desk.vm.expect_revert("escrow is funded"):
                desk.c.cancel_trade(tid)

    def test_outsider_cannot_cancel(self, desk):
        tid = desk.create()
        desk.vm.sender = desk.outsider
        with desk.vm.expect_revert("only a trade party may cancel"):
            desk.c.cancel_trade(tid)

    def test_cancelled_trade_cannot_be_funded(self, desk):
        tid = desk.create()
        desk.accept(tid)
        desk.vm.sender = desk.buyer
        desk.c.cancel_trade(tid)
        desk.vm.sender = desk.buyer
        desk.vm.value = TRADE_VALUE
        try:
            with desk.vm.expect_revert("must accept before"):
                desk.c.fund_trade(tid)
        finally:
            desk.vm.value = 0

    def test_cancellation_moves_no_money(self, desk, transfers):
        tid = desk.create()
        desk.accept(tid)
        desk.vm.sender = desk.buyer
        desk.c.cancel_trade(tid)
        assert transfers == []


# ─── Listing and passport ────────────────────────────────────────────────────

class TestViews:
    def test_listing_is_paged(self, desk):
        for _ in range(3):
            desk.create()
        page = desk.c.list_trades(1, 1)
        assert page["total"] == 3 and page["count"] == 1
        assert page["items"][0]["id"] == "TL-1001"

    def test_both_parties_see_the_trade_in_their_index(self, desk):
        tid = desk.create()
        assert tid in desk.c.get_party_trades(to_hex(desk.buyer))
        assert tid in desk.c.get_party_trades(to_hex(desk.seller))
        assert desk.c.get_party_trades(to_hex(desk.outsider)) == []

    def test_config_publishes_the_governing_parameters(self, desk):
        cfg = desk.c.get_config()
        assert "PRODUCT_MODEL" in cfg["issues"]
        assert cfg["bps_denominator"] == 10000
        assert cfg["settlement_delay"] > 0
        assert cfg["max_appeals"] >= 1
        assert "AUTHORITATIVE" in cfg["tiers"]

    def test_passport_counts_trades_for_both_parties(self, desk):
        desk.create()
        assert desk.passport(desk.buyer)["trades"] == 1
        assert desk.passport(desk.seller)["trades"] == 1
        assert desk.passport(desk.outsider)["trades"] == 0
