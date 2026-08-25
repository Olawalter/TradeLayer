<img src="docs/assets/logo.svg" width="64" height="64" alt="TradeLayer">

# TradeLayer

**Cross-border trade escrow settled by adjudication, not by a signature.**

An importer in Lagos and a supplier in Shenzhen agree terms, the money sits in
an Intelligent Contract, and when they disagree a GenLayer panel reads the
frozen evidence and returns findings. The contract turns those findings into a
payout using remedies **both parties agreed before the goods shipped**.

| | |
|---|---|
| Network | GenLayer StudioNet (chain id `61999`) |
| Contract | `0xE9b6e3FC11EbbB1adA32219CEBF43c9d4a3113e5` |
| Deploy tx | `0x8f59fb9487fb5a94b7782cc976b141ea9eb4b58779806e041b36d51f9371ae25` |
| Source | [`contracts/tradelayer.py`](contracts/tradelayer.py) — sha256 `e8b311385c7a85b865b685904d5f48e5bd4a91f9285c19139a31579f997f4078` |
| On-chain schema | 27 methods — 10 view, 17 write, **1 payable** |
| Tests | 193 direct · 30 web unit · 21 live write-path checks · 27/27 critical guards mutation-checked |
| Status | P0 + P1 complete — contract, suites, live proof, and the browser dApp. |

Deployed bytes were fetched back with `genlayer code` and compared to the
source: **byte-identical**.

---

## 1. The problem

Roughly a fifth of world trade runs on letters of credit — a bank promises to
pay the seller once documents are presented. It works, and it costs 1–3% of
cargo value, takes days to weeks, and is unavailable to small importers in
exactly the corridors that need it most. The alternative is prepayment, which
means the buyer carries all the risk, or open account, which means the seller
does.

Underneath the fee is a genuinely hard problem: **who decides whether the goods
conformed?** That is a judgment about documents, not a number a price feed can
publish. A conventional smart contract cannot make it, so conventional escrow
protocols route around it — a multisig, an appointed arbiter, an oracle
committee. Each of those replaces the bank with a different trusted party.

## 2. What TradeLayer does

Escrow that can adjudicate itself.

- Both parties agree, at creation, on the issues that can be disputed and **the
  remedy in basis points for each**. That table is stored on-chain and is
  immutable afterwards.
- The buyer funds real GEN into the contract.
- The seller ships, binding a carrier reference **before any dispute exists**.
- Either side files evidence, tiered by provenance.
- If the buyer disputes, the package freezes and a GenLayer panel returns
  `CONFORMING` / `BREACH` / `INSUFFICIENT` per agreed issue.
- The contract sums the agreed remedies for the issues found in breach and
  splits the escrow.

**The panel never sees a number and cannot move one.**

## 3. Why GenLayer is necessary

Not "useful" — necessary. Remove it and the protocol has no mechanism.

| Requirement | Why an ordinary chain cannot | What GenLayer provides |
|---|---|---|
| Read a carrier record on the public web | No EVM opcode fetches a URL | `gl.nondet.web.render` inside a consensus block |
| Decide whether a document establishes a breach | Judgment, not arithmetic | `gl.nondet.exec_prompt` under validator consensus |
| Make that judgment binding on money | An off-chain call is one party's word | `gl.eq_principle.prompt_comparative` — validators must independently agree on every decisive field |
| Hold and release value on the outcome | — | Native payable methods and value emission |

An oracle could deliver a price. No oracle delivers "the bill of lading is
inconsistent with the invoice". That sentence is the product.

## 4. Architecture

```
   BUYER ──┐                                    ┌── SELLER
           │            wallet (EIP-1193)       │
           └────────────┬───────────────────────┘
                        │  writeContract / readContract
                        ▼
        ┌───────────────────────────────────────────┐
        │   TRADELAYER INTELLIGENT CONTRACT         │  ← sole source of truth
        │   agreement · escrow ledger · evidence    │
        │   registry · dispute · frozen snapshot    │
        │   findings · remedy table · payout        │
        └───────────────┬───────────────────────────┘
                        │  nondet block, under consensus
                        ▼
        ┌───────────────────────────────────────────┐
        │   GENLAYER ADJUDICATION                   │
        │   fetch the bound carrier record          │
        │   → structured findings per agreed issue  │
        │   → equivalence over the decisive fields  │
        └───────────────┬───────────────────────────┘
                        ▼
              deterministic settlement arithmetic
                        ▼
                    REAL GEN PAYOUT
```

Detail: [`docs/architecture.md`](docs/architecture.md).

## 5. Escrow lifecycle

```
  created ──accept──▶ accepted ──fund──▶ funded ──ship──▶ shipped
                                                              │
                                                          deliver
                                                              ▼
                                                         delivered
                                          ┌───────────────────┴───────────────┐
                              dispute window closes                    buyer disputes
                                          │                                   │
                                          ▼                                   ▼
                                     finalized                            disputed
                                   (SELLER_WIN)                               │
                                          │                    seller responds, or window closes
                                          │                                   ▼
                                          │                            adjudicating ◀──appeal──┐
                                          │                                   │                │
                                          │                              adjudicate            │
                                          │                                   ▼                │
                                          │                          verdict_proposed ─────────┘
                                          │                                   │
                                          │                        appeal window closes
                                          ▼                                   ▼
                                     finalized ◀────────────────────────  finalized
                                          │
                                 settlement delay (300s)
                                          ▼
                                       settled

  Recovery, once the resolution deadline plus a seven-day grace has passed,
  from any state before a verdict is final:

      funded | shipped | delivered | disputed | adjudicating | verdict_proposed
                                  │
                       buyer calls claim_timeout_refund
                                  ▼
                       settled  (reason_code TIMEOUT_RECOVERY)

  Recovery answers SILENCE; it is not a way to win.
    * nothing decided  -> the buyer recovers the whole deposit
    * verdict on record -> the recorded verdict is settled, at its bps
    * delivered, never disputed -> REFUSED; close_undisputed is the route,
      and anyone may call it

  There is no intermediate "refundable" state: the claim IS the withdrawal,
  in one transaction.
```

Escrow is credited from `gl.message.value` — there is no amount parameter
anywhere, so no caller can claim a deposit they did not make. Funding must equal
the agreed amount exactly; overfunding is refused rather than pocketed.

Nothing strands, and nothing is won by waiting. Once the resolution deadline
plus a seven-day grace has passed, the buyer can recover a trade that was never
decided — but a recorded verdict is settled at the payout its findings produced,
and a delivered trade nobody disputed goes to the seller.

## 6. Evidence lifecycle

Three tiers, deliberately not interchangeable:

| Tier | Written by | Establishes |
|---|---|---|
| `AUTHORITATIVE` | **the contract only**, from a source it fetched | independent proof |
| `SUPPORTING` | a party, with sha256 + storage reference | corroboration |
| `PARTY_CLAIM` | a party, free text | nothing on its own |

`submit_evidence` rejects `AUTHORITATIVE` outright — the branch is unreachable
for every caller. A `statement` can only ever be `PARTY_CLAIM`; hashing a
sentence you wrote yourself anchors your own sentence.

The freeze is a status allowlist: evidence is accepted in `funded`, `shipped`,
`delivered` and `disputed`, and in no state after. `begin_adjudication` also
records an ordered digest over the package, and `adjudicate` recomputes it and
refuses if it differs.

Detail: [`docs/evidence-model.md`](docs/evidence-model.md).

## 7. Adjudication

The panel answers one bounded question per agreed issue:

| Finding | Meaning |
|---|---|
| `CONFORMING` | evidence establishes the term was met |
| `BREACH` | evidence establishes a breach |
| `INSUFFICIENT` | evidence establishes neither |

The buyer carries the burden of proof, stated in the prompt. Unknown issues are
discarded, a duplicate issue is ignored, and a verdict missing any agreed issue
is rejected entirely. A failed or malformed panel writes nothing: the trade
returns to `disputed` and stays adjudicable until its deadline.

The equivalence principle pins `ok`, the finding count, every `issue`, every
`result`, `material_breach` and `carrier.readable`; it explicitly frees
`rationale`, `reason_code` and the fetched page excerpt, because honest
validators fetching a live page seconds apart will read different text.

Detail: [`docs/adjudication.md`](docs/adjudication.md).

## 8. Settlement

```python
payout_bps = min(10000, Σ agreed_remedy[issue] for issues found BREACH)
```

Creation refuses a remedy table totalling more than 10000 bps, so
`0 ≤ payout_bps ≤ 10000` holds by construction rather than by validating
something a model produced. `SELLER_WIN` / `BUYER_WIN` / `PARTIAL_SETTLEMENT`
are derived labels, never asserted values.

Every payout obeys one ordering, without exception:

```
READ ledger → VALIDATE → CALCULATE → ZERO + MARK → PERSIST → TRANSFER
```

Recipients are read from storage; no method anywhere accepts a payout address.
Value leaves through a single helper that pays via an empty
`@gl.evm.contract_interface` proxy — the form verified to actually pay an
externally-owned account.

Detail: [`docs/escrow-security.md`](docs/escrow-security.md).

## 9. Wallet connection

Injected **EIP-1193**, discovered via **EIP-6963** — so the connect dialog lists
the wallets actually installed rather than a hardcoded roster of brands. Nothing
is MetaMask-specific. No private key or seed phrase ever enters the app; the
wallet signs, and the contract holds the escrow and decides every outcome.

Every state the interface distinguishes: disconnected, connecting, connected,
wrong network, switching, rejected signature, rejected transaction, pending,
confirmed, failed. None of them is hidden.

**Chain reconciliation.** After `wallet_switchEthereumChain` resolves, the app
**re-reads `eth_chainId`** and retries for a moment before believing it. Several
wallets resolve the switch before it has taken effect, and a write sent on the
strength of the resolved promise fails with *"chainId should be same as current
chainId"* — an error that points at the app and is not the app's fault. That
exact bug took a sibling project's production app down.

### The transaction lifecycle

The write path is stated as it is, never optimistically:

```
Confirm in wallet → Submitted → Pending → GenLayer consensus
                                              ↓
                          Reconciling contract state → Finalized
```

Two rules it exists to enforce:

1. **"Finalized" is never shown because a transaction was submitted.** A step
   lights only once it has genuinely been reached.
2. **A revert is never shown as a success.** GenLayer *finalizes reverts*, so a
   finalized receipt is not a successful one — the leader receipt is
   interrogated, and a rejection is rendered as a rejection with the contract's
   own message.

And a write is only "done" once a **view predicate** confirms contract state
changed. The receipt waiter intermittently reports failure for a transaction
that landed, so state is the authority, not the receipt.

### Screens

| Route | What it is |
|---|---|
| `/` | Landing — the thesis, and live protocol totals |
| `/register` | Every trade on the deployment, filterable, with escrow in custody |
| `/create` | The agreement builder, including the remedy table |
| `/trade/[id]` | The trade room: agreement, remedies, evidence, dispute, adjudication, verdict, settlement, and the actions available to you |
| `/passport/[address]` | Protocol history for an account — counters, deliberately no score |
| `/protocol` | The rules of the venue, every value read live from `get_config` |

### How the interface is proven

The write path is not left to a hand-wave. `web/src/lib/write.ts` has no React
in it — `useTx` is a thin wrapper — so the same module the browser runs can be
driven headlessly against the live contract:

```bash
npm run prove-write-path
```

21 checks against a real trade, including the one that matters most:

```
4 — a REVERTED transaction is reported as reverted, never as finalized
  PASS  it was classified as 'reverted', not 'error' or 'finalized'
  PASS  'finalized' never appeared in the phase sequence
        awaiting-wallet › submitted › pending › consensus › reverted
  PASS  the contract's own message was surfaced
        trade is no longer awaiting acceptance
```

It also checks the interface's action gating against what the contract will
actually accept, at each step. When the UI says *"the seller cannot self-certify
it early"*, the harness sends the transaction anyway and confirms the contract
rejects it with the same reason.

```bash
cd web && npm test
```

30 unit tests over the pure logic — wei formatting at full BigInt precision, and
the gating table exhaustively, without spending a request on a rate-limited
endpoint.

**Not proven, and not claimed:** EIP-6963 wallet discovery and
`wallet_switchEthereumChain` reconciliation. Those need a browser wallet, and
this build has never had one attached.

**Nothing is fabricated.** There are no invented validator counts, no mocked
volume and no placeholder trades — every figure on every screen is a contract
read. Where a value does not exist on chain, the interface says so.

**Actions are explained, not hidden.** An action you cannot take is shown with
the reason (`"Only the buyer may open a dispute"`, `"The appeal window has
closed"`), so the interface teaches the protocol instead of concealing it. That
gating is UX only — the contract re-checks everything against its own consensus
clock, and a stale page produces a correctly rejected transaction rather than a
wrong outcome.

## 10. Local setup

```bash
pip install -r requirements.txt
```

```bash
npm install
```

Then create `.env` (git-ignored):

```
BUYER_PK=0x<studionet key>
SELLER_PK=0x<a different studionet key>
TRADELAYER_ADDRESS=0xE9b6e3FC11EbbB1adA32219CEBF43c9d4a3113e5
```

## 11. Testing

```bash
python -m pytest tests/direct -q
```

**193 tests**, no network and no model calls — every nondeterministic source is
mocked in `tests/direct/conftest.py`.

| Suite | Covers |
|---|---|
| `test_lifecycle_and_authorization.py` | state machine, the authorization matrix, remedy-table validation |
| `test_escrow_and_settlement.py` | funding, splits, rounding, double-settlement, recovery |
| `test_evidence_and_adjudication.py` | tiers, the freeze, panel validation, fail-closed |
| `test_time_security.py` | the consensus clock, window bounds, deadline ordering |

The fixtures model a hostile-but-normal world rather than a friendly one — the
chain-floor source lags 1250 seconds by default, so a passing test has passed
against an indexer that is behind.

**Mutation-checked.** Every critical guard was individually broken in a scratch
copy to confirm the suite fails, each run against a clean accept-control. The
guard-by-guard table lives in
[`docs/escrow-security.md`](docs/escrow-security.md#7-live-verification) so
there is one place to keep honest rather than two.

Three were only detected after the suite was strengthened, and the misses were
the useful part:

- the explicit `status != ADJUDICATING` freeze guard turned out to be **dead
  code** (the allowlist already covered it) and was removed rather than left to
  mislead a reviewer;
- the digest check was unreachable through the public API, so a test now tampers
  with contract storage directly;
- the evidence-description sanitiser — the largest party-controlled channel into
  the prompt — was pinned by nothing. The test named for it asserted
  `payout_bps == 0` after mocking a CONFORMING panel, which restates the mock
  and the remedy arithmetic. It now keys the mock on the **defused** text, so it
  can only pass if the sanitiser actually ran.

That last one is the pattern worth naming: a security test that asserts a
*consequence* the rest of the system already guarantees will pass whether or not
the defence exists.

Lint:

```bash
python -m genvm_linter.cli check contracts/tradelayer.py
```

## 12. Deployment

```bash
npm run deploy
```

```bash
npm run lifecycle
```

The lifecycle script drives the full path against the live contract with real
GEN and runs in wall-clock time (12–15 minutes with the demo windows). Full
instructions, including how to read a reverted transaction: [`docs/deployment.md`](docs/deployment.md).

## 13. Verified end to end

Every row below is a transaction against
`0xE9b6e3FC11EbbB1adA32219CEBF43c9d4a3113e5` on StudioNet, from one run of
`npm run lifecycle`. Trade `TL-1002`, 0.5 GEN of real escrow, **0 failures**.

| Step | Transaction | Outcome |
|---|---|---|
| create_trade | `0x72be7ea38319032215d47ca7f1bdfa7043e892e470207be59a1aaf403f07b73e` | accepted |
| accept_trade | `0x57f3942c2cbb47e35e632fde091f12d2dda81880ed19c62cbeccc1c1477635db` | accepted |
| fund_trade 0.5 GEN | `0x6cac08cb1ace9abf746554e659e105801bbde3a5f152afeb092622b87d485b7b` | accepted |
| underfund attempt | `0xe33a5aea5fd0b855a5e5dc2e79cb96ffe0ae172fd031d3ecc0aaee1ba97fad84` | **rejected** — this trade is already funded |
| mark_shipped | `0x5bf41e25807a25f42b3a87bc4b2a77f99c14b2520c5a38c966887d55e1010780` | accepted |
| seller self-certifies delivery early | `0x29ecc7446749411d715ff36fc918179d946fb57670d5126a82c0e06389dbf0f5` | accepted |
| buyer records delivery | `0xb4f6ac9b003fd647d9c05d259fefce466885c433e10ae6c23e7621345a40758b` | accepted |
| seller files inspection report | `0x96eefa0157b78cc139d5299b175acfe9ab867109c931b31e6364028bbfcb9828` | accepted |
| buyer files a statement | `0x07059b638b5474feb0e1322e5587e238eb79bc1f9fc446d43e94409d013bff6d` | accepted |
| seller self-declares AUTHORITATIVE | `0xf9f47328249551d14ebaa7df770aaf7f879ab24cb1bc7d727589ab651c201d07` | **rejected** — parties may file SUPPORTING or PARTY_CLAIM evidence; AUTHORITATIVE records… |
| open_dispute | `0x3e2d09fb22bd7c305b6666a455e8958cc818999a3a197dd5e04e5042254e9154` | accepted |
| respond_to_dispute | `0xde09632c7a81d146d35972ca98ea1b578d4cb848c52ceefeb0fefa8d77163a40` | accepted |
| begin_adjudication | `0x6c66f07f3be0ae7b66d25c184eb0cada95298effdd86d063ffcdc331f67248f4` | accepted |
| file evidence while frozen | `0x6a5d426c361dc8ac7bae7d281e3d6ad77e3285bd0ddf14be8ed13d84438dbbe9` | **rejected** — the evidence package is frozen: evidence is not accepted in the current trade… |
| adjudicate | `0xec6e6c4da1cda412d104ee119f561dca344c209a4173436c38b03e3ebbbcdc81` | accepted |
| finalize during appeal window | `0x20bc251bee2f6ac0cf10668505a9e1f077a7ad5e36b169396d9e80ebefc7434d` | **rejected** — the appeal window is still open |
| finalize | `0x789ab416bf1aaf563e1b2683a76bce7b9c9bdb4e9ca305810d1fcb3be49d2b5b` | accepted |
| settle before the delay elapses | `0x09922d095dc923d149bc0e35a710747967c08424ecf388e2c041a66f36fba013` | **rejected** — the settlement window is still arming; settlement unlocks shortly after… |
| settle | `0xc211e118df57003fa74e076a76773a5085fdf70d48f5011391805d997a373c59` | accepted |
| second settle | `0xc84bcc52c6c79cb9d875039e2366c5e01d7e0c09f6e2872e7c11181a8e3c6fb3` | **rejected** — this trade has no finalized verdict to settle |

Wallet deltas, not just contract state:

```
buyer  210969999999999999900 -> 211069999999999999900
seller 212720000000000000000 -> 213120000000000000000
```

The two payouts reconstitute the escrow exactly. Full transcript in
`lifecycle.log`.

Live integration suite (`pytest tests/integration --network studionet`):
**8 passed** — invariants swept across every trade on the deployment, plus a
no-privileged-escape check read from the chain's own schema via
`gen_getContractSchema`, not from the local source file.

### What the panel actually did

The buyer claimed model XP-100 was delivered instead of XP-200. The contract
retrieved the carrier record itself — from a host fixed in its own code, under
a reference the seller bound at shipment, before anyone knew what would be
contested — and the panel confined its findings to what that record can
actually support:

| Issue | Finding | Agreed remedy | Why |
|---|---|---|---|
| `PRODUCT_MODEL` | INSUFFICIENT | 65% | the carrier does not open or inspect cargo |
| **`QUANTITY`** | **BREACH** | **20%** | the carrier tallied **900** units against 1,000 agreed |
| `QUALITY_GRADE` | INSUFFICIENT | 10% | a carrier cannot establish a quality grade |
| `SHIPPING_DEADLINE` | CONFORMING | 5% | loaded on board before the deadline |

Nobody told the panel that a bill of lading counts packages but does not verify
contents. It read a record that says so itself — *"the carrier does not open,
inspect, test or grade the cargo"* — and refused the two issues that record
cannot decide, **including the one the buyer actually claimed**, which carried
the largest remedy of the four.

Then the contract did the arithmetic:

```
breached = [QUANTITY]  ->  payout_bps = 2000  ->  PARTIAL_SETTLEMENT
```

`0.1 GEN` to the buyer, `0.4 GEN` to the seller, reason code
`QUANTITY_SHORTFALL`. **The panel never saw the number 2000.** It came from the
remedy table both parties agreed before the goods shipped, and the live run
asserts exactly that:

```
PASS  payout_bps equals the agreed remedies for the breached issues
      breached [QUANTITY] -> expected 2000, got 2000
```

That is the whole thesis, on chain: a judgment about documents, converted to
money by arithmetic nobody can argue with.

### The authoritative path, both ways

`npm run probe` runs the real retrieval and the real panel and returns the
result without touching state or any balance. It was run in both conditions,
and both are worth recording:

| Registry | `carrier.readable` | Excerpt |
|---|---|---|
| Unpublished (404) | `false` | empty |
| Published | `true` | the record, with a sha256 over it |

The empty excerpt is the important half: `gl.nondet.web.render` **raises** on a
404 rather than returning GitHub's error page, so a "404: Not Found" body is
never fenced to the panel as an authoritative carrier record. Latest probe:
`0x4e851f8c79691eb8c22f4826432778b46389d586516ae9a90156c78a32717711`.

## 14. Known limitations

Stated plainly, because a review that only lists strengths is marketing.

1. **The settlement delay is an armed window, not a finality read.** The
   contract cannot ask the chain whether it is final. It separates the verdict
   from the payout, refuses settlement for 300 seconds after finalization, and
   relies on GenLayer executing the outbound value message only at finalization.
   That is real protection and it is not the same thing.

2. **`AUTHORITATIVE` is currently one carrier record.** Public carrier APIs
   need per-carrier keys and a contract cannot hold a secret, so the demo binds a
   registry under the project's own namespace. The *mechanism* is right — fixed
   host, reference bound before the dispute — but the tier does not fully earn
   its name until independent carrier and customs endpoints are wired in.

3. **`document_hash` is anchored, never verified.** The contract records a
   sha256; it cannot fetch IPFS to confirm the bytes. It proves *which* document
   was filed, not that the file exists.

4. **The panel's judgment is constrained, not eliminated.** It cannot pick a
   payout, invent an issue, or answer partially. But a confidently wrong reading
   of genuinely retrieved evidence still maps to a real remedy.

5. **A source outage moves cases toward INSUFFICIENT**, which favours the
   seller. That is the correct failure — the buyer carries the burden of proof —
   but infrastructure availability does shape outcomes.

6. **Reentrancy is not simulated.** `emit_transfer` queues an external message
   rather than making a synchronous call, so a classic reentrant callback is not
   reachable. Tests assert state-before-transfer ordering and that a second
   settlement emits nothing; they do not model a callback the mechanism does not
   provide.

7. **The dApp reads a single page of trades.** `list_trades` is paged at 50 per
   call and the register reads the first page only. A deployment with more
   trades than that needs pagination in the interface — the contract already
   supports it.

## 15. Roadmap

| | |
|---|---|
| ~~P1~~ | ~~Browser dApp~~ — **done**. See §9. |
| P2 | Real carrier and customs endpoints, replacing the demo registry, with per-source reachability probes on-chain |
| P3 | Document retrieval — fetch the storage reference and verify `document_hash` against the bytes, upgrading `SUPPORTING` from anchored to verified |
| P4 | Multi-shipment trades and partial delivery against a single agreement |
| P5 | Stablecoin denomination, so escrow is held in the currency the invoice is written in |

## Repository layout

```
contracts/tradelayer.py            the Intelligent Contract
registry/                          demo carrier records the contract binds
web/                               the browser dApp (Next.js, TypeScript, Tailwind)
web/src/lib/wallet.tsx             injected EIP-1193 + EIP-6963, chain reconciliation
web/src/lib/useTx.ts               the honest write lifecycle
web/src/lib/actions.ts             what each party may do, and why not
tests/direct/                      193 tests, fully mocked
tests/integration/                 invariant tests against a live deployment
scripts/deploy.ts                  deploy + write deploy/deployment.json
scripts/live_lifecycle.ts          the end-to-end on-chain proof
docs/architecture.md               design, written before implementation
docs/escrow-security.md            money-in / money-out review
docs/adjudication.md               the panel, its bounds, and the equivalence
docs/evidence-model.md             provenance tiers and the freeze
docs/deployment.md                 reproduce everything above
```
