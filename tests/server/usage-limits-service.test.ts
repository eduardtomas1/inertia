import { backendSecretReferenceForProfile } from "../../src/node/backend-secret-reference";
import { USAGE_RESET_CONFIRMATION_EXPIRED } from "../../src/shared/provider-usage-limits";
import { publicRuntimeError } from "../../src/server/runtime-errors";
import { deduplicateUsageAccounts } from "../../src/shared/usage-limits-projection";
import { CliproxyUsageClient, opaqueUsageIdentity } from "../../src/server/usage/cliproxy";
import { migrateRuntimeDatabase } from "../../src/server/persistence/migrations/runtime-catalog";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageLimitsRepository } from "../../src/server/persistence/usage-limits-repository";
import { providerUsageLimitsMigration } from "../../src/server/persistence/migrations/provider-usage-limits";
import { UsageLimitsService, type UsageLimitsDependencies } from "../../src/server/usage/limits-service";
import { initialProviderSnapshots } from "../../src/server/runtime-snapshots";
import type { NativeUsageReader } from "../../src/server/usage/native";
import { usageAccount } from "../helpers/usage-limits";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
  const db = new Database(":memory:"); databases.push(db); db.exec(providerUsageLimitsMigration.up as string);
  const repository = new UsageLimitsRepository(db);
  const read = vi.fn(async () => usageAccount());
  const consume = vi.fn<NativeUsageReader["consume"]>(async () => "reset" as const);
  const deps: UsageLimitsDependencies = { repository, native: { read, consume }, providers: () => [{ ...initialProviderSnapshots(false)[0]!, available: true, canRun: true }], customProfiles: () => [], signal: new AbortController().signal, enabled: true };
  return { repository, read, consume, deps, service: new UsageLimitsService(deps) };
}
describe("privileged usage limits", () => {
  it("upgrades exact schema 73 transactionally without rewriting released migration records", () => {
    const db = new Database(":memory:"); databases.push(db); migrateRuntimeDatabase(db, 73);
    const history = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'usage_%'").all()).toEqual([]);
    migrateRuntimeDatabase(db);
    expect(db.prepare("SELECT * FROM schema_migrations WHERE version <= 73 ORDER BY version").all()).toEqual(history);
    expect(new UsageLimitsRepository(db).sources()).toEqual([]);
    const total = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get();
    migrateRuntimeDatabase(db); expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual(total);
  });
  it("does no startup work, coalesces reads and does not redeem while inspecting", async () => {
    const f = setup(); expect(f.read).not.toHaveBeenCalled();
    await Promise.all([f.service.refresh(), f.service.refresh()]);
    await f.service.refresh(); expect(f.read).toHaveBeenCalledOnce();
    f.service.prepareReset("native:codex"); expect(f.consume).not.toHaveBeenCalled();
  });
  it("serializes overlapping confirmations for the same credit", async () => {
    const f = setup(); await f.service.refresh();
    const first = f.service.prepareReset("native:codex"); const second = f.service.prepareReset("native:codex");
    expect(first.id).toBe(second.id);
    await Promise.all([f.service.consumeReset(first.id), f.service.consumeReset(second.id)]);
    expect(f.consume).toHaveBeenCalledOnce();
  });
  it("keeps count-only native retry identity through uncertainty, quota changes and a service restart", async () => {
    const f = setup(); f.read.mockResolvedValue(usageAccount({ credits: { availableCount: 2, nextCreditId: null, expiresAt: null } }));
    await f.service.refresh(); const first = f.service.prepareReset("native:codex");
    expect(first.creditId).toBeNull();
    f.consume.mockRejectedValueOnce(new Error("simulated timeout"));
    await expect(f.service.consumeReset(first.id)).rejects.toThrow("uncertain");
    const restarted = new UsageLimitsService(f.deps);
    f.read.mockResolvedValue(usageAccount({ windows: [], canReset: false, credits: { availableCount: 0, nextCreditId: null, expiresAt: null } }));
    await restarted.refresh(); expect(restarted.snapshot().accounts[0]).toMatchObject({ pendingReset: true, canReset: false, credits: { availableCount: 0 } }); const retry = restarted.prepareReset("native:codex");
    expect(retry.id).toBe(first.id);
    await restarted.consumeReset(retry.id);
    expect(f.consume.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ id: first.id, creditId: null }));
  });
  it("shares one open account confirmation when another source reports a different credit detail", async () => {
    const f = setup(); f.read.mockResolvedValue(usageAccount({ credits: { availableCount: 2, nextCreditId: null, expiresAt: null } }));
    await f.service.refresh(); const first = f.service.prepareReset("native:codex");
    f.read.mockResolvedValue(usageAccount()); await f.service.refresh(true);
    const second = f.service.prepareReset("native:codex"); expect(second.id).toBe(first.id);
    await Promise.all([f.service.consumeReset(first.id), f.service.consumeReset(second.id)]);
    expect(f.consume).toHaveBeenCalledOnce();
  });
  it("keeps a count-only native retry on its compatible route when a hub reports a credit ID", async () => {
    const f = setup(); const identityKey = opaqueUsageIdentity("codex", "stable-provider-account");
    f.read.mockResolvedValue(usageAccount({ identityKey, credits: { availableCount: 1, nextCreditId: null, expiresAt: null } }));
    const hub = new CliproxyUsageClient(); f.deps.hub = hub;
    f.deps.credentials = { resolve: async () => "synthetic-key", forget: async () => true, status: async () => ({ hasSecret: true, credentialGeneration: "fixture" }) };
    const auth = { id: "account", auth_index: "index", provider: "codex", id_token: { chatgpt_account_id: "stable-provider-account" } };
    vi.spyOn(hub, "accounts").mockResolvedValue([auth]);
    vi.spyOn(hub, "read").mockImplementation(async (source) => usageAccount({ id: `hub:${source.id}:account`, identityKey, updatedAt: new Date(Date.now()+1000).toISOString() }));
    const hubConsume = vi.spyOn(hub, "consume");
    const service = new UsageLimitsService(f.deps); await service.refresh(); const first = service.prepareReset("native:codex");
    f.consume.mockRejectedValueOnce(new Error("simulated timeout")); await expect(service.consumeReset(first.id)).rejects.toThrow("uncertain");
    const source = { id: crypto.randomUUID(), label: "Hub", url: "https://hub.example.test", enabled: true };
    await service.saveSource(source); await service.refresh(true);
    expect(() => service.prepareReset(`hub:${source.id}:account`)).toThrow("credit ID");
    expect(f.repository.attempt(first.id)?.confirmation).toMatchObject({ accountId: "native:codex", creditId: null });
    const [visible] = deduplicateUsageAccounts(service.snapshot().accounts);
    expect(visible).toMatchObject({ id: "native:codex", pendingReset: true });
    const retry = service.prepareReset(visible!.id); expect(retry.id).toBe(first.id);
    await service.consumeReset(retry.id); expect(hubConsume).not.toHaveBeenCalled();
    expect(f.consume.mock.calls[1]?.[0]).toMatchObject({ id: first.id, creditId: null });
  });
  it("rebinds a pending reset to a freshly verified re-added hub while preserving account, credit and retry identity", async () => {
    const f = setup(); f.deps.providers = () => [];
    const hub = new CliproxyUsageClient();
    const auth = { id: "account-entry", auth_index: "account-index", provider: "codex", id_token: { chatgpt_account_id: "stable-provider-account" } };
    const identityKey = opaqueUsageIdentity("codex", auth.id_token.chatgpt_account_id);
    const accounts = vi.spyOn(hub, "accounts").mockResolvedValue([auth]);
    vi.spyOn(hub, "read").mockImplementation(async (source) => usageAccount({ id: `hub:${source.id}:${auth.id}`, identityKey, sources: [source.label] }));
    const consume = vi.spyOn(hub, "consume").mockRejectedValueOnce(new Error("uncertain outcome")).mockResolvedValue("alreadyRedeemed");
    f.deps.hub = hub; f.deps.credentials = { resolve: async () => "synthetic-key", forget: async () => true, status: async () => ({ hasSecret: true, credentialGeneration: "fixture" }) };
    const service = new UsageLimitsService(f.deps);
    const original = { id: crypto.randomUUID(), label: "Original hub", url: "https://original.example.test", enabled: true };
    await service.saveSource(original); await service.refresh();
    const first = service.prepareReset(`hub:${original.id}:${auth.id}`);
    await expect(service.consumeReset(first.id)).rejects.toThrow("uncertain");
    await service.removeSource(original.id);
    const replacement = { ...original, id: crypto.randomUUID(), label: "Reconnected hub", url: "https://replacement.example.test" };
    await service.saveSource(replacement); await service.refresh(true);
    const retry = service.prepareReset(`hub:${replacement.id}:${auth.id}`);
    expect(retry).toMatchObject({ id: first.id, accountKey: first.accountKey, creditId: first.creditId, accountId: `hub:${replacement.id}:${auth.id}` });
    // Even a same-email hub entry must still prove its provider-owned account at redemption.
    accounts.mockResolvedValueOnce([{ ...auth, id_token: { chatgpt_account_id: "different-account" } }]);
    await expect(service.consumeReset(retry.id)).rejects.toThrow("uncertain"); expect(consume).toHaveBeenCalledOnce();
    expect(await service.consumeReset(retry.id)).toBe("alreadyRedeemed");
    expect(consume.mock.calls[1]?.slice(0, 6)).toEqual([replacement, "synthetic-key", auth, first.creditId, first.id, expect.any(AbortSignal)]);
  });
  it("allows a new explicit attempt after a non-consuming outcome and newly eligible quota", async () => {
    const f = setup(); f.consume.mockResolvedValueOnce("nothingToReset"); await f.service.refresh();
    const first = f.service.prepareReset("native:codex"); expect(await f.service.consumeReset(first.id)).toBe("nothingToReset");
    const changed = usageAccount(); changed.windows[0]!.remainingPercent = 0; f.read.mockResolvedValue(changed); await f.service.refresh(true);
    const next = f.service.prepareReset("native:codex"); expect(next.id).not.toBe(first.id); expect(next.creditId).toBe(first.creditId);
    expect(await f.service.consumeReset(first.id)).toBe("nothingToReset"); expect(f.consume).toHaveBeenCalledOnce();
    expect(await f.service.consumeReset(next.id)).toBe("reset"); expect(f.consume).toHaveBeenCalledTimes(2);
  });
  it("rejects changed accounts before any redemption", async () => {
    const f = setup(); await f.service.refresh(); const first = f.service.prepareReset("native:codex");
    f.read.mockResolvedValue(usageAccount({ identityKey: "account-b" })); await f.service.refresh(true);
    await expect(f.service.consumeReset(first.id)).rejects.toThrow("account changed"); expect(f.consume).not.toHaveBeenCalled();
  });
  it("preserves stale quota only for a verified identical account", async () => {
    const f = setup(); await f.service.refresh();
    f.read.mockResolvedValue(usageAccount({ windows: [], status: "error", canReset: false }));
    let result = await f.service.refresh(true);
    expect(result.accounts[0]).toMatchObject({ status: "stale", canReset: false, windows: [expect.objectContaining({ remainingPercent: 60 })] });
    f.read.mockResolvedValue(usageAccount({ identityKey: "changed", windows: [], status: "error", canReset: false }));
    result = await f.service.refresh(true); expect(result.accounts[0]?.windows).toEqual([]);
  });
  it("uses the vault's opaque reference for source credentials", async () => {
    const f = setup(); const source = { id: crypto.randomUUID(), label: "Hub", url: "https://hub.example.test", enabled: true };
    const expected = backendSecretReferenceForProfile(`usage-source:${source.id}`);
    const status = vi.fn(async (reference: string) => ({ hasSecret: reference === expected, credentialGeneration: "fixture" }));
    const forget = vi.fn(async () => true); f.deps.credentials = { resolve: async () => null, status, forget };
    await f.service.saveSource(source); expect(status.mock.calls[0]?.[0]).toBe(expected);
    await f.service.removeSource(source.id); expect(forget).toHaveBeenCalledWith(expected, f.deps.signal);
  });
  it("rejects expired confirmations before marking attempted and renews the original ID", async () => {
    const f = setup(); await f.service.refresh(); const first = f.service.prepareReset("native:codex");
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(first.expiresAt) + 1);
    try {
      const error = await f.service.consumeReset(first.id).catch((error: unknown) => error);
      expect(publicRuntimeError(error)).toBe(USAGE_RESET_CONFIRMATION_EXPIRED);
      expect(f.repository.attempt(first.id)?.attempted).toBe(false); expect(f.consume).not.toHaveBeenCalled();
      const renewed = f.service.prepareReset("native:codex"); expect(renewed.id).toBe(first.id); expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.now());
      await f.service.consumeReset(renewed.id); expect(f.consume).toHaveBeenCalledOnce();
    } finally { now.mockRestore(); }
  });
  it("does not forward an existing management key to an edited origin", async () => {
    const f = setup(); const source = { id: crypto.randomUUID(), label: "Hub", url: "https://hub.example.test", enabled: false };
    await f.service.saveSource(source);
    await expect(f.service.saveSource({ ...source, url: "https://different.example.test" })).rejects.toThrow("new management key");
    expect(f.repository.sources()).toEqual([source]);
  });
  it("records new sources without changing agent profiles or making network requests", async () => {
    const f = setup(); const profiles = vi.fn(() => []); f.deps.customProfiles = profiles;
    await f.service.saveSource({ id: crypto.randomUUID(), label: "Disabled hub", url: "https://hub.example.test", enabled: false });
    expect(f.read).not.toHaveBeenCalled(); expect(profiles).not.toHaveBeenCalled();
  });
});
