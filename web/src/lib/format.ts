/**
 * Formatting. Every wei quantity arrives as a decimal STRING and is formatted
 * with BigInt — never parsed into a Number, which loses precision above 2^53
 * and would silently misreport a balance.
 */

export function gen(wei: string | bigint | undefined, dp = 4): string {
  if (wei === undefined || wei === "") return "—";
  let v: bigint;
  try {
    v = typeof wei === "bigint" ? wei : BigInt(wei);
  } catch {
    return "—";
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").slice(0, dp);
  const trimmed = frac.replace(/0+$/, "");
  const s = trimmed ? `${whole.toLocaleString("en-US")}.${trimmed}` : whole.toLocaleString("en-US");
  return neg ? `-${s}` : s;
}

export function toWei(amount: string): bigint {
  const clean = amount.trim();
  if (!/^\d*\.?\d*$/.test(clean) || clean === "" || clean === ".") {
    throw new Error("Enter a number, for example 0.5");
  }
  const [w = "0", f = ""] = clean.split(".");
  if (f.length > 18) throw new Error("At most 18 decimal places");
  return BigInt(w || "0") * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18));
}

export function bps(v: number | string): string {
  const n = typeof v === "string" ? Number(v) : v;
  if (!Number.isFinite(n)) return "—";
  return `${(n / 100).toFixed(n % 100 === 0 ? 0 : 2)}%`;
}

export function short(addr: string | undefined, lead = 6, tail = 4): string {
  if (!addr) return "—";
  if (addr.length <= lead + tail + 2) return addr;
  return `${addr.slice(0, lead)}…${addr.slice(-tail)}`;
}

/** Absolute UTC — a trade spans time zones, so local time would mislead. */
export function utc(epoch: string | number | undefined): string {
  const n = Number(epoch ?? 0);
  if (!n) return "not set";
  return new Date(n * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function utcShort(epoch: string | number | undefined): string {
  const n = Number(epoch ?? 0);
  if (!n) return "—";
  return new Date(n * 1000).toISOString().slice(0, 10);
}

/**
 * A duration a reader can act on. Deliberately coarse above an hour: showing
 * "2d 7h 41m 09s" implies a precision the consensus clock does not have.
 */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  const d = Math.floor(s / 86400);
  return `${d}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** Signed: negative means the deadline has passed. */
export function until(epoch: string | number | undefined, now: number): string {
  const n = Number(epoch ?? 0);
  if (!n) return "not set";
  const delta = n - now;
  return delta >= 0 ? `in ${duration(delta)}` : `${duration(-delta)} ago`;
}

export function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
