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
| Contract | `0xB9526c7Aaefd3a81C056Df1102EcBF5Ca610CCA4` |
| Deploy tx | `0xbb658933a1d2b91a82ad123838a2f2b95369b2da188bc7295369889f1eebc41f` |
| Source | [`contracts/tradelayer.py`](contracts/tradelayer.py) — sha256 `ab619308efd4f80832fc869dbe0d53c4109db2955dd205377301baf455e7a77f` |
| On-chain schema | 27 methods — 10 view, 17 write, **1 payable** |
| Tests | 161 direct · 13/13 critical guards mutation-checked |
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
                                       settled          ── or ──▶  refundable
                                                                   (resolution deadline
                                                                    + 7-day grace passed;
                                                                    buyer recovers)
```

Escrow is credited from `gl.message.value` — there is no amount parameter
anywhere, so no caller can claim a deposit they did not make. Funding must equal
the agreed amount exactly; overfunding is refused rather than pocketed.

Nothing strands. From any pre-terminal state, once the resolution deadline plus
a seven-day grace has passed, the buyer can recover the deposit.

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
TRADELAYER_ADDRESS=0xB9526c7Aaefd3a81C056Df1102EcBF5Ca610CCA4
```

## 11. Testing

```bash
python -m pytest tests/direct -q
```

**161 tests**, no network and no model calls — every nondeterministic source is
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

**Mutation-checked.** Nine guards were individually broken in a scratch copy to
confirm the suite fails: the remedy arithmetic, the remedy-table cap, the
settlement delay, the freeze, the tier allowlist, the beacon ceiling, the
complete-findings rule, the payout clamp, and the digest integrity check. All
nine were detected — two only after the suite was strengthened:

- the explicit `status != ADJUDICATING` freeze guard turned out to be **dead
  code** (the allowlist already covered it) and was removed rather than left to
  mislead a reviewer;
- the digest check was unreachable through the public API, so a test now tampers
  with contract storage directly.

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
`0xB9526c7Aaefd3a81C056Df1102EcBF5Ca610CCA4` on StudioNet, from one run of
`npm run lifecycle`. Trade `TL-1000`, 0.5 GEN of real escrow, **0 failures**.

| Step | Transaction | Outcome |
|---|---|---|
| create trade | `0xc0c59bc63a8220a18079f414dcf8c8a187d6cac0a8ce947b52c0915c351c8099` | remedy table stored, nothing deposited |
| seller accepts | `0xfd9d4e1e4a9eba0600cc3ccde287f5c35a1699b83eb1acd3f0931a3a364ab88c` | `accepted` |
| buyer funds 0.5 GEN | `0xe43d0a567854b75ded5d1a4e2fc125a3d5a056163bb6a4120b54cb2a8c8f57ce` | buyer balance falls; GEN in custody |
| second funding attempt | `0x1e11b32aa2bbf88246ec4d8961cc3fa6912b10629b2ca906674b913fbe850143` | **rejected** — "already funded", ledger unchanged |
| seller ships | `0x88c3837ae619b0e5105634d838abc8ed1f934c9e123ec20ce241e55318c83eea` | carrier ref `MAEU-4471-2026` bound pre-dispute |
| delivery recorded | `0xac11ff91f678e88af260a10bff01c020d72fb56ae152f7f530b89220cb973009` | dispute window opens |
| seller files inspection report | `0x12e8b70a…` (SUPPORTING) | hash-anchored |
| buyer files a statement | `0xa20ea2a3…` (PARTY_CLAIM) | recorded, establishes nothing |
| seller self-declares AUTHORITATIVE | tx submitted | **rejected** — parties may not write that tier |
| buyer disputes | `0xc03aaa1cf1844c22a8eed462f719e76259205deec5dfbff17567b63fbd28576a` | `disputed` |
| seller responds | `0xd292a6de36629ddc2f5dd78f6c35cec17df629a0e51fd2a84c0e0009d1e140c3` | response recorded |
| freeze the package | `0xbb326e21d982a04080ec959ef84792df9eb2757c2fa2ae79e244dce44f2bc981` | 64-char digest recorded |
| file evidence while frozen | `0x3c4c0aeff411d5047e2c049acaaac4dfaa6432697717bacb8aa659aeb6cb03f7` | **rejected** — "the evidence package is frozen" |
| **GenLayer adjudicates** | `0xed28444e6180c8237110ed8d152acaaa53b90af0ca732f40c704f05196c0569e` | 4 findings, `SELLER_WIN`, `payout_bps 0` |
| finalize during appeal window | `0xd04699c0c02ed7c9a352c885e7626f7de8c9343a640bb3e219d3bd35e5626279` | **rejected** — "the appeal window is still open" |
| finalize | `0xb82244a49e57684a322b8058c5ce1b16fd9d40e68b27fe7ea6ea45517683eb4d` | `finalized`, settlement armed |
| settle before the delay | `0xf712873ecc86d2ec6026c4762e96e3fe9dc9101befb53efaffceca5662b8e5e1` | **rejected** — "still arming" |
| **settle** | `0xa2c69c4b965c83d6acb83b04f84972a6c7138c1cc2ba20112182a23173c7f4b8` | seller **+0.5 GEN**, buyer **0**, ledger zeroed |
| second settlement | `0xf9662f6f04a6b7a1659d601ab23deebca66d66e3e01d91b45ec7d4245e9fddc2` | **rejected**, no additional value left the contract |

Wallet deltas, not just contract state:

```
seller 211220000000000000000 -> 211720000000000000000   (delta +500000000000000000)
buyer  214019999999999999900 -> 214019999999999999900   (delta 0)
```

The two payouts reconstitute the escrow exactly.

### What the panel actually did

Against a buyer's unsupported claim that model XP-100 was delivered, and with
**no authoritative record retrievable**, it returned `INSUFFICIENT` on all four
issues — so the derived payout was 0 bps and the seller kept the escrow. That is
the burden of proof working, not the system failing to decide.

An on-chain probe (`npm run probe`, tx
`0x811fbd9b8c1676bfaded12ddafb3e0a7fa084c4f9c6c97b44a14bdda5f66b7bf`) confirms
why, and confirms it fails in the right direction:

```
source url : https://raw.githubusercontent.com/Olawalter/TradeLayer/main/registry/MAEU-4471-2026
READABLE   : false
excerpt    : ""
```

`gl.nondet.web.render` **raises** on the 404 rather than returning GitHub's
error page — so a "404: Not Found" body is never presented to the panel as an
authoritative carrier record. The panel is told plainly that no record could be
retrieved, and reasons from that:

> "The seller's recorded shipment time is not proof of loading and no
> authoritative carrier record was retrieved to establish shipment before the
> deadline."

That sentence is the protocol's own rule coming back out of a live validator
panel.

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
tests/direct/                      161 tests, fully mocked
tests/integration/                 invariant tests against a live deployment
scripts/deploy.ts                  deploy + write deploy/deployment.json
scripts/live_lifecycle.ts          the end-to-end on-chain proof
docs/architecture.md               design, written before implementation
docs/escrow-security.md            money-in / money-out review
docs/adjudication.md               the panel, its bounds, and the equivalence
docs/evidence-model.md             provenance tiers and the freeze
docs/deployment.md                 reproduce everything above
```
