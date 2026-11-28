import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { serverEventSchema } from "../../src/shared/contracts/server-event-schema";

describe("Cursor SDK private login contracts", () => {
  it("exposes runtime availability and vault presence without claiming remote authentication", () => {
    const requestId = randomUUID();
    expect(clientCommandSchema.safeParse({ type: "provider.cursor-sdk.status", requestId }).success).toBe(true);
    const result = { kind: "provider.cursor-sdk.status", available: true, hasCredential: true, sdkVersion: "1.0.38" };
    expect(serverEventSchema.safeParse({ type: "request.result", requestId, result }).success).toBe(true);
    expect(serverEventSchema.safeParse({ type: "request.result", requestId, result: { ...result, apiKey: "fixture-value" } }).success).toBe(false);
    expect(serverEventSchema.safeParse({ type: "request.result", requestId, result: { ...result, authenticated: true } }).success).toBe(false);
  });

  it("validates bounded unique catalogue entries without accepting hidden metadata", () => {
    const requestId = randomUUID();
    expect(clientCommandSchema.safeParse({ type: "provider.cursor-sdk.models", requestId }).success).toBe(true);
    const model = { id: "catalogue-id", displayName: "Catalogue model" };
    const envelope = (models: unknown[]) => ({ type: "request.result", requestId,
      result: { kind: "provider.cursor-sdk.models", models } });
    expect(serverEventSchema.safeParse(envelope([model])).success).toBe(true);
    expect(serverEventSchema.safeParse(envelope([{ ...model, apiKey: "fixture-value" }])).success).toBe(false);
    expect(serverEventSchema.safeParse(envelope([model, model])).success).toBe(false);
    expect(serverEventSchema.safeParse(envelope([{ ...model, id: "invalid\nidentity" }])).success).toBe(false);
    expect(serverEventSchema.safeParse(envelope(Array.from({ length: 513 }, (_, index) => ({ ...model, id: String(index) })))).success).toBe(false);
  });

  it("requires an exact request identity for cancellation and accepts no credential input", () => {
    expect(clientCommandSchema.safeParse({ type: "provider.cursor-sdk.login", requestId: randomUUID() }).success).toBe(true);
    const cancel = { type: "provider.cursor-sdk.login.cancel", requestId: randomUUID(), payload: { loginRequestId: randomUUID() } };
    expect(clientCommandSchema.safeParse(cancel).success).toBe(true);
    expect(clientCommandSchema.safeParse({ ...cancel, payload: {} }).success).toBe(false);
    expect(clientCommandSchema.safeParse({ type: "provider.cursor-sdk.login", requestId: randomUUID(), apiKey: "fixture-value" }).success).toBe(false);
  });

  it("allows only validated progress fields and rejects credential-bearing events", () => {
    const base = { type: "provider.cursor-sdk.login.updated", loginRequestId: randomUUID() };
    const cases = [
      { ...base, status: "starting" },
      { ...base, status: "waiting", loginUrl: "https://cursor.com/login?request=fixture" },
      { ...base, status: "authenticated", expiresAt: Date.now() + 60_000 },
      { ...base, status: "cancelled" },
    ];
    for (const value of cases) {
      expect(serverEventSchema.safeParse(value).success).toBe(true);
      expect(serverEventSchema.safeParse({ ...value, apiKey: "fixture-value" }).success).toBe(false);
    }
    for (const value of [
      { ...base, status: "waiting", loginUrl: "https://attacker.invalid/login" },
      { ...base, status: "waiting", loginUrl: "https://cursor.com/" + "x".repeat(8192) },
      { ...base, status: "waiting" },
      { ...base, status: "authenticated", expiresAt: Number.NaN },
      { ...base, status: "authenticated", expiresAt: Number.MAX_VALUE },
      { ...base, status: "authenticated", expiresAt: -1 },
      { ...base, status: "failed", message: "fixture-private-error" },
    ]) expect(serverEventSchema.safeParse(value).success).toBe(false);
  });
});
