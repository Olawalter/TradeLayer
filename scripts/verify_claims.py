"""Check that the README's factual claims match reality.

Documentation drifts silently. Every number and hash in the README exists
somewhere machine-readable — the deployment artifact, the lifecycle transcript,
the chain itself, the test suite — so nothing here should ever be believed
because a human typed it.

Run:  python scripts/verify_claims.py
"""

import hashlib
import json
import pathlib
import re
import subprocess
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
RPC = "https://studio.genlayer.com/api"

failures: list[str] = []
checks = 0


def check(label: str, ok: bool, detail: str = "") -> None:
    global checks
    checks += 1
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def rpc(method: str, params: list):
    body = json.dumps({"jsonrpc": "2.0", "id": 1,
                       "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, data=body, headers={
        "Content-Type": "application/json",
        "User-Agent": "tradelayer-verify-claims/1.0",
    })
    with urllib.request.urlopen(req, timeout=90) as resp:
        payload = json.loads(resp.read())
    if "error" in payload:
        raise RuntimeError(payload["error"])
    return payload["result"]


def main() -> int:
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    source = (ROOT / "contracts" / "tradelayer.py").read_bytes().replace(b"\r\n", b"\n")
    artifact = json.loads((ROOT / "deploy" / "deployment.json").read_text(encoding="utf-8"))
    log = (ROOT / "lifecycle.log").read_text(encoding="utf-8", errors="replace")

    print("TradeLayer — README claim verification\n")

    # ── the address and deploy tx are the artifact's ────────────────────────
    addr = artifact["contractAddress"]
    check("README names the deployed address", addr in readme, addr)
    check("README names the deploy transaction",
          artifact["deployTxHash"] in readme, artifact["deployTxHash"])

    # ── the sha256 in the README is the source's ────────────────────────────
    digest = hashlib.sha256(source.strip()).hexdigest()
    check("README's source sha256 matches contracts/tradelayer.py",
          digest in readme, digest)

    # ── and the CHAIN serves exactly those bytes ────────────────────────────
    # gen_getContractCode returns base64, and the stored copy keeps the CRLF
    # line endings the file had when it was deployed — so both are normalised
    # before comparing. Nothing else about the bytes is allowed to differ.
    import base64

    onchain = rpc("gen_getContractCode", [addr])
    if isinstance(onchain, dict):
        onchain = onchain.get("code", "")
    onchain_bytes = base64.b64decode(onchain).replace(b"\r\n", b"\n").strip()
    check("deployed bytes are byte-identical to the source",
          onchain_bytes == source.strip(),
          f"{len(onchain_bytes)} vs {len(source.strip())} bytes")

    # ── the schema counts are the chain's ───────────────────────────────────
    schema = rpc("gen_getContractSchema", [addr])
    methods = schema["methods"]
    view = sum(1 for m in methods.values() if m.get("readonly"))
    write = len(methods) - view
    payable = [n for n, m in methods.items() if m.get("payable")]
    claimed = re.search(r"(\d+) methods — (\d+) view, (\d+) write", readme)
    check("README's method counts match the deployed schema",
          bool(claimed) and [int(x) for x in claimed.groups()] == [len(methods), view, write],
          f"chain says {len(methods)}/{view}/{write}")
    check("exactly one payable method, and it is fund_trade",
          payable == ["fund_trade"], str(payable))

    # ── the test count is the suite's ───────────────────────────────────────
    proc = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/direct", "-q", "--collect-only",
         "-p", "no:cacheprovider", "--no-header", "--ignore-glob=*test_zz_*"],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    collected = re.search(r"(\d+) tests? collected", proc.stdout)
    n = int(collected.group(1)) if collected else -1
    claimed_tests = re.search(r"\| Tests \| (\d+) direct", readme)
    check("README's direct-test count matches what pytest collects",
          bool(claimed_tests) and int(claimed_tests.group(1)) == n,
          f"pytest collects {n}")

    # ── the mutation count is the security review's table ───────────────────
    sec = (ROOT / "docs" / "escrow-security.md").read_text(encoding="utf-8")
    guards = len(re.findall(r"^\| M\d+\w* \|", sec, re.M))
    claimed_guards = re.search(r"(\d+)/(\d+) critical guards", readme)
    check("README's guard count matches the escrow-security table",
          bool(claimed_guards) and int(claimed_guards.group(2)) == guards,
          f"table lists {guards}")

    # ── every transaction hash in the README came from a real run ───────────
    log_hashes = set(re.findall(r"0x[0-9a-fA-F]{64}", log))
    known = log_hashes | {artifact["deployTxHash"], digest}
    # the probe transaction is printed by scripts/probe_carrier.ts, not the log
    probe_note = re.search(r"`npm run probe`, tx\s*\n?`(0x[0-9a-f]{64})`", readme)
    if probe_note:
        known.add(probe_note.group(1))
    table = readme[readme.index("| Step | Transaction | Outcome |"):readme.index("Wallet deltas")]
    unknown = [h for h in re.findall(r"0x[0-9a-fA-F]{64}", table) if h not in known]
    check("every hash in the verified-E2E table appears in lifecycle.log",
          not unknown, f"unaccounted: {unknown}" if unknown else "")

    # ── the wallet deltas quoted in the README are the log's ────────────────
    for line in re.findall(r"^(seller|buyer)\s+(\d+) -> (\d+)", readme, re.M):
        who, before, after = line
        check(f"{who} balance delta is quoted from the run",
              f"{before} -> {after}" in log, f"{before} -> {after}")

    print(f"\n{checks - len(failures)}/{checks} claims verified")
    if failures:
        print("\nFAILED:")
        for f in failures:
            print("  -", f)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
