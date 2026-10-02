// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";
import { credentialContinuity } from "../../src/server/usage/subscription-credentials";
import { NativeSubscriptionReader } from "../../src/server/usage/native-subscriptions";
import type { UsageAccount } from "../../src/shared/provider-usage-limits";

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64url");
const jwt = (payload: string) => `${b64('{"alg":"none"}')}.${b64(payload)}.sig`;
const session = (token: string) => ({ token, scope: "cursor:subscription", kind: "session" as const });
const account = (iss: string | null, sub: string) => JSON.stringify(["account", iss, sub]);

describe("untrusted session token claims", () => {
  it.each([
    ["two segments", "a.b"],
    ["malformed base64url", "x.%%%%***.y"],
    ["payload not JSON", `h.${b64("not json")}.s`],
    ["payload array", jwt("[1,2]")],
    ["payload null", jwt("null")],
    ["numeric sub", jwt('{"sub":1,"iss":"i"}')],
    ["object iss", jwt('{"sub":"s","iss":{"x":1}}')],
    ["empty sub", jwt('{"sub":""}')],
    ["oversized sub", jwt(JSON.stringify({ sub: "s".repeat(600) }))],
    ["unterminated nesting", jwt("[".repeat(48_000))],
  ])("fails closed without throwing for %s", (_label, token) => {
    const started = performance.now();
    expect(() => credentialContinuity(session(token))).not.toThrow();
    expect(credentialContinuity(session(token))).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
  it("decodes a deeply nested but valid payload quickly and refuses an oversized segment", () => {
    const started = performance.now();
    expect(credentialContinuity(session(jwt(`{"sub":"s","x":${"[".repeat(20_000)}${"]".repeat(20_000)}}`)))).toBe(account(null, "s"));
    expect(credentialContinuity(session("a.b.c".replace("b", "A".repeat(70_000))))).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
  });
  it("is deterministic for duplicate keys and ignores the signature", () => {
    expect(credentialContinuity(session(jwt('{"sub":"a","sub":"b"}')))).toBe(account(null, "b"));
    expect(credentialContinuity(session(jwt('{"sub":"b"}').replace(/sig$/u, "other")))).toBe(account(null, "b"));
  });
  it("treats canonically equivalent unicode subjects as different accounts", () => {
    expect(credentialContinuity(session(jwt(JSON.stringify({ sub: "josé" })))))
      .not.toBe(credentialContinuity(session(jwt(JSON.stringify({ sub: "josé" })))));
  });
  it("keeps issuer and subject unambiguous, including NUL characters and an absent issuer", () => {
    const left = credentialContinuity(session(jwt(JSON.stringify({ iss: "issuer\u0000tenant", sub: "user" }))));
    const right = credentialContinuity(session(jwt(JSON.stringify({ iss: "issuer", sub: "tenant\u0000user" }))));
    expect(left).not.toBeNull();
    expect(left).not.toBe(right);
    expect(credentialContinuity(session(jwt('{"sub":"u"}')))).not.toBe(credentialContinuity(session(jwt('{"sub":"u","iss":""}'))));
    expect(credentialContinuity({ token: "api-key", scope: "kimi:code", kind: "key" })).toBe(JSON.stringify(["key", "api-key"]));
  });
  it("never surfaces decoded claims in the account result", async () => {
    const token = jwt(JSON.stringify({ iss: "https://issuer.review544", sub: "subject-review544" }));
    const reader = new NativeSubscriptionReader({ environment: async () => ({ CURSOR_AUTH_TOKEN: token }), accountKey: async () => "k",
      fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ billingCycleEnd: Date.parse("2026-10-20T00:00:00Z"), planUsage: { totalPercentUsed: 100 } }))) });
    const base: UsageAccount = { id: "native:cursor", providerId: "cursor", providerLabel: "Cursor", label: "A", email: null, plan: null, identityKey: null,
      sources: [], status: "unavailable", detail: null, updatedAt: null, checkedAt: null, credits: null, canReset: false, windows: [] };
    const result = await reader.read(base, "composer-2", new AbortController().signal, "/w");
    expect(result.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(result)).not.toContain("review544");
  });
});
