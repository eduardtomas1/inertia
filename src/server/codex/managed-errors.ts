import type { OrchestrationRunFailureCode } from "../../shared/orchestration-v2";

/**
 * Structured service failures Codex wraps in its generic turn errors (T3 `CodexManagedErrors.ts`). Each code
 * replaces Codex's raw message with a safe summary, and a later turn may act on it. T3's ChatGPT sharing codes
 * are not ported here.
 */
const failures = {
  invalid_encrypted_content: {
    message:
      "Codex could not verify this session's encrypted conversation history. Send another message to continue in a fresh session with the visible conversation history.",
  },
} as const satisfies Record<OrchestrationRunFailureCode, { message: string }>;

/**
 * An App Server frame may reach 16 MiB. A service response serialized into a longer error string is not
 * parsed and classifies as nothing (T3 parses any length); real managed responses are a few hundred bytes.
 */
export const MAX_CODEX_MANAGED_ERROR_CHARS = 16_384;

export interface CodexManagedFailure {
  code: OrchestrationRunFailureCode;
  message: string;
}

function unwrapError(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length > MAX_CODEX_MANAGED_ERROR_CHARS) return value;
    try {
      value = JSON.parse(value);
    } catch {
      return value;
    }
  }
  return typeof value === "object" && value !== null && "error" in value ? value.error : value;
}

function isManagedCode(value: unknown): value is OrchestrationRunFailureCode {
  return typeof value === "string" && Object.hasOwn(failures, value);
}

function managedCode(value: unknown): OrchestrationRunFailureCode | undefined {
  const error = unwrapError(value);
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : error;
  return isManagedCode(code) ? code : undefined;
}

/**
 * The managed failure Codex reported, from its error object (`message`, `additionalDetails`, or a `code`),
 * a service response serialized into one of those strings (`{"error":{"code":…}}`), or the bare code.
 */
export function classifyCodexManagedError(value: unknown): CodexManagedFailure | undefined {
  const error = unwrapError(value);
  const messages = typeof error === "string"
    ? [error]
    : typeof error === "object" && error !== null
      ? [
          "message" in error ? error.message : null,
          "additionalDetails" in error ? error.additionalDetails : null,
        ].filter((message): message is string => typeof message === "string")
      : [];
  const code = managedCode(error) ?? messages.map(managedCode).find((found) => found !== undefined);
  return code === undefined ? undefined : { code, message: failures[code].message };
}

/** A response header map's key in a serialized service error: JSON, JSON inside a JSON string, or Rust debug text. */
const HEADER_MAP_KEY = /((?<!\\)(\\*)"headers\2"|\bheaders)\s*[:=]\s*\{/giu;

/**
 * Codex serializes a failed service response, response headers included (`x-codex-turn-state` and the like),
 * into its error text. Stored and displayed error text keeps the response's error but replaces each header map
 * with a marker. A map cut off by an earlier bound is redacted to the end of the text.
 */
export function redactCodexErrorHeaders(text: string): string {
  let result = "";
  let index = 0;
  HEADER_MAP_KEY.lastIndex = 0;
  for (let match = HEADER_MAP_KEY.exec(text); match; match = HEADER_MAP_KEY.exec(text)) {
    const key = match[1]!;
    let end = match.index + match[0].length;
    let unit = match[2] === undefined ? 0 : match[2].length + 1;
    let depth = 1;
    let inString = false;
    for (; end < text.length && depth > 0; end += 1) {
      const character = text[end];
      if (character === "\\" || character === "\"") {
        let backslashes = 0;
        while (text[end + backslashes] === "\\") backslashes += 1;
        if (text[end + backslashes] !== "\"") {
          end += backslashes - 1;
          continue;
        }
        unit ||= backslashes + 1;
        if ((backslashes + 1) % unit !== 0) break;
        if (((backslashes + 1) / unit) % 2 === 1) inString = !inString;
        end += backslashes;
      } else if (!inString && character === "{") depth += 1;
      else if (!inString && character === "}") depth -= 1;
    }
    const marker = match[2] === undefined ? "[redacted]" : `${match[2]}"[redacted]${match[2]}"`;
    result += `${text.slice(index, match.index)}${key}:${marker}`;
    index = Math.min(end, text.length);
    HEADER_MAP_KEY.lastIndex = index;
  }
  return result + text.slice(index);
}
