"""TradeLayer — integration tests against the deployed contract on StudioNet.

Direct mode proves the logic with the nondeterministic boundary mocked. What it
cannot prove is the half that only exists on a network: that a validator set
independently retrieves the bound carrier record, agrees under the equivalence
rule this contract declares, and that the recorded case survives consensus.

These tests bind to the deployed artifact rather than deploying per run —
deploying from a fixture burns most of StudioNet's request budget, and the
deployed contract is the thing actually worth testing.

Assertions are INVARIANTS, never "the panel must rule for the buyer". A live
panel's verdict is not a fixed quantity, and a test that depends on one is a
test that fails for the wrong reason.

Run:  gltest tests/integration -v -s --network studionet
"""

import os
import pathlib
import time

import pytest

CONTRACT_SOURCE = pathlib.Path("contracts/tradelayer.py")

DEPLOYED = os.environ.get(
    "TRADELAYER_ADDRESS", "0x699fff65298c7ba2797DF236E5eB1C0DDB3c3A0F")
RPC_URL = os.environ.get("GENLAYER_RPC", "https://studio.genlayer.com/api")

VALID_STATUSES = {
    "created", "accepted", "funded", "shipped", "delivered", "disputed",
    "adjudicating", "verdict_proposed", "finalized", "settled", "cancelled",
}
VALID_DECISIONS = {"", "SELLER_WIN", "BUYER_WIN", "PARTIAL_SETTLEMENT"}
VALID_RESULTS = {"CONFORMING", "BREACH", "INSUFFICIENT"}
TERMINAL = {"settled", "cancelled"}


def deployed_schema() -> dict:
    """The schema the CHAIN reports for this address.

    Deliberately a raw JSON-RPC call rather than anything derived from the
    local file: a test that reads the source to describe the deployment cannot
    detect the two of them diverging.
    """
    import json
    import urllib.request

    body = json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "method": "gen_getContractSchema", "params": [DEPLOYED],
    }).encode()
    # An explicit User-Agent is required: urllib's default is rejected with a
    # bare 403, which reads like an auth problem and is not one.
    req = urllib.request.Request(RPC_URL, data=body, headers={
        "Content-Type": "application/json",
        "User-Agent": "tradelayer-integration-tests/1.0",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read())
    assert "error" not in payload, f"schema fetch failed: {payload.get('error')}"
    return payload["result"]


@pytest.fixture(scope="module")
def contract():
    """Bind to the deployed instance with a bytes-sourced schema.

    The factory's schema fetch reads the source as `str` and the client encodes
    that as ASCII, so a single non-ASCII character in a comment raises
    UnicodeEncodeError, reported as "failed to get schema from all clients" —
    which points nowhere near the cause. Passing bytes works.
    """
    from gltest.clients import get_gl_client
    from gltest.contracts.contract import Contract

    source = CONTRACT_SOURCE.read_bytes()
    client = get_gl_client()

    last = None
    for attempt in range(4):
        try:
            schema = client.get_contract_schema_for_code(contract_code=source)
            return Contract.new(address=DEPLOYED, schema=schema)
        except Exception as exc:                      # usually a 429
            last = exc
            time.sleep(6 * (attempt + 1))
    pytest.fail(f"could not bind to {DEPLOYED}: {type(last).__name__}: {last}")


# ══ the deployed artifact is the one we think it is ═════════════════════════

def test_config_publishes_the_governing_rules(contract):
    """The rules of the venue, readable by anyone being asked to commit funds —
    rather than taking the interface's word for them."""
    cfg = contract.get_config(args=[]).call()
    assert cfg["bps_denominator"] == 10000
    assert cfg["settlement_delay"] > 0
    assert cfg["response_window"] > 0
    assert cfg["recovery_grace"] > 0
    assert cfg["max_appeals"] >= 1
    assert set(cfg["findings"]) == VALID_RESULTS
    assert "AUTHORITATIVE" in cfg["tiers"]
    assert len(cfg["issues"]) >= 3


def test_the_deployed_contract_offers_no_privileged_escape():
    """No withdraw, no outcome setter, no way to move the remedy table after
    the fact.

    Asserted against the schema the CHAIN reports for this address, fetched
    with `gen_getContractSchema`. It used to run against `contract`, whose
    schema the fixture derives from the local source file — so it was checking
    that the source has no back door, while claiming to check the deployment.
    Those are the same thing only when the deployment matches the source, which
    is the very thing a test like this exists to establish.
    """
    schema = deployed_schema()
    methods = set(schema["methods"])

    for forbidden in ("withdraw", "set_outcome", "set_payout", "set_status",
                      "set_remedies", "set_decision", "amend_trade",
                      "admin_settle", "force_settle", "sweep", "transfer_ownership"):
        assert forbidden not in methods, f"deployed contract exposes {forbidden}"

    # Exactly one method may ever receive value — the escrow deposit.
    payable = [n for n, m in schema["methods"].items() if m.get("payable")]
    assert payable == ["fund_trade"], f"unexpected payable methods: {payable}"

    # And no method takes a payout address, so no caller can direct funds.
    for name, m in schema["methods"].items():
        for param, _kind in m.get("params", []):
            assert param not in ("to", "recipient", "payout_to", "beneficiary"), (
                f"{name} accepts a payout address: {param}"
            )


# ══ every trade on chain obeys the invariants ═══════════════════════════════

def test_every_trade_holds_its_accounting_invariant(contract):
    """Swept across the whole deployment: custody is bounded by the agreement,
    and a settled trade holds nothing."""
    page = contract.list_trades(args=[0, 50]).call()
    if page["total"] == 0:
        pytest.skip("no trades on this deployment yet")

    for item in page["items"]:
        t = contract.get_trade(args=[item["id"]]).call()
        agreed = int(t["agreed_amount"])
        held = int(t["deposited_amount"])
        paid = int(t["buyer_paid"]) + int(t["seller_paid"])

        assert t["status"] in VALID_STATUSES
        assert t["decision"] in VALID_DECISIONS
        assert 0 <= held <= agreed, f"{t['id']}: custody out of range"
        assert 0 <= int(t["payout_bps"]) <= 10000, f"{t['id']}: bps out of range"
        if t["status"] == "settled":
            assert held == 0, f"{t['id']}: settled but still holding escrow"
            assert paid <= agreed, f"{t['id']}: paid out more than was ever deposited"
        if t["status"] in ("created", "accepted"):
            assert held == 0, f"{t['id']}: holding escrow before funding"


def test_the_remedy_table_can_never_exceed_the_whole_trade(contract):
    """The property that makes settlement arithmetic safe: whatever the panel
    finds, the derived payout cannot exceed 100% of the escrow."""
    page = contract.list_trades(args=[0, 50]).call()
    if page["total"] == 0:
        pytest.skip("no trades yet")
    for item in page["items"]:
        terms = contract.get_agreement_terms(args=[item["id"]]).call()
        assert terms["total_bps"] <= 10000, f"{item['id']}: remedies exceed the trade"
        for term in terms["terms"]:
            assert 0 < term["buyer_bps"] <= 10000


def test_adjudicated_trades_carry_a_finding_per_agreed_issue(contract):
    """Consensus binds the findings, and the payout is derived from them. A
    verdict with missing findings would mean money moved on an unanswered
    question."""
    page = contract.list_trades(args=[0, 50]).call()
    decided = [i for i in page["items"]
               if i["status"] in ("verdict_proposed", "finalized", "settled")
               and i["decision"] in ("SELLER_WIN", "BUYER_WIN", "PARTIAL_SETTLEMENT")]
    if not decided:
        pytest.skip("no adjudicated trades yet")

    checked = 0
    for item in decided:
        t = contract.get_trade(args=[item["id"]]).call()
        if t["reason_code"] in ("NO_DISPUTE_RAISED", "TIMEOUT_RECOVERY"):
            continue                      # settled without a panel
        f = contract.get_findings(args=[item["id"]]).call()
        terms = contract.get_agreement_terms(args=[item["id"]]).call()
        agreed_issues = [x["issue"] for x in terms["terms"]]

        assert len(f["findings"]) == len(agreed_issues), \
            f"{item['id']}: a finding is missing for an agreed issue"
        assert [x["issue"] for x in f["findings"]] == agreed_issues, \
            f"{item['id']}: findings do not match the agreed issues in order"
        for x in f["findings"]:
            assert x["result"] in VALID_RESULTS

        # The decisive cross-check: the recorded payout is exactly the sum of
        # the PRE-AGREED remedies for the issues found in breach.
        remedy = {x["issue"]: x["buyer_bps"] for x in terms["terms"]}
        expected = min(10000, sum(remedy[x["issue"]] for x in f["findings"]
                                  if x["result"] == "BREACH"))
        assert int(t["payout_bps"]) == expected, (
            f"{item['id']}: payout {t['payout_bps']} does not equal the agreed "
            f"remedies for the breached issues ({expected}) — the panel must "
            "never be the source of the number"
        )
        checked += 1

    if checked == 0:
        pytest.skip("no panel-adjudicated trade on this deployment yet")


def test_settled_trades_paid_exactly_what_the_split_implies(contract):
    page = contract.list_trades(args=[0, 50]).call()
    settled = [i for i in page["items"] if i["status"] == "settled"]
    if not settled:
        pytest.skip("no settled trades yet")

    for item in settled:
        t = contract.get_trade(args=[item["id"]]).call()
        if t["reason_code"] == "TIMEOUT_RECOVERY":
            assert int(t["buyer_paid"]) > 0 and int(t["seller_paid"]) == 0
            continue
        agreed = int(t["agreed_amount"])
        bps = int(t["payout_bps"])
        expected_buyer = agreed * bps // 10000
        assert int(t["buyer_paid"]) == expected_buyer, f"{item['id']}: buyer share wrong"
        assert int(t["buyer_paid"]) + int(t["seller_paid"]) == agreed, \
            f"{item['id']}: the payouts do not reconstitute the escrow"


def test_frozen_cases_carry_a_digest(contract):
    """A case under review must be pinned to a specific evidence package."""
    page = contract.list_trades(args=[0, 50]).call()
    frozen = [i for i in page["items"]
              if i["status"] in ("adjudicating", "verdict_proposed", "finalized", "settled")]
    if not frozen:
        pytest.skip("no frozen cases yet")
    seen = 0
    for item in frozen:
        t = contract.get_trade(args=[item["id"]]).call()
        if t["reason_code"] in ("NO_DISPUTE_RAISED", "TIMEOUT_RECOVERY"):
            continue                      # never entered adjudication
        assert len(t["frozen_digest"]) == 64, f"{item['id']}: frozen without a digest"
        assert contract.get_evidence(args=[item["id"]]).call()["frozen"] is True
        seen += 1
    if seen == 0:
        pytest.skip("no adjudicated case to check")


# ══ the live pipeline, run for real ═════════════════════════════════════════

@pytest.mark.slow
def test_preview_adjudication_runs_the_real_pipeline_without_touching_state(contract):
    """The on-chain probe. A nondeterministic source that silently fails looks
    exactly like a feature that was never built, so the real retrieval path is
    exercised against live infrastructure — and must change nothing."""
    from gltest.assertions import tx_execution_succeeded

    page = contract.list_trades(args=[0, 50]).call()
    candidates = [i for i in page["items"]
                  if i["status"] in ("adjudicating", "verdict_proposed", "finalized", "settled")]
    if not candidates:
        pytest.skip("no case to preview")

    tid = candidates[0]["id"]
    before = contract.get_trade(args=[tid]).call()

    receipt = contract.preview_adjudication(args=[tid]).transact()
    assert tx_execution_succeeded(receipt)

    after = contract.get_trade(args=[tid]).call()
    assert after["status"] == before["status"], "preview must not mutate state"
    assert after["payout_bps"] == before["payout_bps"]
    assert after["decision"] == before["decision"]
    assert after["deposited_amount"] == before["deposited_amount"]
