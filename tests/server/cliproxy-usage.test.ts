// @inertia-test-suite portable
import { describe, expect, it, vi } from "vitest";
import { CliproxyUsageClient, nativeResetCredits } from "../../src/server/usage/cliproxy";
import { usageSourceInputSchema, usageSourceOrigin } from "../../src/shared/provider-usage-limits";

const source = { id: "25e4b71b-06d2-4975-8977-62b239c2f32c", label: "Fixture hub", url: "https://hub.example.test", enabled: true };
const auth = { id: "fixture-account", auth_index: "fixture-index", provider: "codex", id_token: { chatgpt_account_id: "fixture-account-id" } };
const signal = new AbortController().signal;
describe("CLIProxyAPI usage contract", () => {
  it("accepts only an explicit secure origin or local HTTP", () => {
    for (const url of ["file:///tmp/test", "http://remote.example", "https://user:secret@host", "https://host/path", "https://host?key=secret", "https://host#key"]) expect(usageSourceOrigin(url)).toBeNull();
    expect(usageSourceInputSchema.safeParse({ ...source, managementKey: "never-in-command" }).success).toBe(false);
    expect(usageSourceOrigin("http://127.0.0.1:8318")).toBe("http://127.0.0.1:8318");
  });
  it("reads quota independently of reset-credit availability and never exposes management keys", async () => {
    const requests: RequestInit[] = [];
    const client = new CliproxyUsageClient(vi.fn(async (_url, init) => {
      requests.push(init!);
      const payload = JSON.parse(init!.body as string) as { url: string };
      return Response.json({ status_code: payload.url.endsWith("/usage") ? 200 : 503, body: JSON.stringify({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 2000000000 } } }) });
    }));
    const result = await client.read(source, "fake-management-key", auth, signal);
    expect(result).toMatchObject({ status: "ready", windows: [{ remainingPercent: 70, windowMinutes: 300 }], credits: null, canReset: false });
    expect(JSON.stringify(result)).not.toContain("fake-management-key");
    expect(requests.every((request) => request.redirect === "error" && request.signal === signal)).toBe(true);
  });
  it("keeps absent windows absent, missing counts unknown, and explicit zero credit counts zero", () => {
    expect(nativeResetCredits(null)).toBeNull();
    expect(nativeResetCredits({ credits: [] })).toBeNull();
    expect(nativeResetCredits({ availableCount: 0, credits: [] })).toEqual({ availableCount: 0, nextCreditId: null, expiresAt: null });
    expect(nativeResetCredits({ availableCount: 3, credits: null })?.availableCount).toBe(3);
  });
  it("rejects duplicate and excessive account lists with redacted errors", async () => {
    const client = new CliproxyUsageClient(vi.fn(async () => Response.json({ files: [auth, auth] })));
    await expect(client.accounts(source, "fake-key", signal)).rejects.toThrow("duplicate account");
    const oversized = new CliproxyUsageClient(vi.fn(async () => new Response("sensitive-echo".repeat(100000))));
    await expect(oversized.accounts(source, "fake-key", signal)).rejects.toThrow("management request failed");
  });
  it("passes only the selected hub account, displayed credit and retry key to redemption", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ status_code: 200, body: JSON.stringify({ code: "already_redeemed" }) }));
    const client = new CliproxyUsageClient(fetcher);
    expect(await client.consume(source, "fake-key", auth, "displayed-credit", "stable-key", signal)).toBe("alreadyRedeemed");
    const init = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(init!.body as string)).toMatchObject({ auth_index: auth.auth_index, method: "POST", data: JSON.stringify({ credit_id: "displayed-credit", redeem_request_id: "stable-key" }) });
  });
  it("propagates cancellation without leaking transport errors", async () => {
    const controller = new AbortController(); controller.abort();
    const client = new CliproxyUsageClient(vi.fn(async (_url, init) => { init!.signal!.throwIfAborted(); throw new Error("secret transport details"); }));
    await expect(client.accounts(source, "fake-key", controller.signal)).rejects.toThrow("management request failed");
  });
});
