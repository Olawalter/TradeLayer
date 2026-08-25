"""Direct-mode harness for contracts/tradelayer.py.

Runs on the official gltest direct plugin: the real contract module executes
in-process while the nondeterministic boundary (gl.nondet.web.render,
gl.nondet.exec_prompt) is mocked at the VM. The equivalence-principle closures
run for real, so the clock, the carrier retrieval, the panel's structural
validation and every fail-closed branch are genuinely exercised.

FIXTURE DESIGN NOTE

Sibling builds have shipped "live clock" features that were inert on-chain
because every fixture served all time sources from ONE fake clock: the sources
always agreed, so the divergence guards could never fire, and a fail-safe that
always fires is indistinguishable from a feature that was never built.

So this World models a hostile-but-normal world BY DEFAULT:
  - the chain indexer lags 1250s, deliberately more than the 300s tolerance,
    because that is the ordinary production condition and must never freeze the
    contract;
  - skew, outages and lying sources are settable per test;
  - the carrier record and the panel verdict are settable per test, including
    unreachable, malformed and openly malicious variants.
"""

import json
import re

import pytest

CONTRACT_FILE = "contracts/tradelayer.py"

GEN = 10 ** 18
BEACON_GENESIS = 1606824023

# A fixed "now" for reproducibility: 2026-08-20T12:00:00Z.
T0 = 1787313600

CDN_HOSTS = ("cloudflare.com", "www.digitalocean.com", "medium.com")

# The demo carrier registry the contract binds (DEMO_REGISTRY in CARRIER_SOURCES).
CARRIER_PATTERN = r"raw\.githubusercontent\.com/Olawalter/TradeLayer/main/registry/"

ADJUDICATION_PROMPT = r"You are adjudicating an international trade dispute"


def epoch_to_iso(epoch: int) -> str:
    """Epoch -> '2026-08-20T12:00:00.000000Z' with pure integer math, so the
    fixture never depends on the host's locale or timezone."""
    days, rem = divmod(int(epoch), 86400)
    hh, rem = divmod(rem, 3600)
    mm, ss = divmod(rem, 60)
    z = days + 719468
    era = (z if z >= 0 else z - 146096) // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + (3 if mp < 10 else -9)
    y += 1 if m <= 2 else 0
    return f"{y:04d}-{m:02d}-{d:02d}T{hh:02d}:{mm:02d}:{ss:02d}.000000Z"


def cdn_trace(epoch: int, host: str) -> str:
    return (
        f"fl=100f42\nh={host}\nip=203.0.113.7\n"
        f"ts={epoch}.401\nvisit_scheme=https\nhttp=http/2\nloc=NL\n"
    )


def carrier_record(ref: str, *, status: str = "DELIVERED",
                   shipped: str = "2026-08-01", delivered: str = "2026-08-18") -> str:
    """A plausible carrier tracking record for the bound reference."""
    return (
        "MAERSK LINE — CARGO TRACKING RECORD\n"
        f"Booking reference: {ref}\n"
        f"Status: {status}\n"
        f"Shipped on board: {shipped}\n"
        f"Delivered: {delivered}\n"
        "Port of loading: Shenzhen (CNSZX)\n"
        "Port of discharge: Lagos (NGLOS)\n"
        "Containers: 2 x 40HC\n"
    )


# Findings the panel may return, keyed for readability in tests.
CONFORMING = "CONFORMING"
BREACH = "BREACH"
INSUFFICIENT = "INSUFFICIENT"


def verdict(results: dict, *, material_breach: bool = False,
            reason_code: str = "ADJUDICATED") -> str:
    """Build a well-formed panel response for the given {issue: result} map."""
    return json.dumps({
        "findings": [
            {"issue": k, "result": v, "rationale": f"{k} judged {v}"}
            for k, v in results.items()
        ],
        "material_breach": material_breach,
        "reason_code": reason_code,
    })


class World:
    """All mock state for one test. Any mutation re-registers every mock, since
    the VM matches mocks first-come and has no callable responses."""

    def __init__(self, vm):
        self.vm = vm
        self.now = T0
        # Deliberately > MAX_CLOCK_DIVERGENCE: a lagging explorer indexer is the
        # normal condition, and it must never freeze the contract.
        self.chain_lag = 1250
        self.cdn_skew = {}
        self.cdn_down = set()
        self.beacon_delta = 0
        self.beacon_down = False
        self.beacon_split = 0
        self.chain_ahead = 0
        self.carrier_body = None      # None -> carrier source unreachable
        self.panel = None             # None -> no LLM mock registered
        self.apply()

    # -- registration ----------------------------------------------------

    def apply(self):
        self.vm.clear_mocks()
        self._register_clock()
        self._register_carrier()
        self._register_panel()
        # Keep the node's transaction datetime in step with the mocked web
        # clock, so views that read the node stamp and writes that run the
        # consensus clock see the same "now".
        try:
            self.vm.warp(epoch_to_iso(self.now))
        except Exception:
            pass
        import sys as _sys
        gl_mod = _sys.modules.get("genlayer.gl")
        if gl_mod is not None:
            try:
                gl_mod.message_raw["datetime"] = epoch_to_iso(self.now)
            except Exception:
                pass

    def _register_clock(self):
        for host in CDN_HOSTS:
            if host in self.cdn_down:
                continue
            ts = self.now + self.cdn_skew.get(host, 0)
            self.vm.mock_web(
                re.escape(host) + r"/cdn-cgi/trace",
                {"status": 200, "body": cdn_trace(ts, host)},
            )
        chain_ts = self.now - self.chain_lag + self.chain_ahead
        self.vm.mock_web(
            r"eth\.blockscout\.com/api/v2/main-page/blocks",
            {"status": 200,
             "body": json.dumps({"items": [{"timestamp": epoch_to_iso(chain_ts)}]})},
        )
        if not self.beacon_down:
            for i, frag in enumerate((r"publicnode\.com", r"chainsafe\.io")):
                witness = self.now + self.beacon_delta + (self.beacon_split if i else 0)
                slot = (witness - BEACON_GENESIS) // 12
                self.vm.mock_web(
                    frag + r"/eth/v1/beacon/headers/head",
                    {"status": 200,
                     "body": json.dumps(
                         {"data": {"header": {"message": {"slot": str(slot)}}}})},
                )

    def _register_carrier(self):
        if self.carrier_body is None:
            return                       # unreachable: no mock registered
        self.vm.mock_web(CARRIER_PATTERN, {"status": 200, "body": self.carrier_body})

    def _register_panel(self):
        if self.panel is None:
            return
        self.vm.mock_llm(ADJUDICATION_PROMPT, self.panel)

    # -- time ------------------------------------------------------------

    def advance(self, seconds):
        self.now += int(seconds)
        self.apply()
        return self.now

    def set_now(self, epoch):
        self.now = int(epoch)
        self.apply()
        return self.now

    # -- fault injection --------------------------------------------------

    def kill_all_clock_sources(self):
        self.cdn_down = set(CDN_HOSTS)
        self.apply()

    def skew_all_cdn(self, seconds):
        """A COMMON forward skew across every edge host — exactly the attack the
        beacon ceiling exists to catch, since min() and the divergence guard
        both pass it."""
        self.cdn_skew = {h: seconds for h in CDN_HOSTS}
        self.apply()

    def set_carrier(self, body):
        self.carrier_body = body
        self.apply()

    def kill_carrier(self):
        self.carrier_body = None
        self.apply()

    def set_panel(self, response):
        self.panel = response
        self.apply()


@pytest.fixture
def transfers(direct_vm):
    """Records every native-value transfer the contract emits, so tests can
    assert recipients and exact amounts — not merely that a flag flipped.
    Contract state looking right while no GEN moved is a real failure mode."""
    sent = []

    def hook(vm, request):
        for op in ("EthSend", "PostMessage"):
            if op in request:
                data = request[op]
                raw = data.get("address", b"")
                to = ("0x" + bytes(raw).hex()) if isinstance(raw, (bytes, bytearray)) else str(raw)
                sent.append({"to": to.lower(), "value": int(data.get("value", 0))})
                return {"ok": None}
        return None

    direct_vm._gl_call_hook = hook
    return sent


@pytest.fixture
def world(direct_vm):
    return World(direct_vm)


def to_hex(addr) -> str:
    if isinstance(addr, (bytes, bytearray)):
        return "0x" + bytes(addr).hex()
    s = str(addr)
    return s if s.startswith("0x") else "0x" + s


# The demo agreement: 1,000 industrial pumps, Shenzhen -> Lagos.
DEFAULT_ISSUES = ["PRODUCT_MODEL", "QUANTITY", "QUALITY_GRADE", "SHIPPING_DEADLINE"]
DEFAULT_REMEDIES = [6500, 2000, 1000, 500]      # totals 10000 exactly
DEFAULT_REQUIREMENTS = [
    "Goods are model XP-200 as specified in the agreement",
    "Exactly 1,000 units delivered",
    "Grade A quality per the agreed inspection standard",
    "Shipped on board before the shipping deadline",
]

TRADE_VALUE = 50 * GEN
CARRIER_REF = "MAEU-4471-2026"


class Desk:
    """Readable driver over one deployed TradeLayer instance."""

    def __init__(self, vm, contract, world, buyer, seller, outsider):
        self.vm = vm
        self.c = contract
        self.w = world
        self.buyer = buyer
        self.seller = seller
        self.outsider = outsider

    @property
    def buyer_hex(self):
        return to_hex(self.buyer).lower()

    @property
    def seller_hex(self):
        return to_hex(self.seller).lower()

    # -- lifecycle -------------------------------------------------------

    def create(self, *, sender=None, seller=None, value=TRADE_VALUE,
               issues=None, remedies=None, requirements=None,
               ship_in=3600, deliver_in=7200, dispute_window=3600,
               # Must leave room for the seller's 3-day response window plus
               # time to adjudicate — the contract enforces this at creation.
               resolution_window=4 * 24 * 3600, appeal_window=3600, quantity=1000,
               identifier="XP-200", inspection=True):
        self.vm.sender = sender or self.buyer
        return self.c.create_trade(
            to_hex(seller or self.seller),
            "1,000 industrial pumps, model XP-200, Grade A",
            identifier,
            quantity,
            value,
            "Grade A per SGS inspection standard",
            "Lagos, Nigeria",
            "DEMO_REGISTRY",
            self.w.now + ship_in,
            self.w.now + deliver_in,
            dispute_window,
            resolution_window,
            appeal_window,
            inspection,
            list(DEFAULT_ISSUES if issues is None else issues),
            list(DEFAULT_REMEDIES if remedies is None else remedies),
            list(DEFAULT_REQUIREMENTS if requirements is None else requirements),
        )

    def accept(self, tid, sender=None):
        self.vm.sender = sender or self.seller
        self.c.accept_trade(tid)

    def fund(self, tid, *, sender=None, value=TRADE_VALUE):
        self.vm.sender = sender or self.buyer
        self.vm.value = int(value)
        try:
            self.c.fund_trade(tid)
        finally:
            self.vm.value = 0

    def ship(self, tid, *, sender=None, ref=CARRIER_REF):
        self.vm.sender = sender or self.seller
        self.c.mark_shipped(tid, ref)

    def deliver(self, tid, sender=None):
        """Defaults to the BUYER, deliberately.

        It used to default to the seller, and `delivered_trade` recorded
        delivery in the same breath as shipment — which is exactly the
        self-certification the contract now refuses. A fixture that models the
        attack as the happy path cannot catch it.
        """
        self.vm.sender = sender or self.buyer
        self.c.mark_delivered(tid)

    def evidence(self, tid, *, sender=None, etype="inspection_report",
                 tier="SUPPORTING", doc_hash=None, ref="ipfs://Qm-demo",
                 description="SGS inspection report"):
        self.vm.sender = sender or self.seller
        self.c.submit_evidence(
            tid, etype, tier,
            doc_hash if doc_hash is not None else "a" * 64,
            ref, description,
        )

    def dispute(self, tid, *, sender=None, claim="The goods do not match the agreed model."):
        self.vm.sender = sender or self.buyer
        self.c.open_dispute(tid, claim)

    def respond(self, tid, *, sender=None, response="The goods match the agreement."):
        self.vm.sender = sender or self.seller
        self.c.respond_to_dispute(tid, response)

    def begin(self, tid, sender=None):
        self.vm.sender = sender or self.buyer
        self.c.begin_adjudication(tid)

    def adjudicate(self, tid, sender=None):
        self.vm.sender = sender or self.buyer
        self.c.adjudicate(tid)

    def appeal(self, tid, sender=None):
        self.vm.sender = sender or self.seller
        self.c.submit_appeal(tid)

    def finalize(self, tid, sender=None):
        self.vm.sender = sender or self.buyer
        self.c.finalize(tid)

    def settle(self, tid, sender=None):
        self.vm.sender = sender or self.outsider
        self.c.settle(tid)

    # -- shortcuts -------------------------------------------------------

    def funded_trade(self, **kw):
        tid = self.create(**kw)
        self.accept(tid)
        self.fund(tid, value=kw.get("value", TRADE_VALUE))
        return tid

    def delivered_trade(self, **kw):
        tid = self.funded_trade(**kw)
        self.ship(tid)
        self.deliver(tid)
        return tid

    def disputed_trade(self, **kw):
        tid = self.delivered_trade(**kw)
        self.dispute(tid)
        self.respond(tid)
        return tid

    def adjudicated_trade(self, results=None, **kw):
        """Drive all the way to a proposed verdict with the given findings."""
        tid = self.disputed_trade(**kw)
        self.w.set_carrier(carrier_record(CARRIER_REF))
        self.w.set_panel(verdict(results or {i: CONFORMING for i in DEFAULT_ISSUES}))
        self.begin(tid)
        self.adjudicate(tid)
        return tid

    def settled_trade(self, results=None, **kw):
        tid = self.adjudicated_trade(results, **kw)
        self.past_appeal(tid)
        self.finalize(tid)
        self.past_settlement(tid)
        self.settle(tid)
        return tid

    # -- clock helpers ---------------------------------------------------

    def past_dispute_window(self, tid):
        self.w.set_now(int(self.trade(tid)["dispute_deadline"]) + 1)

    def past_response_window(self, tid):
        self.w.set_now(int(self.trade(tid)["response_deadline"]) + 1)

    def past_resolution(self, tid):
        self.w.set_now(int(self.trade(tid)["resolution_deadline"]) + 1)

    def past_appeal(self, tid):
        self.w.set_now(int(self.trade(tid)["appeal_deadline"]) + 1)

    def past_settlement(self, tid):
        self.w.set_now(int(self.trade(tid)["settlement_unlock"]) + 1)

    def past_recovery(self, tid):
        self.w.set_now(int(self.trade(tid)["recovery_deadline"]) + 1)

    # -- reads -----------------------------------------------------------

    def trade(self, tid):
        return self.c.get_trade(tid)

    def terms(self, tid):
        return self.c.get_agreement_terms(tid)

    def evidence_of(self, tid):
        return self.c.get_evidence(tid)

    def dispute_of(self, tid):
        return self.c.get_dispute(tid)

    def findings(self, tid):
        return self.c.get_findings(tid)

    def settlement(self, tid):
        return self.c.get_settlement(tid)

    def passport(self, who):
        return self.c.get_passport(to_hex(who))


@pytest.fixture
def desk(direct_vm, direct_deploy, world, direct_alice, direct_bob, direct_charlie):
    contract = direct_deploy(CONTRACT_FILE)
    return Desk(direct_vm, contract, world,
                buyer=direct_alice, seller=direct_bob, outsider=direct_charlie)
