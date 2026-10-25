// @inertia-test-suite portable
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageAccount } from "../../src/shared/provider-usage-limits";
import { NativeSubscriptionReader } from "../../src/server/usage/native-subscriptions";
import { openCodeSubscriptionWindows } from "../../src/server/usage/subscription-parsers";
import { subscriptionJson, SubscriptionHttpError } from "../../src/server/usage/subscription-io";
import { openCodeSubscriptionCredential } from "../../src/server/usage/opencode-subscription";
import type { Provider } from "@opencode-ai/sdk/v2";
import { resetQuota, resumeAccountIdentity } from "../../src/server/usage/limit-reset-policy";

const reset = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 7 * 86_400_000).toISOString();
const GO_KEY = "opencode-go-account-key";
const base = (providerId: string): UsageAccount => ({ id: `native:${providerId}`, providerId, providerLabel: providerId, label: "Account",
  email: null, plan: null, identityKey: null, sources: ["This computer"], status: "unavailable", detail: null,
  updatedAt: null, checkedAt: new Date().toISOString(), credits: null, canReset: false, windows: [] });
const go = { usage: { rolling: { percent: 100, resetsAt: reset }, weekly: { percent: 40, resetsAt: reset }, monthly: { percent: 10, resetsAt: reset } } };
const fetcher = (body: unknown) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
const goAccount = (token = GO_KEY) => vi.fn(async () => ({ token, scope: "opencode:go" }));
const read = (reader: NativeSubscriptionReader, provider = "opencode", model = "opencode-go/model") => reader.read(base(provider), model, new AbortController().signal, "/chat/workspace");
afterEach(() => { vi.useRealTimers(); });

describe("native subscription adapters", () => {
  it("reads OpenCode Go with the workspace's resolved key without exposing it", async () => {
    const request = fetcher(go);
    const resolved = goAccount();
    const result = await read(new NativeSubscriptionReader({ openCodeAccount: resolved, fetch: request, accountKey: async () => "per-install-key" }));
    expect(result.status).toBe("ready");
    expect(result.windows).toHaveLength(3);
    expect(resolved).toHaveBeenCalledWith("/chat/workspace", "opencode-go/model", expect.any(AbortSignal));
    expect(request.mock.calls[0]).toMatchObject(["https://opencode.ai/zen/go/v1/usage", { method: "GET", redirect: "error", headers: { Authorization: `Bearer ${GO_KEY}` } }]);
    expect(JSON.stringify(result)).not.toContain(GO_KEY);
    expect(result.identityKey).toBeNull(); expect(result.canReset).toBe(false);
    expect(resumeAccountIdentity(result)).toMatch(/^[a-f0-9]{64}$/u);
    const unkeyed = await read(new NativeSubscriptionReader({ openCodeAccount: goAccount(), fetch: fetcher(go) }));
    expect(unkeyed.status).toBe("ready"); expect(resumeAccountIdentity(unkeyed)).toBeNull();
  });
  it("keeps unsupported OpenCode routes and Antigravity explicit without fabricating quota", async () => {
    const request = fetcher(go);
    const reader = new NativeSubscriptionReader({ openCodeAccount: async () => null, fetch: request });
    for (const provider of ["opencode", "antigravity"]) {
      const result = await read(reader, provider, "another/model");
      expect(result.status).toBe("unsupported"); expect(result.windows).toEqual([]); expect(result.detail).toBeTruthy();
    }
    expect(request).not.toHaveBeenCalled();
  });
  it.each([["cursor", "composer-2"], ["kimi", "kimi-code/k2"]])("reports that %s does not expose usage without reading its login", async (provider, model) => {
    const environment = vi.fn(async () => ({ HOME: "/home/person", CURSOR_AUTH_TOKEN: "token", KIMI_API_KEY: "key" }));
    const request = fetcher(go);
    const openCodeAccount = goAccount();
    const accountKey = vi.fn(async () => "per-install-key");
    const dependencies = { environment, fetch: request, openCodeAccount, accountKey };
    const account = base(provider);
    const result = await new NativeSubscriptionReader(dependencies).read(account, model, new AbortController().signal, "/chat/workspace");
    expect(result).toEqual({ ...account, windows: [], status: "unavailable", detail: "Usage is not reported by this agent." });
    expect(environment).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(openCodeAccount).not.toHaveBeenCalled();
    expect(accountKey).not.toHaveBeenCalled();
  });
  it("refuses a credential replacement during an OpenCode Go quota request", async () => {
    let reads = 0;
    const result = await read(new NativeSubscriptionReader({ accountKey: async () => "per-install-key",
      openCodeAccount: async () => ({ token: ++reads === 1 ? "first" : "second", scope: "opencode:go" }), fetch: fetcher(go) }));
    expect(result.status).toBe("error"); expect(result.windows).toEqual([]); expect(result.credentialFingerprint).toBeUndefined();
  });
  it("keeps malformed and oversized upstream bodies out of account details", async () => {
    const reader = new NativeSubscriptionReader({ openCodeAccount: goAccount("secret"),
      fetch: fetcher({ usage: { ...go.usage, rolling: { percent: "secret", resetsAt: reset } } }) });
    expect((await read(reader)).detail).not.toContain("secret");
    await expect(subscriptionJson(vi.fn(async () => new Response("x".repeat(300_000))), "https://example.test", "secret", new AbortController().signal)).rejects.toThrow("too large");
  });
});

describe("throttled and failing quota reads", () => {
  const throttled = (headers: Record<string, string> = {}) => vi.fn<typeof fetch>(async () => new Response("{}", { status: 429, headers }));
  const keyed = (request: typeof fetch) => new NativeSubscriptionReader({ openCodeAccount: goAccount(), fetch: request, accountKey: async () => "per-install-key" });

  it("exposes the HTTP status and Retry-After of a refused quota request", async () => {
    const signal = new AbortController().signal;
    await expect(subscriptionJson(throttled({ "Retry-After": "120" }), "https://example.test", "secret", signal))
      .rejects.toMatchObject({ status: 429, retryAfterMs: 120_000 });
    vi.useFakeTimers(); vi.setSystemTime(Date.parse("2026-10-05T12:00:00.000Z"));
    await expect(subscriptionJson(throttled({ "Retry-After": "Mon, 05 Oct 2026 12:03:00 GMT" }), "https://example.test", "secret", signal))
      .rejects.toMatchObject({ status: 429, retryAfterMs: 180_000 });
    const refused = await subscriptionJson(vi.fn<typeof fetch>(async () => new Response("", { status: 503 })), "https://example.test", "secret", signal).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SubscriptionHttpError);
    expect(refused).toMatchObject({ status: 503, retryAfterMs: null });
  });

  it("keeps the account fingerprint on a throttled read and waits out Retry-After before asking again", async () => {
    vi.useFakeTimers();
    const request = throttled({ "Retry-After": "120" });
    const reader = keyed(request);
    const first = await read(reader);
    expect(first).toMatchObject({ status: "error", windows: [] });
    expect(resumeAccountIdentity(first)).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.detail).toBe("The provider asked Inertia to wait 2 min before checking quota again.");
    vi.setSystemTime(Date.now() + 60_000);
    const waiting = await read(reader);
    expect(request).toHaveBeenCalledOnce();
    expect(waiting).toMatchObject({ status: "error", credentialFingerprint: first.credentialFingerprint, detail: "The provider asked Inertia to wait 1 min before checking quota again." });
    vi.setSystemTime(Date.now() + 61_000);
    request.mockImplementation(async () => new Response(JSON.stringify(go), { headers: { "Content-Type": "application/json" } }));
    expect((await read(reader)).status).toBe("ready");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("bounds a missing or excessive Retry-After", async () => {
    vi.useFakeTimers();
    const missing = throttled();
    expect((await read(keyed(missing))).detail).toContain("wait 5 min");
    const excessive = throttled({ "Retry-After": "86400" });
    const reader = keyed(excessive);
    expect((await read(reader)).detail).toContain("wait 15 min");
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1);
    await read(reader);
    expect(excessive).toHaveBeenCalledTimes(2);
  });

  it("honours Retry-After on an unavailable quota service", async () => {
    vi.useFakeTimers();
    const unavailable = vi.fn<typeof fetch>(async () => new Response("", { status: 503, headers: { "Retry-After": "180" } }));
    const reader = keyed(unavailable);
    expect((await read(reader)).detail).toBe("The provider asked Inertia to wait 3 min before checking quota again.");
    await read(reader);
    expect(unavailable).toHaveBeenCalledOnce();
    const plain = vi.fn<typeof fetch>(async () => new Response("", { status: 503 }));
    const other = keyed(plain);
    expect((await read(other)).detail).toBe("The provider did not answer the quota check.");
    await read(other);
    expect(plain).toHaveBeenCalledTimes(2);
  });

  it("describes failed quota checks without blaming the sign-in", async () => {
    const failed = await read(keyed(vi.fn<typeof fetch>(async () => { throw new TypeError("fetch failed"); })));
    expect(failed).toMatchObject({ status: "error", detail: "The provider did not answer the quota check." });
    expect(resumeAccountIdentity(failed)).toMatch(/^[a-f0-9]{64}$/u);
    const refused = await read(keyed(vi.fn<typeof fetch>(async () => new Response("", { status: 401 }))));
    expect(refused.detail).toBe("The provider refused the quota check for this login.");
  });
});

describe("stable resume identity", () => {
  const identity = (token: string, accountKey = "per-install-key") =>
    read(new NativeSubscriptionReader({ openCodeAccount: goAccount(token), fetch: fetcher(go), accountKey: async () => accountKey }));
  it("keeps API keys as stable identities", async () => {
    const first = await identity(GO_KEY);
    expect(resumeAccountIdentity(first)).toMatch(/^[0-9a-f]{64}$/u);
    expect(resumeAccountIdentity(await identity(GO_KEY))).toBe(resumeAccountIdentity(first));
    expect(resumeAccountIdentity(await identity("another-go-key"))).not.toBe(resumeAccountIdentity(first));
    expect(resumeAccountIdentity(await identity(GO_KEY, "another-install-key"))).not.toBe(resumeAccountIdentity(first));
  });
  it("says why a key cannot be confirmed when secure storage is unavailable", async () => {
    const result = await read(new NativeSubscriptionReader({ openCodeAccount: goAccount(), fetch: fetcher(go), accountKey: async () => null }));
    expect(result.status).toBe("ready");
    expect(resumeAccountIdentity(result)).toBeNull();
    expect(result.resumeUnavailable).toContain("Secure storage");
  });
});

describe("provider quota attribution", () => {
  it("restricts Go quota to Go routes and preserves reported windows", () => {
    const account = { ...base("opencode"), status: "ready" as const, updatedAt: new Date().toISOString(), windows: openCodeSubscriptionWindows(go) };
    expect(resetQuota(account, "opencode-go/model").kind).toBe("exhausted");
    expect(resetQuota(account, "anthropic/model").kind).toBe("unknown");
  });
  it("rejects negative usage percentages instead of treating them as available quota", () => {
    expect(() => openCodeSubscriptionWindows({ usage: { ...go.usage, rolling: { percent: -1, resetsAt: reset } } })).toThrow();
  });
  it.each([["cursor", "cursor:totalPercentUsed"], ["kimi", "kimi:weekly"]])("never derives a reset from %s windows", (providerId, windowId) => {
    const account = { ...base(providerId), status: "ready" as const, updatedAt: new Date().toISOString(),
      windows: [{ id: windowId, label: "Weekly", remainingPercent: 0, resetsAt: reset, windowMinutes: null }] };
    expect(resetQuota(account, "model").kind).toBe("unknown");
  });
});

describe("other agents' login data", () => {
  const forbidden = ["credentials/kimi-code.json", "kimi-code.json", "cursor-access-token", "DashboardService", "x-cursor-client-type", "api2.cursor.sh"];
  it("is never read by privileged source code", () => {
    const root = fileURLToPath(new URL("../../src", import.meta.url));
    const files = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".ts") && path.split(sep)[0] !== "renderer");
    expect(files.length).toBeGreaterThan(100);
    const findings = files.flatMap((path) => {
      const contents = readFileSync(join(root, path), "utf8");
      return forbidden.filter((needle) => contents.includes(needle)).map((needle) => `${path}: ${needle}`);
    });
    expect(findings).toEqual([]);
  });
});

describe("effective OpenCode account binding", () => {
  const inventory = () => ({ all: [{ id: "opencode-go", key: "stored-key", options: {},
    models: { model: { api: { url: "https://opencode.ai/zen/go/v1" } } } } as unknown as Provider], default: { "opencode-go": "model" }, connected: ["opencode-go"] });
  it("uses an effective workspace key ahead of stored credentials", () => {
    const value = inventory(); value.all[0]!.options.apiKey = "workspace-key";
    expect(openCodeSubscriptionCredential(value, "opencode-go/model")).toEqual({ token: "workspace-key", scope: "opencode:go" });
    expect(openCodeSubscriptionCredential(value, undefined)?.token).toBe("workspace-key");
  });
  it.each(["endpoint", "authorization", "disconnected", "missing-key", "another-model"])("rejects %s without borrowing another Go account", (change) => {
    const value = inventory();
    if (change === "endpoint") value.all[0]!.options.baseURL = "https://custom.example/v1";
    if (change === "authorization") value.all[0]!.options.headers = { AUTHORIZATION: "Bearer another-account" };
    if (change === "disconnected") value.connected = [];
    if (change === "missing-key") delete value.all[0]!.key;
    expect(openCodeSubscriptionCredential(value, change === "another-model" ? "openai/gpt" : "opencode-go/model")).toBeNull();
  });
});
