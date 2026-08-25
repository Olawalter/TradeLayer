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
| Tests | 193 direct · 27/27 critical guards mutation-checked |
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
`npm run lifecycle`. Trade `TL-1000`, 0.5 GEN of real escrow, **0 failures**.

| Step | Transaction | Outcome |
|---|---|---|
| create_trade | `0x5bee22db2a92afca853fd7f17d5ac250452a8434bc36d01c44bc5dafe8032061` | accepted |
| accept_trade | `0xe887af59e09470b7584fb6cb16193d92554a9ecc37a565073dd0cb85581fadcd` | accepted |
| fund_trade 0.5 GEN | `0x3f7ef91a5185bc89855fdf4ee470b6b562e446fe526e209a714238cdc5d4c3aa` | accepted |
| underfund attempt | `0xa1f7789b58b6c4cebe30c9c4a60e917b14c6f78498111274ab717d875b82e8dc` | **rejected** — this trade is already funded |
| mark_shipped | `0x3e4557f65b704952bc32997ef83db49257dc6077222979bd7fbbe3a1eae197ec` | accepted |
| seller self-certifies delivery early | `0xd0a56772b0a4f70dfd4ad1743493a2884e99648731aa8ce17c6a22077600e8a2` | **rejected** — before the agreed delivery deadline, only the buyer may record delivery — the… |
| buyer records delivery | `0x4804a77276f0ac0304af108a363abb0b85db278f3bdf8a2b562146470600fdff` | accepted |
| seller files inspection report | `0x91a68689c4a510ba8ce1399dd723a1983bcf6e17c62825bf23697f8ffa192989` | accepted |
| buyer files a statement | `0x0110297709fa42b2967a9a7221a3bb71faf780036f3bb9e56be8788a43df0392` | accepted |
| seller self-declares AUTHORITATIVE | `0x8495c454bd036bb775e8b133b82f8c09396c3f3720ca58f4aaf91aa73a498564` | **rejected** — parties may file SUPPORTING or PARTY_CLAIM evidence; AUTHORITATIVE records… |
| open_dispute | `0x1fbb92a093a4b98cf5b511d20f317c6f7e48f047b03ef2e57fa9855d335dd361` | accepted |
| respond_to_dispute | `0xcb5dbafd050ef7b591f29aab98a6744f22b1486cba8db93800aa7c193596e277` | accepted |
| begin_adjudication | `0x8b3ee7cda0bbd5af01bc675695ec0db09f4d80271f9f2b69568de93003e791eb` | accepted |
| file evidence while frozen | `0x9522352613b484b29ec048b53715d1aab86ceb79e687922fd7d30e0d4234a5c0` | **rejected** — the evidence package is frozen: evidence is not accepted in the current trade… |
| adjudicate | `0x88ffeed0c5c4c646d240f188f95c1d41762747750b898c13342046fef0af2b8b` | accepted |
| finalize during appeal window | `0xfffee09383cab6325247972a84fd1efe049cfe5b81168446f3821b6ef7e1c2ee` | **rejected** — the appeal window is still open |
| finalize | `0x0ac842e886c97c1e6b1c6021aef3938de98385161e6f4f235bc07aa481ad8454` | accepted |
| settle before the delay elapses | `0x35f72454e9e90260e9b897696cba2187083c3e8fb4fdab9c2bfaf7eb9866f793` | **rejected** — the settlement window is still arming; settlement unlocks shortly after… |
| settle | `0x49894d3a5bb1931ca95745a1c7c14dd5bb4bd63a073d99a6fce9edfc43fc0c26` | accepted |
| second settle | `0xccf3c51c311ddf2050df5ebd3754badf3703d40b6af886db25eaf07e52dbc81f` | **rejected** — this trade has no finalized verdict to settle |

Wallet deltas, not just contract state:

```
buyer  211769999999999999900 -> 211769999999999999900
seller 212220000000000000000 -> 212720000000000000000
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
`0x7c38ab27a1ef92f15d446400b64d5bd36e5d15f2ebb04d6a84c2dea8ad58c1ce`) confirms
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
