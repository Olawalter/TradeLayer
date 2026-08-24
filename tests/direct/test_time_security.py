"""Every deadline, and the clock that enforces them.

Covers the §30 time-security matrix. Two properties matter throughout:

  * an action offered after its window has closed must be REFUSED by the
    contract, not merely hidden by a frontend;
  * the clock itself must fail closed — but must not be freezable by ordinary
    conditions like a lagging block explorer.

On the clock fixtures specifically: every other test in this repo runs with the
chain indexer lagging 1250s, deliberately more than the 300s tolerance, because
that is the everyday production condition. Sibling projects shipped a "live
clock" that was dead on arrival precisely because their fixtures served every
time source from one fake clock, so the sources always agreed and the guards
could never fire.
"""

from .conftest import CONFORMING, DEFAULT_ISSUES, TRADE_VALUE, carrier_record, verdict


# ─── Deadlines ───────────────────────────────────────────────────────────────

class TestDisputeWindow:
    def test_a_dispute_inside_the_window_is_accepted(self, desk):
        tid = desk.delivered_trade(dispute_window=3600)
        desk.w.advance(1800)
        desk.dispute(tid)
        assert desk.trade(tid)["status"] == "disputed"

    def test_a_dispute_after_the_window_is_refused(self, desk):
        tid = desk.delivered_trade(dispute_window=3600)
        desk.past_dispute_window(tid)
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("dispute window has closed"):
            desk.c.open_dispute(tid, "a late claim about the goods")

    def test_the_undisputed_close_is_refused_while_the_window_is_open(self, desk):
        tid = desk.delivered_trade()
        desk.vm.sender = desk.outsider
        with desk.vm.expect_revert("dispute window is still open"):
            desk.c.close_undisputed(tid)

    def test_the_undisputed_close_is_accepted_once_the_window_shuts(self, desk):
        tid = desk.delivered_trade()
        desk.past_dispute_window(tid)
        desk.vm.sender = desk.outsider
        desk.c.close_undisputed(tid)
        assert desk.trade(tid)["status"] == "finalized"


class TestResponseWindow:
    def test_a_response_inside_the_window_is_accepted(self, desk):
        tid = desk.delivered_trade()
        desk.dispute(tid)
        desk.respond(tid)
        assert int(desk.dispute_of(tid)["responded_at"]) > 0

    def test_a_response_after_the_window_is_refused(self, desk):
        tid = desk.delivered_trade()
        desk.dispute(tid)
        desk.past_response_window(tid)
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("response window has closed"):
            desk.c.respond_to_dispute(tid, "a late response")

    def test_the_seller_cannot_respond_twice(self, desk):
        tid = desk.disputed_trade()
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("already responded"):
            desk.c.respond_to_dispute(tid, "a second response")

    def test_adjudication_waits_for_the_seller_while_their_window_is_open(self, desk):
        """Opening the case early would deny the seller their answer."""
        tid = desk.delivered_trade()
        desk.dispute(tid)
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("seller may still respond"):
            desk.c.begin_adjudication(tid)

    def test_adjudication_opens_once_the_response_window_closes_unused(self, desk):
        """A silent seller must not be able to stall the case forever."""
        tid = desk.delivered_trade()
        desk.dispute(tid)
        desk.past_response_window(tid)
        desk.begin(tid)
        assert desk.trade(tid)["status"] == "adjudicating"

    def test_the_resolution_window_must_outlast_the_response_window(self, desk):
        """Found by testing, then fixed in the contract: if the resolution
        window were shorter than the seller's response window, a silent seller
        could run the clock out and make adjudication structurally impossible —
        the case would expire before it could ever be opened. Creation refuses
        that configuration outright rather than letting it be discovered later
        by a buyer who cannot get a hearing."""
        with desk.vm.expect_revert("must leave room for the seller"):
            desk.create(resolution_window=3600)

    def test_a_resolution_window_with_room_is_accepted(self, desk):
        """The minimum that fits: response window + appeal window + slack."""
        window = 3 * 24 * 3600 + 600 + 120
        tid = desk.create(resolution_window=window, appeal_window=600)
        assert desk.trade(tid)["resolution_window"] == str(window)
        assert desk.trade(tid)["appeal_window"] == "600"


class TestResolutionDeadline:
    def test_adjudication_before_the_deadline_is_accepted(self, desk):
        tid = desk.adjudicated_trade()
        assert desk.trade(tid)["status"] == "verdict_proposed"

    def test_opening_a_case_after_the_resolution_deadline_is_refused(self, desk):
        tid = desk.disputed_trade()
        desk.past_resolution(tid)
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("resolution deadline has passed"):
            desk.c.begin_adjudication(tid)

    def test_adjudicating_after_the_resolution_deadline_is_refused(self, desk):
        """The window closes even for a case already opened."""
        tid = desk.disputed_trade()
        desk.begin(tid)
        desk.past_resolution(tid)
        desk.w.set_carrier(carrier_record("MAEU-4471-2026"))
        desk.w.set_panel(verdict({i: CONFORMING for i in DEFAULT_ISSUES}))
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("resolution deadline has passed"):
            desk.c.adjudicate(tid)

    def test_an_expired_case_still_has_a_refund_route(self, desk, transfers):
        """Fail-closed must never mean fail-stuck."""
        tid = desk.disputed_trade()
        desk.past_resolution(tid)
        desk.past_recovery(tid)
        desk.vm.sender = desk.buyer
        desk.c.claim_timeout_refund(tid)
        assert transfers[0]["value"] == TRADE_VALUE


class TestAppealWindow:
    def test_an_appeal_inside_the_window_reopens_adjudication(self, desk):
        tid = desk.adjudicated_trade()
        desk.appeal(tid)
        t = desk.trade(tid)
        assert t["status"] == "adjudicating"
        assert t["appeal_count"] == 1

    def test_an_appeal_after_the_window_is_refused(self, desk):
        tid = desk.adjudicated_trade()
        desk.past_appeal(tid)
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("appeal window has closed"):
            desk.c.submit_appeal(tid)

    def test_appeals_are_capped(self, desk):
        tid = desk.adjudicated_trade()
        for _ in range(2):
            desk.appeal(tid)
            desk.adjudicate(tid)
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("used all"):
            desk.c.submit_appeal(tid)

    def test_finalization_is_refused_while_the_appeal_window_is_open(self, desk):
        tid = desk.adjudicated_trade()
        desk.vm.sender = desk.outsider
        with desk.vm.expect_revert("appeal window is still open"):
            desk.c.finalize(tid)

    def test_an_appeal_does_not_move_the_evidence(self, desk):
        """The package stays frozen across rounds — an appeal re-argues the same
        case, it does not let a party file new documents."""
        tid = desk.adjudicated_trade()
        digest_before = desk.trade(tid)["frozen_digest"]
        desk.appeal(tid)
        desk.vm.sender = desk.buyer
        with desk.vm.expect_revert("evidence package is frozen"):
            desk.c.submit_evidence(tid, "inspection_report", "SUPPORTING",
                                   "f" * 64, "ipfs://new", "new document")
        assert desk.trade(tid)["frozen_digest"] == digest_before


class TestSettlementDelay:
    def test_settlement_before_the_delay_elapses_is_refused(self, desk, transfers):
        """The armed window: value cannot move until the verdict has had time
        to be appealed and finalized."""
        tid = desk.adjudicated_trade()
        desk.past_appeal(tid)
        desk.finalize(tid)
        desk.vm.sender = desk.outsider
        with desk.vm.expect_revert("settlement window is still arming"):
            desk.c.settle(tid)
        assert transfers == []
        assert desk.trade(tid)["deposited_amount"] == str(TRADE_VALUE)

    def test_settlement_after_the_delay_is_accepted(self, desk, transfers):
        tid = desk.adjudicated_trade()
        desk.past_appeal(tid)
        desk.finalize(tid)
        desk.past_settlement(tid)
        desk.settle(tid)
        assert sum(x["value"] for x in transfers) == TRADE_VALUE

    def test_settling_an_unfinalized_verdict_is_refused(self, desk, transfers):
        tid = desk.adjudicated_trade()
        desk.vm.sender = desk.outsider
        with desk.vm.expect_revert("no finalized verdict to settle"):
            desk.c.settle(tid)
        assert transfers == []

    def test_the_view_publishes_the_unlock_time_and_refuses_to_over_promise(self, desk):
        tid = desk.adjudicated_trade()
        desk.past_appeal(tid)
        desk.finalize(tid)
        s = desk.settlement(tid)
        assert s["settleable"] is False
        assert "arming" in s["reason"]
        assert int(s["settlement_unlock"]) > 0


class TestShippingDeadline:
    def test_shipment_before_the_deadline_is_accepted(self, desk):
        tid = desk.funded_trade(ship_in=3600)
        desk.w.advance(1800)
        desk.ship(tid)
        assert desk.trade(tid)["status"] == "shipped"

    def test_shipment_after_the_deadline_is_refused(self, desk):
        tid = desk.funded_trade(ship_in=3600)
        desk.w.advance(3601)
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("shipping deadline has passed"):
            desk.c.mark_shipped(tid, "MAEU-LATE")


# ─── The clock itself ────────────────────────────────────────────────────────

class TestClockHardening:
    def test_a_lagging_chain_indexer_never_freezes_the_contract(self, desk):
        """The chain timestamp is a one-directional FLOOR. Indexer lag is
        unbounded and routine, so it must not be read as disagreement."""
        desk.w.chain_lag = 86400
        desk.w.apply()
        tid = desk.funded_trade()
        assert desk.trade(tid)["deposited_amount"] == str(TRADE_VALUE)

    def test_a_block_stamped_in_the_future_fails_closed(self, desk):
        """A block cannot exist ahead of now; if one appears to, the clock has
        been rolled back or spoofed and no window may be enforced."""
        tid = desk.funded_trade()
        desk.w.chain_ahead = 5000
        desk.w.apply()
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("time sources unreachable or unreliable"):
            desk.c.mark_shipped(tid, "MAEU-CLOCK-TEST")

    def test_no_wall_clock_source_fails_closed(self, desk):
        tid = desk.funded_trade()
        desk.w.kill_all_clock_sources()
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("time sources unreachable or unreliable"):
            desk.c.mark_shipped(tid, "MAEU-CLOCK-TEST")

    def test_one_edge_host_down_is_tolerated(self, desk):
        desk.w.cdn_down = {"medium.com"}
        desk.w.apply()
        tid = desk.funded_trade()
        assert desk.trade(tid)["status"] == "funded"

    def test_a_common_forward_skew_is_caught_by_the_beacon_ceiling(self, desk):
        """The edge hosts share one mechanism, so a skew moving them together
        survives both min() and the divergence guard. Beacon head time comes
        from unrelated infrastructure: a clock ahead of the freshest witness is
        exactly the skew that would close a window early, and it is refused."""
        tid = desk.funded_trade()
        desk.w.skew_all_cdn(4000)
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("time sources unreachable or unreliable"):
            desk.c.mark_shipped(tid, "MAEU-CLOCK-TEST")

    def test_one_lying_edge_host_is_caught_by_divergence(self, desk):
        tid = desk.funded_trade()
        desk.w.cdn_skew = {"medium.com": 9000}
        desk.w.apply()
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("time sources unreachable or unreliable"):
            desk.c.mark_shipped(tid, "MAEU-CLOCK-TEST")

    def test_no_beacon_witness_means_no_clock(self, desk):
        """Fail closed, not open: an attacker able to skew every edge host can
        also block a beacon probe, so an optional ceiling would vanish exactly
        under attack."""
        tid = desk.funded_trade()
        desk.w.beacon_down = True
        desk.w.apply()
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("time sources unreachable or unreliable"):
            desk.c.mark_shipped(tid, "MAEU-CLOCK-TEST")

    def test_beacon_witnesses_disagreeing_refuse_to_set_a_ceiling(self, desk):
        """Head lag is seconds. A minutes-wide gap means one witness is lying or
        on the wrong chain, and max() must not adopt the liar."""
        tid = desk.funded_trade()
        desk.w.beacon_split = 6000
        desk.w.apply()
        desk.vm.sender = desk.seller
        with desk.vm.expect_revert("time sources unreachable or unreliable"):
            desk.c.mark_shipped(tid, "MAEU-CLOCK-TEST")

    def test_the_clock_guards_settlement_too(self, desk, transfers):
        """A broken clock must not let value out — the money paths fail closed
        exactly like the rest."""
        tid = desk.adjudicated_trade()
        desk.past_appeal(tid)
        desk.finalize(tid)
        desk.past_settlement(tid)
        desk.w.kill_all_clock_sources()
        desk.vm.sender = desk.outsider
        with desk.vm.expect_revert("time sources unreachable or unreliable"):
            desk.c.settle(tid)
        assert transfers == []
