import { z } from "zod";

import { BACKEND_CREDENTIAL_MASK } from "../shared/backend-credentials.js";
import {
  AGENT_SECRET_MAX_LENGTH,
  AGENT_SECRET_MIN_LENGTH,
  SECRET_REQUEST_MAX_DESCRIPTION_LENGTH,
  SECRET_REQUEST_MAX_TITLE_LENGTH,
  SECRET_REQUEST_MAX_TTL_HOURS,
  SECRET_REQUEST_MIN_TTL_HOURS,
  isSecretRequestDescription,
  isSecretRequestTitle,
  secretRequestCodePoints,
  type SaveAgentSecretRequest,
  type SecretRequestReference,
} from "../shared/agent-secrets.js";
import { AGENT_SECRET_VALUE_ISSUES } from "../shared/agent-secret-save-errors.js";
import type { ProviderId } from "../shared/provider.js";

export const SECRET_REQUEST_TOOL_NAME = "inertia_request_secret";

export const SECRET_REQUEST_MAX_FILE_NAME_LENGTH = 64;
export const SECRET_REQUEST_DEFAULT_TTL_HOURS = 24;
export const SECRET_REQUEST_DEFAULT_FILE_NAME = "secret";
export const SECRET_REQUEST_FILE_NAME_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$";
export const SECRET_REQUEST_MAX_PENDING_PER_CONVERSATION = 1;
export const SECRET_REQUEST_MAX_PER_TURN = 3;
export const SECRET_REQUEST_DEFAULT_WAIT_MS = 10 * 60_000;
export const AGENT_SECRET_REFERENCE_PREFIX = "secret:agent-secret:";

export const SECRET_REQUEST_FALLBACK_INSTRUCTION =
  "This chat can't pass secrets to you. If a task needs one, ask the user to store it in a file or environment variable outside the repository and tell you only its path or name; never ask them to paste the value here.";

export type SecretRequestRoute =
  | "native-dynamic-tool"
  | "native-sdk-mcp"
  | "acp-mcp"
  | "remote-mcp"
  | "prompt-fallback";

export const SECRET_REQUEST_ROUTES: Readonly<Record<ProviderId, SecretRequestRoute>> = Object.freeze({
  codex: "native-dynamic-tool",
  claude: "native-sdk-mcp",
  cursor: "acp-mcp",
  kimi: "acp-mcp",
  opencode: "remote-mcp",
  antigravity: "prompt-fallback",
});

export const SECRET_REQUEST_WAIT_MS_BY_PROVIDER: Readonly<Record<ProviderId, number>> = Object.freeze({
  codex: SECRET_REQUEST_DEFAULT_WAIT_MS,
  claude: SECRET_REQUEST_DEFAULT_WAIT_MS,
  cursor: 5 * 60_000,
  kimi: 5 * 60_000,
  opencode: SECRET_REQUEST_DEFAULT_WAIT_MS,
  antigravity: 0,
});

export function secretRequestWaitMs(providerId: ProviderId): number {
  return Math.min(SECRET_REQUEST_DEFAULT_WAIT_MS, SECRET_REQUEST_WAIT_MS_BY_PROVIDER[providerId]);
}

export function secretRequestRoute(providerId: ProviderId): SecretRequestRoute {
  return SECRET_REQUEST_ROUTES[providerId];
}

export function isSecretRequestProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && Object.hasOwn(SECRET_REQUEST_ROUTES, value);
}

const TITLE_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/gu;
const DESCRIPTION_CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/gu;
const FILE_NAME = new RegExp(SECRET_REQUEST_FILE_NAME_PATTERN, "u");
const WINDOWS_RESERVED_STEM = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu;

export function isSecretRequestFileName(value: unknown): value is string {
  return typeof value === "string" && FILE_NAME.test(value);
}

export function secretRequestPlaceholderText(title: string): string {
  return `Asked for a secret: ${title}`;
}

export function secretRequestRemoteLine(reference: Pick<SecretRequestReference, "title" | "status">): string {
  return `[secret request: ${reference.title}, ${reference.status}; answer on the computer]`;
}

export function agentSecretReference(requestId: string): string {
  return `${AGENT_SECRET_REFERENCE_PREFIX}${requestId}`;
}

export const SECRET_REQUEST_TOOL_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: SECRET_REQUEST_MAX_TITLE_LENGTH,
      description: "What the secret is, e.g. \"Tailscale auth key for test VMs\".",
    },
    description: {
      type: "string",
      minLength: 1,
      maxLength: SECRET_REQUEST_MAX_DESCRIPTION_LENGTH,
      description: "Plain text, no Markdown: what it is for, where the user creates it, which options to choose.",
    },
    fileName: {
      type: "string",
      pattern: SECRET_REQUEST_FILE_NAME_PATTERN,
      description: "Optional file name hint, e.g. tailscale-authkey.",
    },
    ttlHours: {
      type: "integer",
      minimum: SECRET_REQUEST_MIN_TTL_HOURS,
      maximum: SECRET_REQUEST_MAX_TTL_HOURS,
      default: SECRET_REQUEST_DEFAULT_TTL_HOURS,
    },
  },
  required: ["title", "description"],
} as const;

function boundedText(max: number) {
  return z.string().refine(
    (value) => secretRequestCodePoints(value) >= 1 && secretRequestCodePoints(value) <= max,
    `Expected 1 to ${max} characters`,
  );
}

export const secretRequestToolInputSchema = z.strictObject({
  title: boundedText(SECRET_REQUEST_MAX_TITLE_LENGTH),
  description: boundedText(SECRET_REQUEST_MAX_DESCRIPTION_LENGTH),
  fileName: z.string().regex(FILE_NAME).optional(),
  ttlHours: z.number().int().min(SECRET_REQUEST_MIN_TTL_HOURS).max(SECRET_REQUEST_MAX_TTL_HOURS)
    .default(SECRET_REQUEST_DEFAULT_TTL_HOURS),
});

export type SecretRequestToolInput = z.infer<typeof secretRequestToolInputSchema>;

export interface NormalizedSecretRequestInput {
  title: string;
  description: string;
  fileName: string;
  ttlHours: number;
}

export function sanitizeSecretRequestTitle(value: string): string {
  return value.replace(TITLE_CONTROLS, "").trim();
}

export function sanitizeSecretRequestDescription(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, " ")
    .replace(DESCRIPTION_CONTROLS, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function sanitizeSecretRequestFileName(value: string | undefined): string {
  if (value === undefined || !FILE_NAME.test(value)) return SECRET_REQUEST_DEFAULT_FILE_NAME;
  const name = value.replace(/\.+$/u, "");
  const dot = name.indexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  if (!WINDOWS_RESERVED_STEM.test(stem)) return name;
  return `${stem}-secret${name.slice(stem.length)}`.slice(0, SECRET_REQUEST_MAX_FILE_NAME_LENGTH);
}

export function normalizeSecretRequestToolInput(value: unknown): NormalizedSecretRequestInput | null {
  const parsed = secretRequestToolInputSchema.safeParse(value);
  if (!parsed.success) return null;
  const title = sanitizeSecretRequestTitle(parsed.data.title);
  const description = sanitizeSecretRequestDescription(parsed.data.description);
  if (!isSecretRequestTitle(title) || !isSecretRequestDescription(description)) return null;
  return {
    title,
    description,
    fileName: sanitizeSecretRequestFileName(parsed.data.fileName),
    ttlHours: parsed.data.ttlHours,
  };
}

export function agentSecretValueIssue(value: unknown): string | null {
  if (typeof value !== "string") return AGENT_SECRET_VALUE_ISSUES.notText;
  if (value.length > AGENT_SECRET_MAX_LENGTH) return AGENT_SECRET_VALUE_ISSUES.tooLong;
  const secret = value.trim();
  if (secret.length === 0) return AGENT_SECRET_VALUE_ISSUES.blank;
  if (secret === BACKEND_CREDENTIAL_MASK) return AGENT_SECRET_VALUE_ISSUES.masked;
  if (/[\0\r\n]/u.test(secret)) return AGENT_SECRET_VALUE_ISSUES.multiline;
  if (secret.length < AGENT_SECRET_MIN_LENGTH) return AGENT_SECRET_VALUE_ISSUES.tooShort;
  return null;
}

export function isAgentSecretValue(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && agentSecretValueIssue(value) === null;
}

export function normalizeAgentSecretValue(value: unknown): string {
  const issue = agentSecretValueIssue(value);
  if (issue !== null) throw new Error(issue);
  return (value as string).trim();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseSaveAgentSecretRequest(value: unknown): SaveAgentSecretRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 3
    || typeof candidate.conversationId !== "string"
    || !UUID.test(candidate.conversationId)
    || typeof candidate.requestId !== "string"
    || !UUID.test(candidate.requestId)
    || agentSecretValueIssue(candidate.secret) !== null
  ) return null;
  return {
    conversationId: candidate.conversationId,
    requestId: candidate.requestId,
    secret: normalizeAgentSecretValue(candidate.secret),
  };
}
