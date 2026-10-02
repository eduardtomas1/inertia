// @inertia-test-suite portable
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageAccount } from "../../src/shared/provider-usage-limits";
import { NativeSubscriptionReader } from "../../src/server/usage/native-subscriptions";
import { cursorSubscriptionWindows, kimiSubscriptionWindows, openCodeSubscriptionWindows } from "../../src/server/usage/subscription-parsers";
import { readSubscriptionFile, subscriptionJson } from "../../src/server/usage/subscription-io";
import { openCodeSubscriptionCredential } from "../../src/server/usage/opencode-subscription";
import type { Provider } from "@opencode-ai/sdk/v2";
import { resetQuota, resumeAccountIdentity } from "../../src/server/usage/limit-reset-policy";

const reset = "2026-10-20T12:00:00.000Z";
const base = (providerId: string): UsageAccount => ({ id: `native:${providerId}`, providerId, providerLabel: providerId, label: "Account",
  email: null, plan: null, identityKey: null, sources: ["This computer"], status: "unavailable", detail: null,
  updatedAt: null, checkedAt: new Date().toISOString(), credits: null, canReset: false, windows: [] });
const cursor = { billingCycleEnd: Date.parse(reset), planUsage: { totalPercentUsed: 50, autoPercentUsed: 100, apiPercentUsed: 20 } };
const go = { usage: { rolling: { percent: 100, resetsAt: reset }, weekly: { percent: 40, resetsAt: reset }, monthly: { percent: 10, resetsAt: reset } } };
const fetcher = (body: unknown) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } }));
const read = (reader: NativeSubscriptionReader, provider = "cursor", model = "composer-2") => reader.read(base(provider), model, new AbortController().signal, "/chat/workspace");
afterEach(() => { vi.useRealTimers(); });

describe("native subscription adapters", () => {
  it("reads Cursor using the CLI's explicit auth token without exposing it", async () => {
    const request = fetcher(cursor);
    const reader = new NativeSubscriptionReader({ environment: async () => ({ CURSOR_AUTH_TOKEN: "fake-cursor-token" }), fetch: request,
      readFile: vi.fn(async () => { throw new Error("Must not read another account"); }), accountKey: async () => "per-install-key" });
    const result = await read(reader);
    expect(result.status).toBe("ready");
    expect(result.windows).toHaveLength(3);
    expect(request.mock.calls[0]).toMatchObject(["https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", { method: "POST", redirect: "error", headers: { Authorization: "Bearer fake-cursor-token" } }]);
    expect(JSON.stringify(result)).not.toContain("fake-cursor-token");
    expect(result.identityKey).toBeNull(); expect(result.canReset).toBe(false);
    expect(resumeAccountIdentity(result)).toMatch(/^[a-f0-9]{64}$/u);
    const unkeyed = await read(new NativeSubscriptionReader({ environment: async () => ({ CURSOR_AUTH_TOKEN: "fake-cursor-token" }), fetch: fetcher(cursor) }));
    expect(unkeyed.status).toBe("ready"); expect(resumeAccountIdentity(unkeyed)).toBeNull();
  });
  it.each([
    { CURSOR_API_KEY: "api-key" }, { AGENT_CLI_CREDENTIAL_STORE: "memory" },
    { CURSOR_AUTH_TOKEN: "secret", CURSOR_API_ENDPOINT: "https://another.example" },
  ])("does not use an unrelated stored Cursor login for %j", async (environment) => {
    const request = fetcher(cursor); const file = vi.fn(async () => '{"accessToken":"wrong-account"}');
    const result = await read(new NativeSubscriptionReader({ environment: async () => environment, fetch: request, readFile: file }));
    expect(result.status).toBe("unsupported"); expect(request).not.toHaveBeenCalled(); expect(file).not.toHaveBeenCalled();
  });
  it.each([
    ["linux", { HOME: "/home/person", XDG_CONFIG_HOME: "/config" }, "/config/cursor/auth.json"],
    ["darwin", { HOME: "/Users/person", AGENT_CLI_CREDENTIAL_STORE: "file" }, "/Users/person/.cursor/auth.json"],
    ["win32", { USERPROFILE: "/profile", APPDATA: "/roaming" }, "/roaming/Cursor/auth.json"],
  ] as const)("uses Cursor's %s credential location", async (platform, environment, expected) => {
    const file = vi.fn(async (_path: string) => '{"accessToken":"file-token"}');
    expect((await read(new NativeSubscriptionReader({ platform, environment: async () => environment, readFile: file, fetch: fetcher(cursor) }))).status).toBe("ready");
    expect(file.mock.calls.map(([path]) => path.replaceAll("\\", "/"))).toContain(expected);
  });
  it("uses the native Cursor Keychain entry on macOS and coalesces an unanswered prompt", async () => {
    const keychain = vi.fn(() => new Promise<string | null>(() => undefined));
    const reader = new NativeSubscriptionReader({ platform: "darwin", environment: async () => ({}), readCursorKeychain: keychain });
    const firstAbort = new AbortController(); const secondAbort = new AbortController();
    expect(await reader.read(base("cursor"), "auto", firstAbort.signal, "/chat")).toMatchObject({ status: "unavailable", keychain: "deferred" });
    expect(keychain).not.toHaveBeenCalled();
    const first = reader.read(base("cursor"), "auto", firstAbort.signal, "/chat", true);
    const second = reader.read(base("cursor"), "auto", secondAbort.signal, "/chat", true);
    await vi.waitFor(() => expect(keychain).toHaveBeenCalledOnce());
    firstAbort.abort(); secondAbort.abort();
    expect((await first).status).toBe("error"); expect((await second).status).toBe("error");
    expect(keychain).toHaveBeenCalledOnce();
  });
  it("asks the macOS Keychain once per explicit read and keeps that login out of automatic resume", async () => {
    const keychain = vi.fn(async () => "keychain-token");
    const reader = new NativeSubscriptionReader({ platform: "darwin", environment: async () => ({}), readCursorKeychain: keychain,
      fetch: fetcher(cursor), accountKey: async () => "per-install-key" });
    const result = await reader.read(base("cursor"), "composer-2", new AbortController().signal, "/chat", true);
    expect(result).toMatchObject({ status: "ready", keychain: "read" });
    expect(keychain).toHaveBeenCalledOnce();
    expect(resumeAccountIdentity(result)).toBeNull();
  });
  it.each(["linux", "win32"] as const)("never loads the Keychain binding on %s", async (platform) => {
    const keychain = vi.fn(async () => "keychain-token");
    const reader = new NativeSubscriptionReader({ platform, environment: async () => ({ HOME: "/home", USERPROFILE: "/profile", APPDATA: "/roaming" }),
      readCursorKeychain: keychain, readFile: async () => '{"accessToken":"file-token"}', fetch: fetcher(cursor) });
    expect((await reader.read(base("cursor"), "composer-2", new AbortController().signal, "/chat", true)).status).toBe("ready");
    expect(keychain).not.toHaveBeenCalled();
  });
  it("refuses a credential replacement during a Cursor quota request", async () => {
    let reads = 0;
    const result = await read(new NativeSubscriptionReader({ environment: async () => ({ HOME: "/home" }), platform: "linux",
      readFile: async () => JSON.stringify({ accessToken: ++reads === 1 ? "first" : "second" }), fetch: fetcher(cursor) }));
    expect(result.status).toBe("error"); expect(result.windows).toEqual([]); expect(result.credentialFingerprint).toBeUndefined();
  });
  it("uses OpenCode's resolved workspace account and never reads a guessed auth file", async () => {
    const resolved = vi.fn(async () => ({ token: "effective-go-key", scope: "opencode:go" }));
    const request = fetcher(go);
    const result = await read(new NativeSubscriptionReader({ environment: async () => ({}), openCodeAccount: resolved, fetch: request }), "opencode", "opencode-go/model");
    expect(result.status).toBe("ready"); expect(resolved).toHaveBeenCalledWith("/chat/workspace", "opencode-go/model", expect.any(AbortSignal));
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({ Authorization: "Bearer effective-go-key" });
  });
  it("keeps unsupported OpenCode routes and Antigravity explicit without fabricating quota", async () => {
    const request = fetcher(go);
    const reader = new NativeSubscriptionReader({ environment: async () => ({}), openCodeAccount: async () => null, fetch: request });
    for (const provider of ["opencode", "antigravity"]) {
      const result = await read(reader, provider, "another/model");
      expect(result.status).toBe("unsupported"); expect(result.windows).toEqual([]); expect(result.detail).toBeTruthy();
    }
    expect(request).not.toHaveBeenCalled();
  });
  it("resolves the selected Kimi model from TOML and gives its OAuth credential precedence", async () => {
    const config = `default_model = "kimi-code/k2"\n[models."kimi-code/k2"]\nmodel = "k2"\nprovider = "managed:kimi-code"\n[providers."managed:kimi-code"]\ntype = "kimi"\nbase_url = "https://api.kimi.com/coding/v1"\napi_key = "stored-key"\n[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = "oauth/kimi-code"\n`;
    const request = fetcher({ usage: { limit: "100", remaining: "0", resetAt: reset } });
    const reader = new NativeSubscriptionReader({ environment: async () => ({ KIMI_SHARE_DIR: "/kimi", KIMI_API_KEY: "env-key" }), fetch: request,
      readFile: async (path) => path.endsWith("config.toml") ? config : JSON.stringify({ access_token: "oauth-key", expires_at: Date.now() / 1000 + 3600 }) });
    const result = await read(reader, "kimi", "k2");
    expect(result.status).toBe("ready"); expect(result.windows[0]).toMatchObject({ remainingPercent: 0, resetsAt: reset });
    expect(request.mock.calls[0]).toMatchObject(["https://api.kimi.com/coding/v1/usages", { headers: { Authorization: "Bearer oauth-key" } }]);
    expect((await read(reader, "kimi", "kimi-code/k2,thinking")).status).toBe("ready");
    expect((await read(reader, "kimi", "another-model")).status).toBe("unsupported");
  });
  it("keeps malformed and oversized upstream bodies out of account details", async () => {
    const reader = new NativeSubscriptionReader({ environment: async () => ({ CURSOR_AUTH_TOKEN: "secret" }), fetch: fetcher({ planUsage: { totalPercentUsed: "secret" } }) });
    expect((await read(reader)).detail).not.toContain("secret");
    await expect(subscriptionJson(vi.fn(async () => new Response("x".repeat(300_000))), "https://example.test", "secret", new AbortController().signal)).rejects.toThrow("too large");
  });
});

describe("provider quota attribution", () => {
  it("uses the relevant Cursor bucket without applying another model family's exhaustion", () => {
    const account = { ...base("cursor"), status: "ready" as const, updatedAt: new Date().toISOString(), windows: cursorSubscriptionWindows(cursor) };
    expect(resetQuota(account, "composer-2").kind).toBe("exhausted");
    expect(resetQuota(account, "claude-sonnet").kind).toBe("available");
  });
  it("restricts Go quota to Go routes and preserves reported windows", () => {
    const account = { ...base("opencode"), status: "ready" as const, updatedAt: new Date().toISOString(), windows: openCodeSubscriptionWindows(go) };
    expect(resetQuota(account, "opencode-go/model").kind).toBe("exhausted");
    expect(resetQuota(account, "anthropic/model").kind).toBe("unknown");
  });
  it("derives a Kimi relative reset only from a reported duration and refuses absent counts", () => {
    const now = Date.parse("2026-10-01T00:00:00.000Z");
    expect(kimiSubscriptionWindows({ usage: { limit: 100, used: 100, reset_in: 60 } }, now)[0]).toMatchObject({ remainingPercent: 0, resetsAt: "2026-10-01T00:01:00.000Z" });
    expect(kimiSubscriptionWindows({ limits: [{ limit: "100", remaining: "10", resetTime: reset }] }, now)[0]).toMatchObject({ remainingPercent: 10, resetsAt: reset });
    expect(kimiSubscriptionWindows({ usage: { limit: 100 } }, now)[0]).toMatchObject({ remainingPercent: null, resetsAt: null });
  });
  it("rejects numeric strings that overflow rather than publishing non-finite quota", () => {
    const overflow = "9".repeat(400);
    expect(() => kimiSubscriptionWindows({ usage: { limit: overflow, used: overflow, reset_in: 60 } }, Date.now())).toThrow();
  });
  it("rejects negative usage percentages instead of treating them as available quota", () => {
    expect(() => cursorSubscriptionWindows({ planUsage: { totalPercentUsed: -1 } })).toThrow();
    expect(() => openCodeSubscriptionWindows({ usage: { ...go.usage, rolling: { percent: -1, resetsAt: reset } } })).toThrow();
  });
  it.each([101, "101"])("rejects a Kimi remaining count above its limit: %s", (remaining) => {
    expect(() => kimiSubscriptionWindows({ usage: { limit: 100, remaining, resetAt: reset } }, Date.now())).toThrow();
  });
  it("rejects symlink credential files instead of following another account", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-credential-fixture-"));
    try {
      await writeFile(join(directory, "real.json"), '{"secret":"fake"}');
      await symlink(join(directory, "real.json"), join(directory, "auth.json"));
      await expect(readSubscriptionFile(join(directory, "auth.json"))).rejects.toThrow("could not be read");
      expect(await readSubscriptionFile(join(directory, "real.json"))).toContain("fake");
    } finally { await rm(directory, { recursive: true, force: true }); }
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
