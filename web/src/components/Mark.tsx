/**
 * The TradeLayer mark: three strata of decreasing weight, which is literally
 * the evidence model — solid AUTHORITATIVE, outlined SUPPORTING, dashed
 * PARTY_CLAIM. The clipped corner is the freeze.
 */
export function Mark({ size = 22, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className={className}
      aria-hidden="true"
      fill="none"
    >
      <path d="M2 2h27l7 7v5H2z" fill="currentColor" />
      <rect x="2.9" y="16.9" width="33.2" height="9.2" stroke="currentColor" strokeWidth="1.8" />
      <rect
        x="2.9" y="30.9" width="33.2" height="7.2"
        stroke="currentColor" strokeWidth="1.8"
        strokeDasharray="4 3.5" opacity="0.6"
      />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-baseline gap-2.5 ${className}`}>
      <Mark size={18} className="translate-y-[2px] text-gold" />
      <span className="display text-[21px] tracking-tight text-paper">
        Trade<span className="display-italic text-gold">Layer</span>
      </span>
    </span>
  );
}
