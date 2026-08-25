# TradeLayer — Deployment

Everything needed to reproduce the deployed contract, run the suites, and repeat
the live proof.

---

## 1. Current deployment

| | |
|---|---|
| Network | GenLayer StudioNet |
| Chain id | `61999` |
| RPC | `https://studio.genlayer.com/api` |
| Contract | `0x699fff65298c7ba2797DF236E5eB1C0DDB3c3A0F` |
| Deploy tx | `0x6dc4242624cac477973d8998d9b773ec063e9bb34f43163db6abf361ff4f871c` |
| Source | `contracts/tradelayer.py` |
| Runner | `py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6` |
| Explorer | https://explorer-studio.genlayer.com/address/0x699fff65298c7ba2797DF236E5eB1C0DDB3c3A0F |

The artifact is written to `deploy/deployment.json` by the deploy script; it is
the machine-readable copy of the table above.

## 2. Prerequisites

```bash
pip install -r requirements.txt
```

```bash
npm install
```

Python 3.12 and Node 20+. `requirements.txt` pins `genlayer-test`,
`genvm-linter` and `pytest`; `package.json` pins `genlayer-js`, `viem` and
`tsx`.

## 3. Environment

Create `.env` in the project root. It is git-ignored and must stay that way.

```
BUYER_PK=0x<studionet private key>
SELLER_PK=0x<a different studionet private key>
TRADELAYER_ADDRESS=0x699fff65298c7ba2797DF236E5eB1C0DDB3c3A0F
```

Both keys need StudioNet GEN. The buyer key funds escrow and pays for most
transactions; the seller key accepts, ships, delivers and responds. They must be
different accounts — `create_trade` refuses a trade where buyer and seller are
the same address.

## 4. Verify the source before deploying

```bash
python -m genvm_linter.cli check contracts/tradelayer.py
```

Expected:

```
✓ Lint passed (3 checks)
✓ Validation passed
  Contract: TradeLayer
  Methods: 27 (10 view, 17 write)
```

On Windows, prefix with `PYTHONIOENCODING=utf-8` — the linter prints check marks
and the default console codepage cannot encode them.

The first line of the contract is a runner pin:

```python
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

**The blank line after that comment is load-bearing.** Removing it produces an
`invalid_contract` error at deploy time with no useful message.

## 5. Run the suites

```bash
python -m pytest tests/direct -q
```

186 tests, no network and no model calls — every nondeterministic source is
mocked by the `World` fixture in `tests/direct/conftest.py`. Expect roughly 40
seconds.

The fixtures model a hostile-but-normal world rather than a friendly one: the
chain-floor source lags by 1250 seconds by default, so any test that passes has
passed against an indexer that is behind.

## 6. Deploy

```bash
npm run deploy
```

The script prints the deploy transaction, waits for finalization, extracts the
contract address, and writes `deploy/deployment.json`. Copy the printed address
into `.env` as `TRADELAYER_ADDRESS`.

StudioNet occasionally drops a connection while polling (`ECONNRESET`). The
script retries; a stack trace mid-run followed by a printed address means the
deploy succeeded.

**Redeploy whenever a public method's signature changes.** The live scripts call
by positional argument list, and an old deployment will reject the new call with
an argument-count error rather than anything descriptive.

## 7. Run the live proof

```bash
npm run lifecycle
```

This drives the full path against the deployed contract with real GEN: create,
accept, fund, ship, deliver, file evidence, dispute, respond, freeze,
adjudicate, finalize, settle — plus the negative cases (a repeat funding
attempt, a self-declared authoritative tier, a late evidence filing, an early
finalize, an early settle, a double settle).

It runs in **real time**. The appeal window and the settlement delay are wall
clock, so the script sleeps through them. With the demo parameters
(`appeal_window = 300`, `SETTLEMENT_DELAY = 300`) expect 12–15 minutes.

Transcript is written to `lifecycle.log`.

## 7b. Probe the bound sources before trusting them

```bash
npm run probe
```

Runs `preview_adjudication` against the deployed contract — the real retrieval
and the real panel — and returns the case JSON without touching state or any
balance. It prints `carrier.readable`, the excerpt and the digest.

Run this before a demo. A nondeterministic source that silently fails looks
exactly like a feature that was never built, and local tests cannot tell you
whether *validators* can reach a host. It also distinguishes the two failure
modes that look identical from outside: a source that is unreachable, and a
source that returned an error page which then gets presented to the panel as an
authoritative record. On the current deployment it reports:

```
source url : https://raw.githubusercontent.com/Olawalter/TradeLayer/main/registry/MAEU-4471-2026
READABLE   : false
excerpt    : ""
```

An empty excerpt is the good failure: `gl.nondet.web.render` raised on the 404,
so nothing was fenced as authoritative.

## 8. Reading a failure

A reverted GenLayer transaction is not obvious from the receipt's top level. The
reason lives on the leader receipt:

```
consensus_data.leader_receipt[0].execution_result === "ERROR"
consensus_data.leader_receipt[0].result.payload
```

`scripts/genlayer.ts` reads exactly this in `revertReason()`. The *successful*
return value of a write lives in the same place — `leader_receipt[0].result.payload`
— and arrives double-encoded, the payload holding the returned `str` which is
itself JSON. `scripts/probe_carrier.ts` unwraps both layers. Any tool that
checks only `txExecutionResultName` or `messages[]` will report a reverted
transaction as successful on StudioNet, because those fields are undefined or
empty there.

Every deliberate revert in the contract is prefixed `[EXPECTED]`, so an expected
rejection is distinguishable from a genuine fault at a glance.

## 9. Contract constants worth knowing before you drive it

| Constant | Value | Effect |
|---|---|---|
| `SETTLEMENT_DELAY` | 300s | Gap between finalization and any payout |
| `RESPONSE_WINDOW` | 3 days | Seller's time to answer a dispute |
| `RECOVERY_GRACE` | 7 days | After the resolution deadline, buyer may recover |
| `MIN_WINDOW` | 120s | Floor on every caller-supplied window |
| `MAX_WINDOW` | 365 days | Ceiling on every caller-supplied window |
| `MAX_APPEALS` | 2 | Appeals and adjudication rounds both capped |
| `MIN_TRADE_VALUE_WEI` | 0.001 GEN | Dust floor |
| `MAX_EVIDENCE_PER_TRADE` | 24 | Filing cap |
| `MAX_CARRIER_REF` | 64 chars | Cap on the reference printed into the prompt |

`create_trade` refuses a resolution window that does not leave room for
`RESPONSE_WINDOW + appeal_window + MIN_WINDOW`. This is why a demo-length trade
still needs a resolution window a little over three days: a seller must never be
able to run out the clock by staying silent.
