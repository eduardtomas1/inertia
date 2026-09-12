// @inertia-test-suite portable
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeUsageReader } from "../../src/server/usage/native";
import { initialProviderSnapshots } from "../../src/server/runtime-snapshots";
import { opaqueUsageIdentity } from "../../src/server/usage/cliproxy";
import type { ProviderManager } from "../../src/server/providers";
import type { UsageResetConfirmation } from "../../src/shared/provider-usage-limits";
import { usageAccount } from "../helpers/usage-limits";

const protocol = vi.hoisted(() => ({ store: "file" as string | null, request: vi.fn<(method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>>() }));
vi.mock("../../src/server/codex/control-client", () => ({ CODEX_CONTROL_MAX_FRAME_BYTES: 4194304, CODEX_CONTROL_MAX_PROTOCOL_BYTES: 16777216, withCodexControlClient: async (_options: unknown, callback: (client: { request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> }) => unknown) => callback({ request: (method, params) => method === "config/read" ? Promise.resolve({ config: { cli_auth_credentials_store: protocol.store } }) : protocol.request(method, params) }) }));
const dirs: string[] = [];
afterEach(async () => { vi.clearAllMocks(); protocol.store = "file"; for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "inertia-native-usage-")); dirs.push(directory);
  await writeFile(join(directory, "auth.json"), JSON.stringify({ tokens: { account_id: "synthetic-account" } }));
  const providers = { codexControlContext: async () => ({ executable: "/fixture/codex", environment: { CODEX_HOME: directory }, cwd: directory }) } as unknown as ProviderManager;
  protocol.request.mockImplementation(async (method) => method === "account/read" ? { account: { type: "chatgpt", email: "fixture@example.test", planType: "pro" } }
    : method === "account/rateLimitResetCredit/consume" ? { outcome: "reset" }
      : { rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 2000000000 } }, rateLimitResetCredits: { availableCount: 2, credits: null } });
  return { directory, reader: new NativeUsageReader(providers, directory, new AbortController().signal), info: { ...initialProviderSnapshots(false)[0]!, canRun: true } };
}
describe("native Codex limits and reset protocol", () => {
  it("reads native counts without consuming and supports account-bound server credit selection", async () => {
    const f = await fixture(); const account = await f.reader.read(f.info);
    expect(account).toMatchObject({ status: "ready", credits: { availableCount: 2, nextCreditId: null }, canReset: true, identityKey: opaqueUsageIdentity("codex", "synthetic-account") });
    expect(protocol.request.mock.calls.map(([method]) => method)).toEqual(["account/read", "account/rateLimits/read"]);
    const confirmation: UsageResetConfirmation = { id: crypto.randomUUID(), accountId: account.id, accountKey: account.identityKey!, accountLabel: account.label, email: account.email, plan: account.plan, creditId: null, expiresAt: new Date(Date.now() + 120000).toISOString() };
    expect(await f.reader.consume(confirmation, account)).toBe("reset");
    expect(protocol.request).toHaveBeenLastCalledWith("account/rateLimitResetCredit/consume", { idempotencyKey: confirmation.id });
  });
  it("revalidates the provider-owned identity and refuses a switched account", async () => {
    const f = await fixture(); const account = await f.reader.read(f.info);
    await writeFile(join(f.directory, "auth.json"), JSON.stringify({ tokens: { account_id: "different-account" } }));
    await expect(f.reader.consume({ id: crypto.randomUUID(), accountId: account.id, accountKey: account.identityKey!, accountLabel: account.label, email: account.email, plan: account.plan, creditId: "displayed-credit", expiresAt: new Date().toISOString() }, account)).rejects.toThrow("account changed");
    expect(protocol.request.mock.calls.some(([method]) => method.includes("consume"))).toBe(false);
  });
  it.each(["keyring", "auto", "ephemeral", null])("does not bind a leftover auth file to credential store %s", async (store) => {
    const f = await fixture(); protocol.store = store;
    const account = await f.reader.read(f.info);
    expect(account).toMatchObject({ status: "ready", canReset: false, identityKey: null });
    await expect(f.reader.consume({ id: crypto.randomUUID(), accountId: account.id, accountKey: opaqueUsageIdentity("codex", "synthetic-account"), accountLabel: account.label, email: account.email, plan: account.plan, creditId: null, expiresAt: new Date().toISOString() }, account)).rejects.toThrow("account changed");
    expect(protocol.request.mock.calls.some(([method]) => method.includes("consume"))).toBe(false);
  });
  it("rejects an identity switch during account/read immediately before redemption", async () => {
    const f = await fixture(); const account = await f.reader.read(f.info);
    protocol.request.mockImplementationOnce(async () => {
      await writeFile(join(f.directory, "auth.json"), JSON.stringify({ tokens: { account_id: "different-workspace-same-email" } }));
      return { account: { type: "chatgpt", email: account.email, planType: account.plan } };
    });
    await expect(f.reader.consume({ id: crypto.randomUUID(), accountId: account.id, accountKey: account.identityKey!, accountLabel: account.label, email: account.email, plan: account.plan, creditId: null, expiresAt: new Date().toISOString() }, account)).rejects.toThrow("account changed");
    expect(protocol.request.mock.calls.some(([method]) => method.includes("consume"))).toBe(false);
  });
  it("does not confuse API-key auth or malformed counts with subscription entitlement", async () => {
    const f = await fixture(); protocol.request.mockResolvedValueOnce({ account: { type: "apiKey" } });
    expect(await f.reader.read(f.info)).toMatchObject({ status: "unsupported", windows: [], canReset: false });
    protocol.request.mockResolvedValueOnce({ account: { type: "chatgpt", email: "fixture@example.test" } }).mockResolvedValueOnce({ rateLimits: null, rateLimitResetCredits: { availableCount: "2" } });
    expect(await f.reader.read(f.info)).toMatchObject({ credits: null, canReset: false });
  });
  it("retains identity on a quota failure for safe stale fallback and validates reset outcomes", async () => {
    const f = await fixture(); protocol.request.mockResolvedValueOnce({ account: { type: "chatgpt", email: "fixture@example.test", planType: "pro" } }).mockRejectedValueOnce(new Error("simulated quota outage"));
    expect(await f.reader.read(f.info)).toMatchObject({ status: "error", identityKey: opaqueUsageIdentity("codex", "synthetic-account"), windows: [] });
    const account = usageAccount({ identityKey: opaqueUsageIdentity("codex", "synthetic-account") });
    protocol.request.mockResolvedValueOnce({ account: { type: "chatgpt", email: account.email, planType: account.plan } }).mockResolvedValueOnce({ outcome: "invented" });
    await expect(f.reader.consume({ id: crypto.randomUUID(), accountId: account.id, accountKey: account.identityKey!, accountLabel: account.label, email: account.email, plan: account.plan, creditId: "displayed-credit", expiresAt: new Date().toISOString() }, account)).rejects.toThrow();
  });
});
