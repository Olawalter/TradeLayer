# TradeLayer — Adjudication

How a frozen evidence package becomes a settlement, and what each part of that
path is allowed to decide.

The single most important property: **the panel decides findings, never money.**
The remedy for each breach was agreed by both parties before the goods shipped
and is stored on-chain. The panel is asked bounded questions about facts; the
contract does the arithmetic.

---

## 1. The bounded question

For each issue both parties agreed at creation, the panel returns exactly one of:

| Finding | Meaning |
|---|---|
| `CONFORMING` | The evidence establishes the term was met |
| `BREACH` | The evidence establishes a breach |
| `INSUFFICIENT` | The evidence establishes neither |

`INSUFFICIENT` is not a failure mode — it is the honest answer, and it is
load-bearing. The prompt states the burden explicitly:

> The buyer carries the burden of proof. If the evidence does not settle an
> issue, answer INSUFFICIENT. Do not guess, and do not infer a breach from the
> absence of a document.

A companion rule stops the seller's own bookkeeping from counting as proof:

> 'Shipment recorded by the seller' below is the seller's own on-chain entry,
> not proof of when the goods went on board. If a retrieved authoritative record
> gives a different loading date, that record governs.

Without it, showing the panel `shipped_at` would hand the seller a
self-certified fact. The live panel quoted the rule back — see §9.

An unproven breach moves no money. In the live run on this deployment the panel
returned `INSUFFICIENT` on every issue against a buyer's party claim, and the
seller kept the whole escrow. That is the system working, not the system
failing to decide.

The issue vocabulary is fixed by the contract: `PRODUCT_MODEL`, `QUANTITY`,
`QUALITY_GRADE`, `SHIPPING_DEADLINE`, `DOCUMENTATION`. A trade selects a subset
at creation and attaches a requirement sentence and an agreed remedy to each.

## 2. Prompt construction

`_build_case` assembles the case in a deliberate order:

1. **Protocol rules** — including "you decide findings only" and the untrusted
   material rule.
2. **The agreement** — product, identifier, quantity, quality, destination,
   carrier and carrier reference, plus the shipping and delivery deadlines and
   the times the contract recorded shipment and delivery. Dates are rendered
   (`2026-08-24 12:00:00 UTC`), not raw epochs: `SHIPPING_DEADLINE` is an issue
   the parties may agree to arbitrate, and a panel handed two integers is being
   asked to do arithmetic instead of judgment. An agreed issue the panel
   structurally cannot decide is a remedy that can never be earned.
3. **The issues to decide**, each with the requirement both parties wrote.
4. **The authoritative record**, if the contract could retrieve one.
5. **Party positions**, labelled "advocacy, not proof".
6. **Filed evidence**, as metadata with tier, type, sha256 and description.

Rules precede material for a reason: an instruction smuggled into a claim
arrives after the panel has been told what claims are worth. Every party-authored
string passes `_sanitize` first, which defuses the fence delimiters used to
frame untrusted blocks.

## 3. Structural validation — before anything reaches state

The panel's reply is JSON, and it is not trusted to be well-formed. Three gates
run inside the nondeterministic block, so a bad reply never becomes a verdict:

```python
raw_findings = verdict.get("findings")
if not isinstance(raw_findings, list) or not raw_findings:
    return {... "ok": False, "error_class": "LLM_ERROR" ...}
```

**Unknown issues are discarded.** A finding is kept only if its issue is one the
parties actually agreed and its result is one of the three:

```python
if issue in wanted and result in FINDINGS and issue not in got:
```

So a panel that invents an issue — or repeats one to double a remedy — writes
nothing. `issue not in got` makes the first answer per issue binding.

**Partial answers are rejected outright.** Every agreed issue must be answered:

```python
missing = [i for i in wanted if i not in got]
if missing:
    return {... "ok": False, "reason": f"no finding returned for: ..." ...}
```

A verdict that covers three of four issues is not a discount; it is a
non-verdict.

## 4. Failing closed

If the model call raises, if the JSON is unusable, or if any gate above trips,
`adjudicate` writes no findings and no payout:

```python
if not bool(data.get("ok", False)):
    t.status = STATUS_DISPUTED
    t.reason_code = str(data.get("error_class", "LLM_ERROR"))[:60]
    return
```

The trade returns to `disputed`. It remains adjudicable until its resolution
deadline, and falls to buyer recovery after that. A failed panel decides
nothing and strands nothing.

## 5. The equivalence principle

Adjudication runs under `gl.eq_principle.prompt_comparative`. The principle
pins every field that can move money and explicitly frees the fields that
cannot:

- **Must match exactly:** `ok`; the number of findings; for each index, both the
  `issue` and the `result`; `material_breach`; and `carrier.readable`.
- **May differ:** `rationale`, `reason`, `reason_code`, and the carrier
  `excerpt` — wording varies between runs, and live page text varies between
  fetches seconds apart.

Pinning the excerpt would make honest validators disagree over a timestamp on a
tracking page. Leaving `result` unpinned would let validators disagree about who
gets paid. The line is drawn at "does this change the money".

`carrier.readable` is pinned because *whether the contract reached the
authoritative source* is itself decisive — a run that saw the record and a run
that did not are not adjudicating the same case.

## 6. From findings to money

The panel never sees a number. Settlement is contract arithmetic over the agreed
remedy table:

```python
if result == FINDING_BREACH:
    breaches += 1
    for j in range(int(t.issue_count)):
        term = self.issue_terms[trade_id][u256(j)]
        if term.issue == issue:
            payout_bps += int(term.buyer_bps)
            break
```

with a clamp behind it:

```python
if payout_bps > BPS_DENOMINATOR:
    payout_bps = BPS_DENOMINATOR
```

The clamp is belt to the braces: creation already refuses a remedy table
totalling more than 10000 bps, and each remedy must be between 1 and 10000. So

```
0 ≤ payout_bps ≤ 10000
```

holds **by construction**, not by validating a number a model produced. Even if
a model volunteers `payout_bps` in its JSON, there is nowhere for it to land.

The decision label is derived, never asserted:

| `payout_bps` | Decision |
|---|---|
| 0 | `SELLER_WIN` |
| 10000 | `BUYER_WIN` |
| anything between | `PARTIAL_SETTLEMENT` |

## 7. Appeals

A proposed verdict opens an appeal window sized per trade at creation
(`appeal_window`). Either party may appeal, up to `MAX_APPEALS = 2`, and an
appeal returns the trade to `adjudicating` **on the same frozen package** — the
evidence does not move, so an appeal buys a second reading, not a second chance
to file.

`adjudicate` is capped independently:

```python
_require(int(t.adjudication_count) <= MAX_APPEALS, ...)
```

so the rounds cannot be run indefinitely even by a caller who never appeals.

## 8. Finality and the settlement delay

`finalize` is permissionless and requires the appeal window to have closed. It
records `finalized_at` and arms `settlement_unlock = now + 300`. `settle`
refuses before that instant.

The separation matters: the verdict and the money movement are two transactions
at two different times, so a verdict that turns out to be contested has a window
in which nothing has yet been paid.

**Stated plainly:** this is an armed window, not a finality read. The contract
cannot ask the chain "am I final". What it does is refuse to settle for 300
seconds after finalization and rely on GenLayer executing the outbound value
message only at finalization. That is real, and it is not the same thing.

## 9. Probing the path before money depends on it

`preview_adjudication` runs the entire real pipeline — the live fetch, the
prompt, the validation — and returns the JSON without touching state or any
balance.

This exists because a nondeterministic source that silently fails looks exactly
like a feature that was never built. Calling it on-chain, against real
validators, is the only way to learn whether validators can actually reach what
the contract binds. Local tests mock the fetch; they cannot tell you that.

`npm run probe` drives it. On the current deployment it returns
`carrier.readable: false` with an **empty** excerpt — which answers a question
the findings alone could not: `gl.nondet.web.render` raises on a 404 rather than
returning the error page, so a "404: Not Found" body is never fenced as an
authoritative record. Had the excerpt come back non-empty and full of error-page
text, the retrieval would have been "working" in the worst possible way.
