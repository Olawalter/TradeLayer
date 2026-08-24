# Demo carrier registry

Static records served at
`https://raw.githubusercontent.com/Olawalter/TradeLayer/main/registry/<reference>`,
which is the `DEMO_REGISTRY` entry in the contract's `CARRIER_SOURCES` map.

**These are demonstration records, not a carrier feed.** They exist because
real carrier APIs (Maersk, MSC) require per-carrier API keys, and an Intelligent
Contract cannot hold a secret — every validator would need it, which means it is
not a secret. This is stated in the README's limitations section rather than
glossed over.

## What the mechanism proves even with demo data

The property the tier system depends on is *ordering*, and it holds here:

- the **host** is a contract constant — no caller supplies a URL;
- the **reference** is bound at `mark_shipped`, before any dispute exists, by
  the seller, at a moment when nobody knows what will be contested;
- neither party can change it afterwards — there is no setter.

So a disputing party can neither choose where the contract looks nor what it
looks for. Swapping this registry for a real carrier endpoint changes the data
source, not the trust argument.

## Format

Plain text, one file per booking reference, no extension — `raw.githubusercontent.com`
serves it as `text/plain`, which is what `gl.nondet.web.render(url, mode="text")`
reads.

A record deliberately distinguishes **what the carrier tallied** (package count,
loading date, routing) from **what the shipper declared** (cargo description).
That is how a real bill of lading works: the carrier counts packages, it does
not open them. It is also why an honest panel should find `QUANTITY` and
`SHIPPING_DEADLINE` decidable from this record and `PRODUCT_MODEL` /
`QUALITY_GRADE` not — a carrier record cannot establish a model number or a
quality grade, and a panel that claims otherwise is guessing.

## Adding a record

Name the file exactly as the normalised carrier reference the seller will bind:
uppercase, no spaces (`_norm_ref` in the contract). Anything else 404s, and the
contract treats an unreachable record as "no authoritative evidence" rather than
inventing one.
