import { MAX_HISTORY_INJECTION_BYTES, type ProviderHistoryInjection } from "../provider/contracts";
import {
  CodexErrorResponse,
  isCodexUnknownMethod,
  type CodexRequestFailureRecording,
} from "./app-server-request-errors";
import { objectValue, type JsonObject } from "./protocol";

export class CodexHistoryInjectionError extends Error {}

const INJECT_METHOD = "thread/inject_items";

/**
 * Delivers a turn's restored history with `thread/inject_items` on the opened
 * thread, before any turn starts (T3 `CodexAdapterV2.injectHistory` and
 * `deliverContextHandoffs`). Returns the prompt the turn sends: without its
 * history block once the items are injected, else the inline prompt.
 *
 * - Nothing is sent, and the history stays inline, while a turn is active on
 *   the thread, after a Stop, above the size bound, or when `begin` could not
 *   record the attempt.
 * - An unknown method (JSON-RPC -32601, or 0.169.0's -32600 "unknown variant")
 *   is refused before any history mutation: the same turn carries the history
 *   inline. Recorded without failing the run. Nothing is remembered: the next
 *   turn tries again, as in T3.
 * - Any other error, a malformed response, a closed transport or a timeout
 *   leaves delivery ambiguous: it throws, the run fails and the handoff stays
 *   uncertain, so the next turn starts a fresh thread with a full restore.
 */
export async function injectCodexHistory(input: {
  history: ProviderHistoryInjection | undefined;
  prompt: string;
  threadId: string;
  thread: JsonObject | undefined;
  turnActive: boolean;
  cancelRequested: () => boolean;
  request: (method: string, params: JsonObject, onResponseFrame?: (result?: JsonObject) => void,
    recordFailure?: CodexRequestFailureRecording) => Promise<JsonObject>;
}): Promise<string> {
  const { history } = input;
  if (
    !history
    || input.turnActive
    || objectValue(input.thread?.status)?.type === "active"
    || input.cancelRequested()
    || Buffer.byteLength(JSON.stringify(history.items), "utf8") > MAX_HISTORY_INJECTION_BYTES
    || !history.begin()
  ) return input.prompt;
  let wellFormed = false;
  try {
    await input.request(
      INJECT_METHOD,
      { threadId: input.threadId, items: history.items.map((item) => ({ ...item })) },
      (result) => {
        // The protocol answers an empty object; anything else is not a confirmation.
        wellFormed = result !== undefined;
      },
      (code, message) => !isCodexUnknownMethod(INJECT_METHOD, code, message),
    );
  } catch (error) {
    if (!(error instanceof CodexErrorResponse) || !isCodexUnknownMethod(INJECT_METHOD, error.code, error.message)) throw error;
    if (!history.unsupported()) {
      throw new CodexHistoryInjectionError("Inertia could not record that Codex does not support history injection.");
    }
    return input.prompt;
  }
  if (!wellFormed) throw new CodexHistoryInjectionError("Codex returned a malformed history injection response.");
  if (!history.delivered()) throw new CodexHistoryInjectionError("Inertia could not record the injected history.");
  return history.prompt;
}
