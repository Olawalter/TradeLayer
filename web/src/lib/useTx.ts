"use client";

/**
 * React wrapper around `runWrite`.
 *
 * Deliberately thin: all of the logic that could be wrong — revert detection,
 * state reconciliation, phase ordering — lives in `write.ts`, which has no
 * React in it and is driven against the live contract by
 * `scripts/prove_write_path.ts`. A pipeline that can only run inside a
 * component is a pipeline nothing can prove.
 */

import { useCallback, useRef, useState } from "react";
import { runWrite, type SendOptions, type TxPhase } from "./write";
import type { Eip1193Provider } from "./wallet";

export { PHASE_COPY, PHASE_STEPS } from "./write";
export type { TxPhase, SendOptions } from "./write";

export interface TxState {
  phase: TxPhase;
  hash: `0x${string}` | null;
  message: string | null;
  label: string | null;
}

const IDLE: TxState = { phase: "idle", hash: null, message: null, label: null };

export function useTx() {
  const [state, setState] = useState<TxState>(IDLE);
  const running = useRef(false);

  const reset = useCallback(() => setState(IDLE), []);

  const send = useCallback(
    async (
      address: `0x${string}`,
      provider: Eip1193Provider,
      opts: SendOptions
    ): Promise<boolean> => {
      if (running.current) return false;
      running.current = true;
      try {
        const result = await runWrite(address, provider, opts, (r) =>
          setState((s) => ({
            ...s,
            label: opts.label,
            phase: r.phase,
            hash: r.hash !== undefined ? r.hash : s.hash,
            message: r.message !== undefined ? r.message : s.message,
          }))
        );
        return result.ok;
      } finally {
        running.current = false;
      }
    },
    []
  );

  // `busy` is deliberately NOT returned from the ref: reading a ref during
  // render is unreliable. Every caller derives it from state.phase.
  return { state, send, reset };
}
