import {
  SECRET_REQUEST_MAX_ACTIVE,
  SECRET_REQUEST_MAX_DESCRIPTION_LENGTH,
  SECRET_REQUEST_MAX_FILE_NAME_LENGTH,
  SECRET_REQUEST_MAX_PER_TURN,
  SECRET_REQUEST_MAX_TITLE_LENGTH,
  SECRET_REQUEST_MAX_TTL_HOURS,
  SECRET_REQUEST_MIN_TTL_HOURS,
  SECRET_REQUEST_TOOL_INPUT_SCHEMA,
  SECRET_REQUEST_TOOL_NAME,
  normalizeSecretRequestToolInput,
  secretRequestToolInputSchema,
  type NormalizedSecretRequestInput,
} from "../../../shared/agent-secrets";
import type { AgentSecretRequestErrorCode } from "../../persistence/agent-secret-request-repository";
import type { ProviderHostToolDefinition, ProviderHostToolResult } from "../../provider/contracts";

export const SECRET_REQUEST_DECLINED_MESSAGE =
  "The user declined. Continue without it, or explain in chat why you need it.";
export const SECRET_REQUEST_ENDED_MESSAGE = "No answer arrived. Ask again only if still needed.";

export type SecretRequestEndReason = "timed_out" | "cancelled" | "stopped";

const DESCRIPTION = [
  "Ask the user to type a secret (API key, token, password) into a private card, and wait.",
  "You never see the value.",
  "If saved, you get the path of a private file that your shell commands can read until `expiresAt`.",
  "Use it only inside a command, e.g. `TOKEN=\"$(cat '<file>')\" tool login`.",
  "Never print, echo or copy it into chat, files, logs or commits.",
  "Never ask for a secret in chat; call this instead.",
].join(" ");

export const SECRET_REQUEST_TOOL_DEFINITION: ProviderHostToolDefinition = {
  name: SECRET_REQUEST_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: SECRET_REQUEST_TOOL_INPUT_SCHEMA,
  inputValidator: secretRequestToolInputSchema,
  readOnly: true,
  destructive: false,
  idempotent: false,
};

const ARGUMENT_RULES: Readonly<Record<string, string>> = {
  title: `title needs 1 to ${SECRET_REQUEST_MAX_TITLE_LENGTH} characters`,
  description: `description needs 1 to ${SECRET_REQUEST_MAX_DESCRIPTION_LENGTH} characters of plain text`,
  fileName: `fileName allows letters, digits, '.', '_' and '-', starts with a letter or digit, has no slashes and at most ${SECRET_REQUEST_MAX_FILE_NAME_LENGTH} characters`,
  ttlHours: `ttlHours is a whole number from ${SECRET_REQUEST_MIN_TTL_HOURS} to ${SECRET_REQUEST_MAX_TTL_HOURS}`,
};

export function secretRequestFailure(code: string, message: string): ProviderHostToolResult {
  return { success: false, text: JSON.stringify({ error: { code, message } }) };
}

function invalidArguments(details: readonly string[]): ProviderHostToolResult {
  return secretRequestFailure(
    "invalid_arguments",
    `No secret was requested because its arguments were not accepted (${details.join("; ")}). Fix them and call ${SECRET_REQUEST_TOOL_NAME} again.`,
  );
}

export type ParsedSecretRequest =
  | { ok: true; input: NormalizedSecretRequestInput }
  | { ok: false; failure: ProviderHostToolResult };

export function parseSecretRequestArguments(value: unknown): ParsedSecretRequest {
  const parsed = secretRequestToolInputSchema.safeParse(value);
  if (!parsed.success) {
    const details = new Set<string>();
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") {
        const keys = issue.keys.slice(0, 4).map((key) => key.slice(0, 40)).join(", ");
        details.add(`unexpected arguments: ${keys}; use only title, description, fileName and ttlHours`);
        continue;
      }
      const field = typeof issue.path[0] === "string" ? issue.path[0] : "";
      details.add(ARGUMENT_RULES[field] ?? "arguments must be an object with title and description");
    }
    return { ok: false, failure: invalidArguments([...details].slice(0, 4)) };
  }
  const input = normalizeSecretRequestToolInput(parsed.data);
  if (!input) {
    return { ok: false, failure: invalidArguments(["title and description need visible text after control characters are removed"]) };
  }
  return { ok: true, input };
}

const LIMIT_FAILURES: Readonly<Record<AgentSecretRequestErrorCode, readonly [string, string]>> = {
  "turn-inactive": ["turn_not_active", "The turn that asked for this secret is no longer active."],
  "conversation-pending-limit": [
    "secret_request_pending",
    "This chat is already waiting for a secret. Wait for the user to answer the open request before asking again.",
  ],
  "turn-limit": [
    "secret_request_limit",
    `This turn already asked for ${SECRET_REQUEST_MAX_PER_TURN} secrets, which is the limit for one turn. Continue without it or ask in the next turn.`,
  ],
  "active-limit": [
    "secret_limit",
    `Inertia already holds ${SECRET_REQUEST_MAX_ACTIVE} active agent secrets. Ask the user to revoke one in Settings, then try again.`,
  ],
};

export function secretRequestLimitFailure(code: AgentSecretRequestErrorCode): ProviderHostToolResult {
  const [failureCode, message] = LIMIT_FAILURES[code];
  return secretRequestFailure(failureCode, message);
}

export function secretFileUseExample(file: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return `$key = Get-Content -Raw '${file.replaceAll("'", "''")}'`;
  return `KEY="$(cat '${file.replaceAll("'", "'\\''")}')"`;
}

export function secretRequestSavedResult(
  requestId: string,
  file: string,
  expiresAt: string,
  platform: NodeJS.Platform,
): ProviderHostToolResult {
  return {
    success: true,
    text: JSON.stringify({
      status: "saved",
      secretId: `inertia-secret:${requestId}`,
      file,
      expiresAt,
      use: secretFileUseExample(file, platform),
    }),
  };
}

export function secretRequestDeclinedResult(): ProviderHostToolResult {
  return { success: false, text: JSON.stringify({ status: "declined", message: SECRET_REQUEST_DECLINED_MESSAGE }) };
}

export function secretRequestEndedResult(reason: SecretRequestEndReason): ProviderHostToolResult {
  return { success: false, text: JSON.stringify({ status: "ended", reason, message: SECRET_REQUEST_ENDED_MESSAGE }) };
}
