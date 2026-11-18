import type { RuntimeStore } from "../../database";
import { MAX_HISTORY_INJECTION_BYTES, type ProviderHistoryInjection } from "../../provider/contracts";
import type { ActiveTurn } from "./turn-controller-types";

/**
 * The authority a harness uses to deliver this turn's restored history
 * natively, bound to one attempt: a stale or replaced attempt writes nothing
 * and is told so. Undefined when the turn has no restored history to deliver
 * or it exceeds the injection bound; the history then stays inline.
 */
export function turnHistoryInjection(
  store: RuntimeStore,
  active: Pick<ActiveTurn, "turn" | "nativeHistory">,
  attemptId: string | null | undefined,
): ProviderHistoryInjection | undefined {
  const native = active.nativeHistory;
  if (!native || !attemptId
    || Buffer.byteLength(JSON.stringify(native.items), "utf8") > MAX_HISTORY_INJECTION_BYTES) return undefined;
  const runId = active.turn.runId;
  const step = (name: "begin" | "delivered" | "unsupported") => (): boolean => {
    try {
      return store.orchestration.historyInjection(runId, attemptId, name);
    } catch {
      // A write that failed records nothing; the harness must not act as if it had.
      return false;
    }
  };
  return { items: native.items, prompt: native.prompt,
    begin: step("begin"), delivered: step("delivered"), unsupported: step("unsupported") };
}
