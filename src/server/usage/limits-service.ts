import { backendSecretReferenceForProfile } from "../../node/backend-secret-reference";
import { ProviderRuntimeError } from "../provider/contracts";
import { USAGE_RESET_CONFIRMATION_EXPIRED } from "../../shared/provider-usage-limits";
import { createHash, randomUUID } from "node:crypto";
import type { ProviderInfo } from "../../shared/contracts";
import { usageSourceInputSchema, usageSourceOrigin, usageSourceProfileId, type UsageAccount, type UsageLimitsSnapshot, type UsageResetConfirmation, type UsageResetOutcome, type UsageSource } from "../../shared/provider-usage-limits";
import type { UsageLimitsRepository } from "../persistence/usage-limits-repository";
import type { BackendCredentialBroker } from "../runtime/backends/backend-profile-types";
import { CliproxyUsageClient, opaqueUsageIdentity, usageWindows } from "./cliproxy";
import type { NativeUsageReader } from "./native";

type AccountRoute = { source: UsageSource; auth: Awaited<ReturnType<CliproxyUsageClient["accounts"]>>[number] };
export interface UsageLimitsDependencies {
  repository: UsageLimitsRepository;
  credentials?: BackendCredentialBroker;
  native: Pick<NativeUsageReader, "read" | "consume">;
  providers(): ProviderInfo[];
  customProfiles(): Array<{ id: string; label: string }>;
  signal: AbortSignal;
  enabled: boolean;
  hub?: CliproxyUsageClient;
}
export class UsageLimitsService {
  private accounts: UsageAccount[] = [];
  private routes = new Map<string, AccountRoute>();
  private sourceErrors = new Map<string, string>();
  private checkedAt: string | null = null;
  private refreshInFlight: Promise<UsageLimitsSnapshot> | null = null;
  private operation: Promise<unknown> = Promise.resolve();
  private readonly hub: CliproxyUsageClient;
  constructor(private readonly dependencies: UsageLimitsDependencies) { this.hub = dependencies.hub ?? new CliproxyUsageClient(); }
  snapshot(): UsageLimitsSnapshot {
    const now = Date.now();
    return { checkedAt: this.checkedAt,
      sources: this.dependencies.repository.sources().map((source) => ({ ...source, error: this.sourceErrors.get(source.id) ?? null })),
      accounts: this.accounts.map((account) => {
        const pending = account.identityKey ? this.dependencies.repository.pending(account.identityKey) : null;
        const incompatible = pending && pending.confirmation.creditId === null && account.id !== "native:codex";
        return { ...account,
        pendingReset: Boolean(pending && !incompatible),
        ...(incompatible ? { canReset: false, detail: "A server-selected reset is pending on this computer. Check it through the original native Codex connection." } : {}),
        ...(account.status === "ready" && (now - Date.parse(account.updatedAt ?? "") > 180000 || account.windows.some((window) => window.resetsAt && Date.parse(window.resetsAt) <= now))
          ? { status: "stale" as const, canReset: false } : {}),
      }; }),
    };
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.operation.then(() => { this.dependencies.signal.throwIfAborted(); return run(); });
    this.operation = next.catch(() => undefined); return next;
  }
  refresh(force = false): Promise<UsageLimitsSnapshot> {
    if (this.refreshInFlight) return this.refreshInFlight;
    if (!force && this.checkedAt && Date.now() - Date.parse(this.checkedAt) < 60000) return Promise.resolve(this.snapshot());
    const operation = this.serial(() => this.read());
    this.refreshInFlight = operation;
    void operation.finally(() => { this.refreshInFlight = null; }).catch(() => undefined);
    return operation;
  }
  async saveSource(input: UsageSource): Promise<UsageLimitsSnapshot> {
    return this.serial(async () => {
      const parsed = usageSourceInputSchema.parse(input);
      const source = { ...parsed, url: usageSourceOrigin(parsed.url)! };
      const existing = this.dependencies.repository.sources().find(({ id }) => id === source.id);
      // An address change must use a new vault slot, so it cannot forward an existing key to a new host.
      if (existing && existing.url !== source.url) throw new Error("Remove this hub and add its new address with a new management key.");
      if (source.enabled && !(await this.dependencies.credentials?.status(backendSecretReferenceForProfile(usageSourceProfileId(source.id)), this.dependencies.signal))?.hasSecret) throw new Error("Save a management key in secure storage first.");
      this.dependencies.repository.saveSource(source);
      this.accounts = this.accounts.filter((account) => !account.id.startsWith(`hub:${source.id}:`));
      this.checkedAt = null;
      return this.snapshot();
    });
  }
  async removeSource(id: string): Promise<UsageLimitsSnapshot> {
    return this.serial(async () => {
      this.dependencies.repository.removeSource(id);
      this.accounts = this.accounts.filter((account) => !account.id.startsWith(`hub:${id}:`));
      for (const [key, route] of this.routes) if (route.source.id === id) this.routes.delete(key);
      this.sourceErrors.delete(id);
      await this.dependencies.credentials?.forget(backendSecretReferenceForProfile(usageSourceProfileId(id)), this.dependencies.signal);
      return this.snapshot();
    });
  }
  private async read(): Promise<UsageLimitsSnapshot> {
    const previous = new Map(this.accounts.map((account) => [account.id, account]));
    const next: UsageAccount[] = [];
    this.routes.clear(); this.sourceErrors.clear();
    for (const info of this.dependencies.providers()) {
      if (!info.available && info.installState === "not-installed") continue;
      try {
        next.push(this.dependencies.enabled ? await this.dependencies.native.read(info) : {
          id: `native:${info.id}`, providerId: info.id, providerLabel: info.label, label: `${info.label} account`,
          email: null, plan: null, identityKey: null, sources: ["This computer"], status: info.rateLimits.length ? "ready" : "unsupported", detail: info.rateLimits.length ? null : "This provider does not expose a supported subscription quota API.",
          windows: usageWindows(info.rateLimits), credits: null, canReset: false, updatedAt: info.metadataState.rateLimits.updatedAt, checkedAt: new Date().toISOString(),
        });
      } catch {
        next.push({ id: `native:${info.id}`, providerId: info.id, providerLabel: info.label, label: `${info.label} account`,
          email: null, plan: null, identityKey: null, sources: ["This computer"], status: "error", detail: "Account usage could not be read. Refresh to retry.", windows: [], credits: null, canReset: false, updatedAt: null, checkedAt: new Date().toISOString() });
      }
    }
    for (const profile of this.dependencies.customProfiles()) next.push({ id: `profile:${profile.id}`, providerId: "custom", providerLabel: profile.label, label: profile.label,
      email: null, plan: null, identityKey: null, sources: ["Configured route"], status: "unsupported", detail: "This custom route does not expose subscription quotas. Connecting a usage hub does not change agent routing.", windows: [], credits: null, canReset: false, updatedAt: null, checkedAt: null });
    // A single deadline covers all hub requests, including streaming and account fan-out.
    const timeout = AbortSignal.timeout(20000);
    const signal = AbortSignal.any([this.dependencies.signal, timeout]);
    for (const source of this.dependencies.repository.sources()) {
      if (!source.enabled) continue;
      try {
        const key = await this.dependencies.credentials?.resolve(backendSecretReferenceForProfile(usageSourceProfileId(source.id)), signal);
        if (!key) throw new Error();
        const auths = await this.hub.accounts(source, key, signal);
        for (let offset = 0; offset < auths.length; offset += 4) {
          const batch = await Promise.all(auths.slice(offset, offset + 4).map(async (auth) => {
            const account = await this.hub.read(source, key, auth, signal);
            this.routes.set(account.id, { source, auth }); return account;
          }));
          next.push(...batch);
        }
      } catch {
        this.sourceErrors.set(source.id, "The hub could not be read. Check its address, management key, and account limit (32).");
        next.push(...[...previous.values()].filter((account) => account.id.startsWith(`hub:${source.id}:`)).map((account) => ({ ...account, status: "stale" as const, canReset: false, checkedAt: new Date().toISOString(), detail: "Hub unavailable; showing previously reported quota." })));
      }
    }
    this.accounts = next.map((account) => {
      const old = previous.get(account.id);
      return account.status === "error" && old?.identityKey && account.identityKey === old.identityKey
        ? { ...account, status: "stale", windows: old.windows, updatedAt: old.updatedAt, credits: old.credits, canReset: false }
        : account;
    });
    this.checkedAt = new Date().toISOString();
    return this.snapshot();
  }
  prepareReset(accountId: string): UsageResetConfirmation {
    const account = this.snapshot().accounts.find(({ id }) => id === accountId);
    const pending = account?.identityKey ? this.dependencies.repository.pending(account.identityKey) : null;
    if (!account?.identityKey || (!pending && !account.canReset)) throw new Error("Refresh this account's limits before using a reset.");
    if (pending && pending.confirmation.accountId !== accountId && account.status !== "ready") throw new Error("Refresh the new account route before checking the original reset.");
    const creditId = pending ? pending.confirmation.creditId : account.credits?.nextCreditId ?? null;
    if (accountId.startsWith("hub:") && !creditId) throw new Error("This hub did not report a redeemable credit ID.");
    const creditKey = createHash("sha256").update(JSON.stringify([account.identityKey, creditId, account.windows, account.credits?.availableCount])).digest("hex");
    return this.dependencies.repository.prepare(creditKey, {
      id: pending?.confirmation.id ?? randomUUID(), accountId, accountKey: account.identityKey, accountLabel: account.label,
      email: account.email, plan: account.plan, creditId, expiresAt: new Date(Date.now() + 120000).toISOString(),
    });
  }
  consumeReset(id: string): Promise<UsageResetOutcome> {
    // All source/account changes and redemptions share admission; one account cannot spend twice concurrently.
    return this.serial(async () => {
      const attempt = this.dependencies.repository.attempt(id);
      if (!attempt) throw new Error("Confirm the account before using a reset.");
      if (attempt.outcome) return attempt.outcome;
      const confirmation = attempt.confirmation;
      if (Date.parse(confirmation.expiresAt) <= Date.now()) throw new ProviderRuntimeError("invalid_input", USAGE_RESET_CONFIRMATION_EXPIRED);
      const account = this.accounts.find(({ id: accountId }) => accountId === confirmation.accountId);
      if (!account || account.identityKey !== confirmation.accountKey) throw new Error("The account changed. Refresh Limits before confirming again.");
      const route = this.routes.get(account.id);
      try {
        this.dependencies.repository.markAttempted(id);
        let outcome: UsageResetOutcome;
        if (account.id === "native:codex") outcome = await this.dependencies.native.consume(confirmation, account);
        else if (route && confirmation.creditId) {
          const source = this.dependencies.repository.sources().find(({ id: sourceId }) => sourceId === route.source.id);
          if (!source?.enabled) throw new Error();
          const signal = AbortSignal.any([this.dependencies.signal, AbortSignal.timeout(15000)]);
          const key = await this.dependencies.credentials?.resolve(backendSecretReferenceForProfile(usageSourceProfileId(source.id)), signal);
          if (!key) throw new Error();
          const auth = (await this.hub.accounts(source, key, signal)).find((auth) => auth.id === route.auth.id);
          if (!auth || auth.disabled || auth.provider !== "codex" || !auth.id_token?.chatgpt_account_id || opaqueUsageIdentity("codex", auth.id_token.chatgpt_account_id) !== confirmation.accountKey) throw new Error();
          outcome = await this.hub.consume(source, key, auth, confirmation.creditId, id, signal);
        } else throw new Error();
        this.dependencies.repository.settle(id, outcome);
        this.accounts = this.accounts.map((entry) => entry.identityKey === account.identityKey ? { ...entry, status: "stale", canReset: false } : entry);
        this.checkedAt = null;
        return outcome;
      } catch { throw new Error("The reset outcome is uncertain. Retry this same confirmation to check the original attempt; a new credit will not be selected."); }
    });
  }
}
