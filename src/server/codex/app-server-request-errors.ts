/** A request Codex never received or answered: it was refused locally, or the transport closed. */
export class CodexRequestRefusedError extends Error {}

/** A JSON-RPC error response from the App Server. */
export class CodexErrorResponse extends CodexRequestRefusedError {
  constructor(message: string, readonly code: number | null = null) {
    super(message);
  }
}

/** JSON-RPC "method not found": the App Server refused the request before acting on it. */
export const CODEX_METHOD_NOT_FOUND = -32601;

/**
 * Whether the App Server does not know `method` and refused it before acting
 * on it. JSON-RPC says -32601; App Server 0.169.0 instead fails to decode the
 * request as -32600 "Invalid request: unknown variant `<method>`" (observed
 * against `codex app-server` with an empty CODEX_HOME).
 */
export function isCodexUnknownMethod(method: string, code: number | null, message: string): boolean {
  return code === CODEX_METHOD_NOT_FOUND
    || (code === -32600 && message.includes(`unknown variant \`${method}\``));
}

/**
 * Whether a failed request becomes the run's failure: always, never, or by the
 * error response's JSON-RPC code (null for a timeout) and message.
 */
export type CodexRequestFailureRecording = boolean | ((code: number | null, message: string) => boolean);

// Codex holds a per-thread writer lock while the thread is loaded in any App
// Server sharing the same CODEX_HOME (the Codex app, CLI or an IDE extension),
// and refuses a second writer this way. A fresh session would split the
// conversation from that client, so this is neither a rejected nor a missing
// session (T3 Code a445272c7).
export function isCodexActiveWriterError(error: unknown): boolean {
  return error instanceof CodexErrorResponse && error.code === -32600
    && error.message.includes("already has an active writer");
}
