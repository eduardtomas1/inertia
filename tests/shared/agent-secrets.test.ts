import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AGENT_SECRET_MAX_LENGTH,
  isSecretRequestReference,
  type SecretRequestReference,
} from "../../src/shared/agent-secrets";
import {
  SECRET_REQUEST_FALLBACK_INSTRUCTION,
  SECRET_REQUEST_ROUTES,
  SECRET_REQUEST_TOOL_INPUT_SCHEMA,
  SECRET_REQUEST_TOOL_NAME,
  agentSecretReference,
  agentSecretValueIssue,
  isAgentSecretValue,
  normalizeAgentSecretValue,
  normalizeSecretRequestToolInput,
  parseSaveAgentSecretRequest,
  sanitizeSecretRequestDescription,
  sanitizeSecretRequestFileName,
  sanitizeSecretRequestTitle,
  secretRequestPlaceholderText,
  secretRequestRemoteLine,
  secretRequestToolInputSchema,
} from "../../src/node/agent-secrets";
import { BACKEND_CREDENTIAL_MASK, isBackendSecretReference } from "../../src/shared/backend-credentials";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { secretRequestResultValidators } from "../../src/shared/contracts/secret-request-results";
import { PROVIDER_IDS } from "../../src/server/runtime/backends/backend-profile-model";

const pending: SecretRequestReference = {
  requestId: randomUUID(),
  title: "Tailscale auth key for test VMs",
  description: "Create a reusable, ephemeral key.\n\nAdmin console > Settings > Keys.",
  ttlHours: 24,
  status: "pending",
  answeredAt: null,
  expiresAt: null,
  storage: null,
};
const saved: SecretRequestReference = {
  ...pending,
  status: "saved",
  answeredAt: "2026-10-29T10:00:00.000Z",
  expiresAt: "2026-10-30T10:00:00.000Z",
  storage: "keychain",
};

describe("secret request references", () => {
  it.each([
    pending,
    saved,
    { ...saved, status: "expired" },
    { ...saved, status: "revoked", storage: "memory" },
    { ...pending, status: "declined", answeredAt: "2026-10-29T10:00:00.000Z" },
    { ...pending, status: "ended" },
  ])("accepts a coherent %s reference", (reference) => {
    expect(isSecretRequestReference(reference)).toBe(true);
  });

  it.each([
    ["an extra value", { ...pending, secret: "fixture-abc" }],
    ["a non-uuid id", { ...pending, requestId: "request-1" }],
    ["an empty title", { ...pending, title: "" }],
    ["an untrimmed title", { ...pending, title: " Key" }],
    ["a control character in the title", { ...pending, title: "Key\u0085" }],
    ["a title past 80 characters", { ...pending, title: "k".repeat(81) }],
    ["three blank lines in the description", { ...pending, description: "a\n\n\nb" }],
    ["a tab in the description", { ...pending, description: "a\tb" }],
    ["a description past 600 characters", { ...pending, description: "d".repeat(601) }],
    ["a zero lifetime", { ...pending, ttlHours: 0 }],
    ["a fractional lifetime", { ...pending, ttlHours: 1.5 }],
    ["an unknown status", { ...pending, status: "forgotten" }],
    ["a pending request with storage", { ...pending, storage: "memory" }],
    ["a saved request without expiry", { ...saved, expiresAt: null }],
    ["a revoked request without storage", { ...saved, status: "revoked", storage: null }],
    ["a declined request with expiry", { ...saved, status: "declined" }],
    ["a malformed timestamp", { ...saved, expiresAt: "tomorrow" }],
  ])("rejects %s", (_label, reference) => {
    expect(isSecretRequestReference(reference)).toBe(false);
  });

  it("counts titles in characters, not UTF-16 units", () => {
    expect(isSecretRequestReference({ ...pending, title: "🔑".repeat(80) })).toBe(true);
  });

  it("formats the placeholder and the remote line without any value", () => {
    expect(SECRET_REQUEST_TOOL_NAME).toBe("inertia_request_secret");
    expect(secretRequestPlaceholderText("Tailscale auth key")).toBe("Asked for a secret: Tailscale auth key");
    expect(secretRequestRemoteLine(saved)).toBe("[secret request: Tailscale auth key for test VMs, saved; answer on the computer]");
    expect(secretRequestRemoteLine({ title: "Key", status: "pending" })).toBe("[secret request: Key, pending; answer on the computer]");
  });

  it("derives a vault reference inside the backend secret namespace", () => {
    const requestId = randomUUID();
    expect(agentSecretReference(requestId)).toBe(`secret:agent-secret:${requestId}`);
    expect(isBackendSecretReference(agentSecretReference(requestId))).toBe(true);
  });
});

describe("secret request routes", () => {
  it("assigns every provider exactly one route", () => {
    expect(Object.keys(SECRET_REQUEST_ROUTES).sort()).toEqual([...PROVIDER_IDS].sort());
    expect(SECRET_REQUEST_ROUTES).toEqual({
      codex: "native-dynamic-tool",
      claude: "native-sdk-mcp",
      cursor: "acp-mcp",
      kimi: "acp-mcp",
      opencode: "remote-mcp",
      antigravity: "prompt-fallback",
    });
    expect(Object.isFrozen(SECRET_REQUEST_ROUTES)).toBe(true);
  });

  it("keeps the fallback instruction within 240 bytes", () => {
    expect(new TextEncoder().encode(SECRET_REQUEST_FALLBACK_INSTRUCTION).length).toBeLessThanOrEqual(240);
    expect(SECRET_REQUEST_FALLBACK_INSTRUCTION).toContain("never ask them to paste the value here");
  });
});

describe("secret request tool input", () => {
  const valid = { title: "Tailscale auth key", description: "Create a reusable key." };

  it("advertises the bounded JSON schema", () => {
    expect(SECRET_REQUEST_TOOL_INPUT_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["title", "description"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 80 },
        description: { type: "string", minLength: 1, maxLength: 600 },
        fileName: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" },
        ttlHours: { type: "integer", minimum: 1, maximum: 24, default: 24 },
      },
    });
  });

  it("accepts what the schema advertises and fills the lifetime default", () => {
    expect(secretRequestToolInputSchema.parse(valid)).toEqual({ ...valid, ttlHours: 24 });
    expect(secretRequestToolInputSchema.parse({ ...valid, fileName: "tailscale.authkey", ttlHours: 1 }))
      .toEqual({ ...valid, fileName: "tailscale.authkey", ttlHours: 1 });
    expect(secretRequestToolInputSchema.safeParse({ ...valid, title: "🔑".repeat(80) }).success).toBe(true);
  });

  it.each([
    ["a missing description", { title: "Key" }],
    ["an extra field", { ...valid, value: "fixture" }],
    ["a 48 hour lifetime", { ...valid, ttlHours: 48 }],
    ["a fractional lifetime", { ...valid, ttlHours: 2.5 }],
    ["a path in the file name", { ...valid, fileName: "../x" }],
    ["a dot file name", { ...valid, fileName: ".env" }],
    ["a 65 character file name", { ...valid, fileName: "f".repeat(65) }],
    ["a 900 character description", { ...valid, description: "d".repeat(900) }],
    ["an 81 character title", { ...valid, title: "k".repeat(81) }],
    ["an empty title", { ...valid, title: "" }],
  ])("rejects %s", (_label, value) => {
    expect(secretRequestToolInputSchema.safeParse(value).success).toBe(false);
    expect(normalizeSecretRequestToolInput(value)).toBeNull();
  });

  it("strips controls from the title and keeps only line breaks in the description", () => {
    expect(sanitizeSecretRequestTitle("  Tailscale\u0007 key\u009b\n ")).toBe("Tailscale key");
    expect(sanitizeSecretRequestDescription("  First line\r\nSecond\tline\u0000\r\n\r\n\r\n\n\nThird\u0085  "))
      .toBe("First line\nSecond line\n\nThird");
  });

  it("normalizes a call and refuses one that is blank after sanitising", () => {
    expect(normalizeSecretRequestToolInput({ title: " Key\u0001 ", description: "a\n\n\n\nb" }))
      .toEqual({ title: "Key", description: "a\n\nb", fileName: "secret", ttlHours: 24 });
    expect(normalizeSecretRequestToolInput({ title: "\u0001\u0002", description: "ok" })).toBeNull();
    expect(normalizeSecretRequestToolInput({ title: "Key", description: " \n\t\n " })).toBeNull();
  });

  it.each([
    [undefined, "secret"],
    ["tailscale-authkey", "tailscale-authkey"],
    ["CON", "CON-secret"],
    ["nul.txt", "nul-secret.txt"],
    ["com1", "com1-secret"],
    ["Lpt9.key", "Lpt9-secret.key"],
    ["console", "console"],
    ["key...", "key"],
    ["../x", "secret"],
    [`con.${"x".repeat(59)}`, `con-secret.${"x".repeat(53)}`],
  ])("names the file for %s as %s", (input, expected) => {
    expect(sanitizeSecretRequestFileName(input)).toBe(expected);
    expect(expected.length).toBeLessThanOrEqual(64);
  });
});

describe("agent secret values", () => {
  it.each([
    [42, "Paste the secret as text."],
    ["x".repeat(AGENT_SECRET_MAX_LENGTH + 1), "The secret is longer than 16,384 characters."],
    [" \n ", "Paste the secret. Only spaces or line breaks were entered."],
    [BACKEND_CREDENTIAL_MASK, "Paste the secret itself. The masked placeholder cannot be saved."],
    ["fixture\nabc", "The secret must be on a single line."],
    ["tsk\0ey", "The secret must be on a single line."],
    [" abc ", "The secret must be at least 4 characters long."],
  ])("rejects %j", (value, issue) => {
    expect(agentSecretValueIssue(value)).toBe(issue);
    expect(isAgentSecretValue(value)).toBe(false);
  });

  it("accepts single-line values from 4 characters and trims them", () => {
    expect(agentSecretValueIssue("abcd")).toBeNull();
    expect(agentSecretValueIssue("x".repeat(AGENT_SECRET_MAX_LENGTH))).toBeNull();
    expect(normalizeAgentSecretValue("  fake-token-123  ")).toBe("fake-token-123");
    expect(isAgentSecretValue("fake-token-123")).toBe(true);
    expect(isAgentSecretValue(" fake-token-123")).toBe(false);
    expect(() => normalizeAgentSecretValue("ab")).toThrow("The secret must be at least 4 characters long.");
  });

  it("parses only an exact save request", () => {
    const conversationId = randomUUID();
    const requestId = randomUUID();
    expect(parseSaveAgentSecretRequest({ conversationId, requestId, secret: " fixture-1 " }))
      .toEqual({ conversationId, requestId, secret: "fixture-1" });
    expect(parseSaveAgentSecretRequest({ conversationId, requestId, secret: "abc" })).toBeNull();
    expect(parseSaveAgentSecretRequest({ conversationId, requestId: "request", secret: "fixture-1" })).toBeNull();
    expect(parseSaveAgentSecretRequest({ conversationId, requestId, secret: "fixture-1", extra: true })).toBeNull();
    expect(parseSaveAgentSecretRequest(null)).toBeNull();
  });
});

describe("secret request commands", () => {
  const requestId = randomUUID();
  const parse = (value: unknown) => clientCommandSchema.safeParse(value).success;

  it("accepts the decline, revoke and list commands with exact payloads", () => {
    const conversationId = randomUUID();
    expect(parse({ requestId, type: "secret-request.decline", payload: { conversationId, requestId } })).toBe(true);
    expect(parse({ requestId, type: "secret-request.decline", payload: { requestId } })).toBe(false);
    expect(parse({ requestId, type: "secret-request.decline", payload: { conversationId, requestId, secret: "x" } })).toBe(false);
    expect(parse({ requestId, type: "secret-request.revoke", payload: { requestId } })).toBe(true);
    expect(parse({ requestId, type: "secret-request.revoke", payload: { requestId: "request" } })).toBe(false);
    expect(parse({ requestId, type: "secret-request.list", payload: {} })).toBe(true);
    expect(parse({ requestId, type: "secret-request.list", payload: { all: true } })).toBe(false);
  });

  it("validates the command results without values or paths", () => {
    const entry = {
      requestId,
      conversationId: randomUUID(),
      conversationTitle: "Tailscale",
      title: "Tailscale auth key",
      answeredAt: "2026-10-29T10:00:00.000Z",
      expiresAt: "2026-10-30T10:00:00.000Z",
      storage: "memory",
    };
    expect(secretRequestResultValidators["secret-request.decline"]({ kind: "secret-request.decline", status: "declined" })).toBe(true);
    expect(secretRequestResultValidators["secret-request.revoke"]({ kind: "secret-request.revoke", status: "revoked" })).toBe(true);
    expect(secretRequestResultValidators["secret-request.list"]({ kind: "secret-request.list", secrets: [entry] })).toBe(true);
    expect(secretRequestResultValidators["secret-request.list"]({ kind: "secret-request.list", secrets: [entry, entry] })).toBe(false);
    expect(secretRequestResultValidators["secret-request.list"]({ kind: "secret-request.list", secrets: [{ ...entry, file: "/tmp/secret" }] })).toBe(false);
    expect(secretRequestResultValidators["secret-request.list"]({ kind: "secret-request.list", secrets: [{ ...entry, storage: null }] })).toBe(false);
  });
});
