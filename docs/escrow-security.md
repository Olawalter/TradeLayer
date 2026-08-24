# TradeLayer — Escrow Security Review

Scope: `contracts/tradelayer.py` as deployed at
`0xB9526c7Aaefd3a81C056Df1102EcBF5Ca610CCA4` (GenLayer StudioNet), source
sha256 `ab619308efd4f80832fc869dbe0d53c4109db2955dd205377301baf455e7a77f` —
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
| 5 | Timeout recovery | `claim_timeout_refund` | buyer | whole ledger |

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
| Amount from contract storage | `_split()` over `deposited_amount` | `deposited_amount` |
| Amount > 0 | asserted (`held > 0`) | asserted |
| Bounded | `payout_bps ≤ 10000` by construction | whole ledger |
| Authorization | permissionless by design | buyer only |
| Lifecycle state | must be `finalized` | must be pre-terminal |
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
| Silent seller stalls the case forever | Adjudication opens once the response window closes |
| Silent seller runs out the resolution window | Creation refuses a resolution window shorter than the response window + slack |
| Adjudication after the resolution deadline | Refused; the trade falls to recovery |
| Settlement before finality | Refused until `finalized_at + 300s` |
| Clock skewed forward to close a window early | Beacon-head ceiling from unrelated infrastructure refuses it |
| Block-explorer lag freezes the contract | The chain timestamp is a one-directional floor; lag tolerated without bound |
| Funds stranded in a stalled trade | Buyer recovers after the recovery deadline, from any pre-terminal state |

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

Direct suite: **161 tests**. `genvm_linter` check: clean. Thirteen critical
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

Two were only detected after the suite was strengthened: **M4** originally
missed because the explicit `status != ADJUDICATING` guard was dead code — the
allowlist already covered it — so the guard was removed and the allowlist
documented as the mechanism (M4b); and **M8**'s digest check was unreachable
through the public API, so a test now tampers with contract storage directly.
