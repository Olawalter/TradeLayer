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
| Contract | `0x699fff65298c7ba2797DF236E5eB1C0DDB3c3A0F` |
| Deploy tx | `0x6dc4242624cac477973d8998d9b773ec063e9bb34f43163db6abf361ff4f871c` |
| Source | [`contracts/tradelayer.py`](contracts/tradelayer.py) — sha256 `c0cb2abec6c89c4c7090bc15f4deac9f380e222005cc424ad228c4d5197c615c` |
| On-chain schema | 27 methods — 10 view, 17 write, **1 payable** |
| Tests | 186 direct · 25/25 critical guards mutation-checked |
| Status | P0 complete — contract, suites, deployment and live proof. Frontend is P1. |

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

The contract is driven today by `genlayer-js` signers in `scripts/`, using two
distinct StudioNet keys for the buyer and the seller. The browser dApp is P1 and
not built yet; this section states what it will do rather than implying it
exists.

When it ships it must, at minimum:

- reconcile the wallet's chain before every write — switch, then **re-read** the
  chain id, because a wallet can report the old chain immediately after an
  `wallet_switchEthereumChain` call;
- surface a reverted transaction as reverted. On StudioNet the verdict lives at
  `consensus_data.leader_receipt[0].execution_result === "ERROR"` with the
  message at `.result.payload`. A frontend reading `txExecutionResultName` or
  `messages[]` reports a rejected write as "Finalized on-chain", because those
  fields are undefined and empty there;
- poll a view predicate before declaring a write done, rather than trusting the
  receipt alone.

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
TRADELAYER_ADDRESS=0x699fff65298c7ba2797DF236E5eB1C0DDB3c3A0F
```

## 11. Testing

```bash
python -m pytest tests/direct -q
```

**186 tests**, no network and no model calls — every nondeterministic source is
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
`0x699fff65298c7ba2797DF236E5eB1C0DDB3c3A0F` on StudioNet, from one run of
`npm run lifecycle`. Trade `TL-1001`, 0.5 GEN of real escrow, **0 failures**.

| Step | Transaction | Outcome |
|---|---|---|
| create_trade | `0xb178f0083910fc86f896539e167c5a123e112d634bbbf786ab788d4a2ab87456` | accepted |
| accept_trade | `0x88cebc7a08ca3c0188f1357a6e6e0ad8ee9266d8536f3ecb4377ca24f2ae5f05` | accepted |
| fund_trade 0.5 GEN | `0xf3e8267218732235ad857127e43ebe3f11e6c6f2cc19dd4e1cee73bd7a269914` | accepted |
| underfund attempt | `0x9060d4637264ffc77e7c0b63e3df925710809f3a042b3b37612b8fb6129118e5` | **rejected** — this trade is already funded |
| mark_shipped | `0xd8a39d2831c5bdcab18cd52c974b76e76216bc76705a3e7036a0a0868132a6b3` | accepted |
| seller self-certifies delivery early | `0x402c87023e094fdfea31254dd502ba0f82056575bd18fb950ca11d212c8836db` | **rejected** — before the agreed delivery deadline, only the buyer may record delivery — the… |
| buyer records delivery | `0x2cae89ee27a3d79b9a7b421cc4bdb895b166147ca32985f44e2dd2fbc0d1ade7` | accepted |
| seller files inspection report | `0x1d7e0f82abe571f41dcffe687c38bd36d6ae40565084a31c2bbb5fc4a416be21` | accepted |
| buyer files a statement | `0x36b9ef05b3a8fc8027dfbbbba09e29c3a0a7eb6ba86bd2ce1a1f53c4d44bc008` | accepted |
| seller self-declares AUTHORITATIVE | `0xb5aebbb8f4e172a7573a2c05008a4f4e3cd302164bd65db4c212e7b2716d4fad` | **rejected** — parties may file SUPPORTING or PARTY_CLAIM evidence; AUTHORITATIVE records… |
| open_dispute | `0xc3cbb3554c258c46f46e910781b8208612f200e88d62a8faf950cbae3bf4f94f` | accepted |
| respond_to_dispute | `0x46da71152ef66be6c537f76b1c3f5701e04cc011649ec2249666ae18f09e32b3` | accepted |
| begin_adjudication | `0x53b68fb7dad0ceddf0751a0be84cb421f11430cdc86d10bd76d232b2e2e9f886` | accepted |
| file evidence while frozen | `0xa9c3ca6d2a231f41195371b2fe17d9d0e68ed1b50283db4d966f15a7fdc79f0f` | **rejected** — the evidence package is frozen: evidence is not accepted in the current trade… |
| adjudicate | `0xc06963b67b8f1b825378c066227f767be9bef10f1d83ebf2433db43890309f9f` | accepted |
| finalize during appeal window | `0xa1f814ade5ae6816cfc0d98f86436f7cc5932704ed68888e2f0da14332c2466a` | **rejected** — the appeal window is still open |
| finalize | `0x2c6cc881c2d25a5902103e3eb50615502a53067ac12c6285552db5a69ac6bb61` | accepted |
| settle before the delay elapses | `0x24def828c5c15f5a8a383f0a9ed171dba5c269cd4041580876fc1718fc35b027` | **rejected** — the settlement window is still arming; settlement unlocks shortly after… |
| settle | `0x32b5702204862a28e4b6217de73e043520b5aacda025997b8a6787b7a9211d0e` | accepted |
| second settle | `0x7a5d3f37cb626cbf00a613ce374ffa2f79447d0ed0afee6fab5f273238beb46d` | **rejected** — this trade has no finalized verdict to settle |

Wallet deltas, not just contract state:

```
seller 211720000000000000000 -> 212220000000000000000   (delta +500000000000000000)
buyer  212519999999999999900 -> 212519999999999999900   (delta 0)
```

The two payouts reconstitute the escrow exactly. Full transcript in
`lifecycle.log`.

Live integration suite (`pytest tests/integration --network studionet`):
**8 passed** — invariants swept across every trade on the deployment, plus a
no-privileged-escape check read from the chain's own schema via
`gen_getContractSchema`, not from the local source file.

### What the panel actually did

Against a buyer's unsupported claim that model XP-100 was delivered, and with
**no authoritative record retrievable**, it returned `INSUFFICIENT` on all four
issues — so the derived payout was 0 bps and the seller kept the escrow. That is
the burden of proof working, not the system failing to decide.

An on-chain probe (`npm run probe`, tx
`0xbe42203296b954fa205ae08468d3c1114f6fe5b9a9e6ea150d3b8ad9b052ecdb`) confirms
why, and confirms it fails in the right direction:

```
source url : https://raw.githubusercontent.com/Olawalter/TradeLayer/main/registry/MAEU-4471-2026
READABLE   : false
excerpt    : ""
```

`gl.nondet.web.render` **raises** on the 404 rather than returning GitHub's
error page — so a "404: Not Found" body is never presented to the panel as an
authoritative carrier record. The panel is told plainly that no record could be
retrieved, and reasons from that. From an earlier run's rationale, verbatim:

> "The seller's recorded shipment time is not proof of loading and no
> authoritative carrier record was retrieved to establish shipment before the
> deadline."

That sentence is the protocol's own rule coming back out of a live validator
panel — the rule exists precisely so a seller's own bookkeeping cannot stand in
for a carrier record.

**Why the record is unreachable:** the contract binds a registry under
`github.com/Olawalter/TradeLayer`, and that repository is not published yet.
[`registry/MAEU-4471-2026`](registry/MAEU-4471-2026) is written and waiting;
publishing it makes the `AUTHORITATIVE` path live without touching the contract.
This is called out rather than left as an unexplained row of `INSUFFICIENT`.

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

7. **No frontend yet.** P0 is contract, suites, deployment and live proof.

## 15. Roadmap

| | |
|---|---|
| P1 | Browser dApp: create, fund, ship, file evidence, dispute, adjudicate, settle, with an honest transaction lifecycle |
| P2 | Real carrier and customs endpoints, replacing the demo registry, with per-source reachability probes on-chain |
| P3 | Document retrieval — fetch the storage reference and verify `document_hash` against the bytes, upgrading `SUPPORTING` from anchored to verified |
| P4 | Multi-shipment trades and partial delivery against a single agreement |
| P5 | Stablecoin denomination, so escrow is held in the currency the invoice is written in |

## Repository layout

```
contracts/tradelayer.py            the Intelligent Contract
registry/                          demo carrier records the contract binds
tests/direct/                      186 tests, fully mocked
tests/integration/                 invariant tests against a live deployment
scripts/deploy.ts                  deploy + write deploy/deployment.json
scripts/live_lifecycle.ts          the end-to-end on-chain proof
docs/architecture.md               design, written before implementation
docs/escrow-security.md            money-in / money-out review
docs/adjudication.md               the panel, its bounds, and the equivalence
docs/evidence-model.md             provenance tiers and the freeze
docs/deployment.md                 reproduce everything above
```
