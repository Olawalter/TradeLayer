# TradeLayer — Escrow Security Review

Scope: `contracts/tradelayer.py` as deployed at
`0xE9b6e3FC11EbbB1adA32219CEBF43c9d4a3113e5` (GenLayer StudioNet), source
sha256 `e8b311385c7a85b865b685904d5f48e5bd4a91f9285c19139a31579f997f4078` —
fetched back with `genlayer code` and confirmed byte-identical.

Every path by which value enters or leaves the contract, checked against the
same fixed list of properties — and a section recording what is *not*
protected, because a review that only lists strengths is marketing.

---

## 1. Every path where money ENTERS

| # | Path | Method | Authority for the amount |
|---|---|---|---|
| 1 | Funding escrow | `fund_trade(trade_id)` | `gl.message.value` |

That is the complete list. There is exactly one payable method.

**Why the amount cannot be faked:** `fund_trade` takes only a trade id. There is
nowhere to put a figure, so the ledger is credited from the value the execution
environment reports as actually delivered. Identity is
`gl.message.sender_address` for the same reason — there is no participant
parameter to spoof.

Checks before any credit:
- caller is the buyer;
- nothing is already deposited;
- the trade has been accepted by the seller;
- `value > 0` **and** `value == agreed_amount` exactly.

**Overfunding is defined, not tolerated.** A deposit that does not equal the
agreed amount is refused. Silently keeping a surplus would create escrow nobody
agreed to and no settlement path would know how to release.

---

## 2. Every path where money LEAVES

One emission function, `_send_gen`, and every exit calls it.

| # | Exit | Method | Recipient(s) | Amount source |
|---|---|---|---|---|
| 1 | Seller wins | `settle` | seller | whole ledger (`payout_bps == 0`) |
| 2 | Buyer wins | `settle` | buyer | whole ledger (`payout_bps == 10000`) |
| 3 | Partial | `settle` | both | ledger split by derived bps |
| 4 | Undisputed | `close_undisputed` → `settle` | seller | whole ledger |
| 5 | Timeout recovery, nothing decided | `claim_timeout_refund` | buyer | whole ledger |
| 6 | Timeout recovery, verdict on record | `claim_timeout_refund` | both | ledger split by the recorded bps |

Cancellation moves no value: it is only reachable while `deposited_amount == 0`.

**Recipients are never parameters.** Settlement pays `t.buyer` and `t.seller`
from storage; the refund pays `gl.message.sender_address` after asserting it is
the buyer. No method anywhere accepts a payout address, so no account can
direct another's funds.

### 2.1 The emission helper

`_send_gen` pays through an **empty `@gl.evm.contract_interface` proxy**. This
is a correctness requirement, not a style choice: paying a wallet through
`gl.get_contract_at(addr).emit_transfer(...)` treats the recipient as an
Intelligent Contract — the child transaction errors at finalization and the
deducted value is *not* refunded. Contract state would look perfect (ledger
zeroed, trade settled) while no GEN moved. The proxy form is the one verified to
pay an externally-owned account, and the live run confirms it with balance
deltas on both sides.

---

## 3. Per-payout checklist

| Property | `settle` | `claim_timeout_refund` |
|---|---|---|
| Recipient correct | `t.buyer` / `t.seller` from storage | sender, asserted to be the buyer |
| Amount from contract storage | `_split()` over `deposited_amount` | `_split()` if a verdict exists, else `deposited_amount` |
| Amount > 0 | asserted (`held > 0`) | asserted |
| Bounded | `payout_bps ≤ 10000` by construction | same bound; the two parts sum to the deposit |
| Authorization | permissionless by design | buyer only |
| Lifecycle state | must be `finalized` | pre-terminal, and not a delivered trade nobody disputed |
| Finality gate | `now >= settlement_unlock` | `now > recovery_deadline` |
| State updated before transfer | ledger zeroed, amounts recorded, status set | same |
| State persisted before transfer | `self.trades[id] = t` precedes `_send_gen` | same |
| Second execution cannot pay | status is `settled`; the guard rejects | same |

**Ordering, without exception:**

```
READ ledger → VALIDATE → CALCULATE → ZERO + MARK → PERSIST → TRANSFER
```

---

## 4. Why partial settlement is safe

The panel is **never asked how to split the money**. It answers, per agreed
term: `CONFORMING`, `BREACH`, or `INSUFFICIENT`. The remedy for each breach was
agreed by both parties at creation and stored on-chain, and creation refuses a
table totalling more than 10000 bps.

```
payout_bps = min(10000, Σ agreed_remedy[issue] for issues found BREACH)
```

So `0 ≤ payout_bps ≤ 10000` holds **by construction**, not by validating a
number a model produced. Even if a model volunteers `payout_bps` in its JSON,
there is nowhere for it to land — settlement reads the remedy table.

`INSUFFICIENT` contributes zero. The claimant carries the burden of proof: an
unproven breach never moves money. This is not a theoretical property — the live
run's panel returned INSUFFICIENT on all four issues against a party claim, and
the seller kept the entire escrow.

---

## 5. Threats considered

| Threat | Outcome |
|---|---|
| Caller settles twice | Status guard rejects before any payout path; verified live, balance unchanged |
| Timeout refund after settlement | Rejected — trade is terminal |
| Timeout refund twice | Rejected on the second attempt |
| Appeal after settlement | Rejected — no proposed verdict exists |
| Buyer funds less/more than agreed | Both refused; ledger unchanged |
| Buyer funds twice | Rejected, told it is already funded |
| Seller cancels a funded trade | Refused — cancellation requires zero custody |
| Creator-style privileged escape | No withdraw, no outcome setter, no remedy setter; asserted against the deployed schema |
| Party self-declares AUTHORITATIVE evidence | Refused at the boundary — only the contract writes that tier |
| Photograph or statement claimed as authoritative | Refused by the per-type tier allowlist |
| Evidence changed mid-adjudication | The status allowlist is the freeze; a digest re-check backs it |
| Panel invents an issue with a remedy | Findings for unagreed issues are discarded |
| Panel returns partial findings | Rejected — a verdict must answer every agreed issue |
| Panel returns malformed JSON | Fails closed; nothing is decided, case stays open |
| Prompt injection in a document or claim | Fence delimiters defused; prompt names the text as untrusted data |
| Forged `[AUTHORITATIVE]` row via the hash field | Refused at the boundary: a party hash must be empty or a real digest; the prompt defuses it again |
| Fence or overlong text via the carrier reference | Capped at 64 chars at shipment; defused into the prompt. `_norm_ref` already strips every whitespace character, so no new line can be forged |
| Silent seller stalls the case forever | Adjudication opens once the response window closes |
| Silent seller runs out the resolution window | Creation refuses a resolution window shorter than the response window + slack |
| Adjudication after the resolution deadline | Refused; the trade falls to recovery |
| Settlement before finality | Refused until `finalized_at + 300s` |
| Clock skewed forward to close a window early | Beacon-head ceiling from unrelated infrastructure refuses it |
| Block-explorer lag freezes the contract | The chain timestamp is a one-directional floor; lag tolerated without bound |
| Funds stranded in a stalled trade | Buyer recovers after the recovery deadline, from any state before a verdict is final |
| Losing party appeals at the edge of the resolution window | Refused: an appeal must leave `MIN_ADJUDICATION_TIME` to be heard, and the appeal window is clamped so it can never outlive that point. Without this, a stranded trade paid the buyer 100% — making an adverse verdict appealable by attrition |
| Three panel failures exhaust the case | A round that decided nothing is not charged. Evidence is a party's to write before the freeze, so text that reliably breaks a structured reply would otherwise be a way to buy the whole escrow |
| Buyer waits out the clock after losing | Recovery settles the **recorded verdict**, not a full refund |
| Buyer recovers a trade they never disputed | Refused: the closed dispute window is itself the answer, and `close_undisputed` is permissionless |
| Seller self-certifies delivery at ship time | Refused: before the agreed delivery deadline only the buyer may record delivery. Otherwise the dispute window expires while the cargo is at sea |
| Seller revokes a vested recovery right | Refused: the seller cannot record delivery once `recovery_deadline` has passed. Recording delivery recomputes that deadline, and while a trade is only `shipped` the timeout refund is the buyer's sole remedy — `open_dispute` requires `delivered` |

---

## 6. Known limitations — stated plainly

1. **The settlement delay is an armed window, not a finality read.** The
   contract cannot ask the chain "am I finalized". What it does: separate the
   verdict from the settlement, refuse settlement until `finalized_at + 300s`,
   and rely on GenLayer executing the outbound value message only at
   finalization. That is real protection, and it is not the same thing.

2. **Authoritative evidence is currently one carrier record.** The demo binds a
   registry the project controls, because public carrier APIs require per-carrier
   keys and a contract cannot hold a secret. The *mechanism* is right — the
   reference is bound before any dispute exists, on a host the contract fixes —
   but a production deployment needs genuinely independent carrier and customs
   endpoints. Until then, an unreachable record yields INSUFFICIENT rather than
   a guess.

3. **The panel's judgment is constrained, not eliminated.** Structural
   validation, the issue allowlist, the sufficiency semantics and the equivalence
   check bound it hard, and it can never pick a payout — but a confidently wrong
   reading of genuinely retrieved evidence can still produce a wrong finding, and
   a wrong finding maps to a real remedy.

4. **Reentrancy is not simulated in tests.** `emit_transfer` queues an external
   message rather than making a synchronous call, so a classic reentrant callback
   is not reachable. Tests assert state-before-transfer ordering and that a
   second settlement emits nothing; they do not model a callback the mechanism
   does not provide.

5. **`document_hash` is anchored, never verified.** The contract records a
   sha256 for supporting documents but cannot fetch IPFS to confirm the bytes
   match. It proves *which* document was filed, not that the file exists.

6. **Passport counters are protocol history, not a rating.** They are derived
   from settled outcomes only, and deliberately carry no score.

---

## 7. Live verification

See the "Verified end to end" block in the README for the transaction table from
the deployed contract, including the balance deltas on both sides and the
rejected second settlement.

Direct suite: **193 tests**. `genvm_linter` check: clean. Twenty-seven critical
guards were mutation-checked — each broken in a scratch copy to confirm the
suite fails, against a clean accept-control run:

| # | Guard broken | Detected |
|---|---|---|
| M1 | Remedy arithmetic (payout derived from the agreed table) | yes |
| M2 | Remedy-table cap at creation | yes |
| M3 | Payout clamp to 10000 bps | yes |
| M4b | The freeze (status allowlist in `submit_evidence`) | yes |
| M5 | Settlement delay | yes |
| M6 | Tier allowlist (`AUTHORITATIVE` unreachable by parties) | yes |
| M7 | Beacon ceiling on the clock | yes |
| M8 | Complete-findings rule | yes |
| M9 | Frozen-digest integrity check | yes |
| M10 | Date rendering for the panel | yes |
| M11 | Unset-time guard (zero must not render as 1970) | yes |
| M12 | Shipping deadline reaching the prompt | yes |
| M13 | The rule that a seller's own entry is not proof of loading | yes |
| M14 | `PARTY_CLAIM` hash must be empty or a real digest | yes |
| M15 | Carrier-reference length cap | yes |
| M16 | Hash defused on the way into the prompt | yes |
| M17 | Carrier reference defused on the way into the prompt | yes |
| M18 | A failed panel round is not charged to the trade | yes |
| M19 | Appeal window clamped inside the resolution window | yes |
| M20 | Appeal refused when no round could be heard | yes |
| M21 | Creation reserves time to adjudicate | yes |
| M22 | Recovery honours an existing verdict | yes |
| M23 | An undisputed delivered trade cannot be recovered | yes |
| M24 | The seller cannot self-certify delivery early | yes |
| M25 | Evidence description defused into the prompt | yes |
| M26 | The seller cannot record delivery after recovery vests | yes |
| M27 | `settle` zeroes the ledger **before** emitting (pure reorder) | yes |

Five were only detected after the suite was strengthened, and each taught
something:

- **M4** missed because the explicit `status != ADJUDICATING` guard was dead
  code — the allowlist already covered it. The guard was deleted and the
  allowlist documented as the mechanism (M4b). A redundant line that reads like
  the mechanism points a reviewer at the wrong place.
- **M8**'s digest check is unreachable through the public API, so a test now
  tampers with contract storage directly.
- **M16** missed for the same reason: once the boundary refuses anything that
  is not empty-or-a-digest, no public path can put a fence in that field. It is
  kept as a *second* layer against a future boundary regression, and pinned the
  same way — by writing the hostile value straight into storage.

- **M25** missed because the test named for the description sanitiser asserted
  `payout_bps == 0` after mocking a CONFORMING panel. That assertion restates
  the mock and the already-pinned remedy arithmetic; it holds with the
  sanitiser deleted. The test now keys its mock on the *defused* text. A
  security test that asserts a consequence the rest of the system already
  guarantees will pass whether or not the defence exists.

- **M27** is a *reorder*, not a deletion: move both `_send_gen` calls ahead of
  the ledger zeroing, same recipients and same amounts. The suite passed. The
  `transfers` fixture records only `{to, value}`, so ordering was structurally
  invisible to it — while this document and the README both claimed the suite
  asserted it. A test now installs a hook that reads `deposited_amount` **at the
  instant the transfer is emitted**, which is the only moment ordering exists.

M14 was not a hardening exercise. It closes a real hole found during review:
`document_hash` accepted arbitrary multi-line text for `PARTY_CLAIM` and was
printed into the panel's prompt undefused, so a party could forge an
`[AUTHORITATIVE]` evidence row — the one tier no party may write. `description`
beside it *was* defused. Sanitising most of the untrusted fields is not
sanitising the untrusted fields.
