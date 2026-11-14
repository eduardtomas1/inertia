import { backendSecretReferenceForProfile } from "../../node/backend-secret-reference";
import { ProviderRuntimeError } from "../provider/contracts";
import { USAGE_RESET_CONFIRMATION_EXPIRED } from "../../shared/provider-usage-limits";
import { createHash, randomUUID } from "node:crypto";
import type { ProviderInfo } from "../../shared/contracts";
import { usageSourceInputSchema, usageSourceOrigin, usageSourceProfileId, type UsageLimitsSnapshot, type UsageResetConfirmation, type UsageResetOutcome, type UsageSource } from "../../shared/provider-usage-limits";
import type { UsageLimitsRepository } from "../persistence/usage-limits-repository";
import type { BackendCredentialBroker } from "../runtime/backends/backend-profile-types";
import { CliproxyUsageClient, opaqueUsageIdentity, usageWindows } from "./cliproxy";
import type { NativeUsageReader } from "./native";
import type { NativeUsageAccount } from "./subscription-io";

type AccountRoute = { source: UsageSource; auth: Awaited<ReturnType<CliproxyUsageClient["accounts"]>>[number] };
const CHAT_ACCOUNT_LIMIT = 32;
function staleProjection(account: NativeUsageAccount, now: number): { status?: "stale"; canReset?: false } {
  if (account.status !== "ready") return {};
  const old = now - Date.parse(account.updatedAt ?? "") > 180_000;
  const reset = account.windows.some((window) => window.resetsAt && Date.parse(window.resetsAt) <= now);
  return old || reset ? { status: "stale", canReset: false } : {};
}
export interface UsageLimitsDependencies {
  repository: UsageLimitsRepository;
  credentials?: BackendCredentialBroker;
  native: Pick<NativeUsageReader, "read" | "consume">;
  providers(): ProviderInfo[];
  customProfiles(): Array<{ id: string; label: string; routeKind?: "account" | "api-key" }>;
  signal: AbortSignal;
  enabled: boolean;
  hub?: CliproxyUsageClient;
}
export class UsageLimitsService {
  private accounts: NativeUsageAccount[] = [];
  private chatAccounts = new Map<string, NativeUsageAccount>();
  private chatReads = new Map<string, Promise<NativeUsageAccount | null>>();
  private routes = new Map<string, AccountRoute>();
  private sourceErrors = new Map<string, string>();
  private checkedAt: string | null = null;
  private refreshInFlight: { promise: Promise<UsageLimitsSnapshot>; interactive: boolean } | null = null;
  private operation: Promise<unknown> = Promise.resolve();
  private readonly hub: CliproxyUsageClient;
  constructor(private readonly dependencies: UsageLimitsDependencies) { this.hub = dependencies.hub ?? new CliproxyUsageClient(); }
  snapshot(): UsageLimitsSnapshot {
    const now = Date.now();
    return { checkedAt: this.checkedAt,
      sources: this.dependencies.repository.sources().map((source) => ({ ...source, error: this.sourceErrors.get(source.id) ?? null })),
      accounts: [...this.accounts, ...this.lastReportedAccounts()].map((account) => {
        const publicAccount = { ...account };
        delete publicAccount.credentialFingerprint;
        delete publicAccount.resumeUnavailable;
        const pending = account.identityKey ? this.dependencies.repository.pending(account.identityKey) : null;
        const incompatible = pending && pending.confirmation.creditId === null && account.id !== "native:codex";
        return { ...publicAccount,
        pendingReset: Boolean(pending && !incompatible),
        ...(incompatible ? { canReset: false, detail: "A server-selected reset is pending on this computer. Check it through the original native Codex connection." } : {}),
        ...staleProjection(account, now),
      }; }),
    };
  }
  private lastReportedAccounts(): NativeUsageAccount[] {
    if (!this.dependencies.enabled || this.checkedAt) return [];
    const read = new Set(this.accounts.map(({ id }) => id));
    return this.dependencies.providers()
      .filter((info) => info.rateLimits.length > 0 && !read.has(`native:${info.id}`)
        && (info.available || info.installState !== "not-installed"))
      .map((info) => this.reportedAccount(info, "stale"));
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.operation.then(() => { this.dependencies.signal.throwIfAborted(); return run(); });
    this.operation = next.catch(() => undefined); return next;
  }
  refresh(force = false, interactive = true): Promise<UsageLimitsSnapshot> {
    const running = this.refreshInFlight;
    if (running && (running.interactive || !interactive)) return running.promise;
    if (!running && !force && this.checkedAt && Date.now() - Date.parse(this.checkedAt) < 60000) {
      return Promise.resolve(this.snapshot());
    }
    const operation = this.serial(() => this.read());
    this.refreshInFlight = { promise: operation, interactive };
    void operation.finally(() => {
      if (this.refreshInFlight?.promise === operation) this.refreshInFlight = null;
    }).catch(() => undefined);
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
      // Retain the visible retry entry until secure storage confirms completion.
      await this.dependencies.credentials?.forget(backendSecretReferenceForProfile(usageSourceProfileId(id)), this.dependencies.signal);
      this.dependencies.repository.removeSource(id);
      this.accounts = this.accounts.filter((account) => !account.id.startsWith(`hub:${id}:`));
      for (const [key, route] of this.routes) if (route.source.id === id) this.routes.delete(key);
      this.sourceErrors.delete(id);
      return this.snapshot();
    });
  }
  async nativeAccount(providerId: ProviderInfo["id"], force = false, model?: string, cwd?: string, interactive = false): Promise<NativeUsageAccount | null> {
    const scope = JSON.stringify([providerId, model ?? null, cwd ?? null]);
    const cached = this.chatAccounts.get(scope);
    const lifetime = cached?.status === "unavailable" || cached?.status === "error" ? 15_000 : 60_000;
    if (!force && cached?.checkedAt && Date.now() - Date.parse(cached.checkedAt) < lifetime) {
      return { ...cached, ...staleProjection(cached, Date.now()) };
    }
    const key = `${scope}:${interactive}`;
    const running = this.chatReads.get(key);
    if (running) return running;
    const read = this.serial(async () => {
      const info = this.dependencies.providers().find((provider) => provider.id === providerId);
      if (!info || !this.dependencies.enabled) return null;
      const account = await this.dependencies.native.read(info, model, cwd).catch(() => null);
      if (account) this.rememberChatAccount(scope, account);
      return account;
    }).finally(() => {
      if (this.chatReads.get(key) === read) this.chatReads.delete(key);
    });
    this.chatReads.set(key, read);
    return read;
  }
  cachedNativeAccount(providerId: ProviderInfo["id"], model?: string, cwd?: string): NativeUsageAccount | null {
    const chat = this.chatAccounts.get(JSON.stringify([providerId, model ?? null, cwd ?? null]));
    const limits = this.accounts.find((account) => account.id === `native:${providerId}`);
    const account = [chat, limits].filter((entry) => entry !== undefined)
      .sort((left, right) => Date.parse(right.checkedAt ?? "") - Date.parse(left.checkedAt ?? ""))[0];
    return account ? { ...account, ...staleProjection(account, Date.now()) } : null;
  }
  private rememberChatAccount(scope: string, account: NativeUsageAccount): void {
    this.chatAccounts.delete(scope);
    this.chatAccounts.set(scope, account);
    if (this.chatAccounts.size > CHAT_ACCOUNT_LIMIT) this.chatAccounts.delete(this.chatAccounts.keys().next().value!);
  }
  private async read(): Promise<UsageLimitsSnapshot> {
    const previous = new Map(this.accounts.map((account) => [account.id, account]));
    const reconcile = (account: NativeUsageAccount): NativeUsageAccount => {
      const old = previous.get(account.id);
      const sameLogin = old && ((old.identityKey && account.identityKey === old.identityKey)
        || (old.credentialFingerprint && account.credentialFingerprint === old.credentialFingerprint));
      return account.status === "error" && sameLogin
        ? { ...account, status: "stale", windows: old.windows, updatedAt: old.updatedAt, credits: old.credits, canReset: false }
        : account;
    };
    const publish = (accounts: NativeUsageAccount[]): void => {
      const fresh = new Map(accounts.map((account) => [account.id, reconcile(account)]));
      const known = new Set(this.accounts.map(({ id }) => id));
      this.accounts = [
        ...this.accounts.map((account) => fresh.get(account.id) ?? account),
        ...[...fresh.values()].filter(({ id }) => !known.has(id)),
      ];
    };
    this.routes.clear(); this.sourceErrors.clear();
    const native = this.dependencies.providers()
      .filter((info) => info.available || info.installState !== "not-installed")
      .map(async (info) => {
        const account = await this.readNative(info);
        publish([account]);
        return account;
      });
    const profiles = this.dependencies.customProfiles().map((profile): NativeUsageAccount => ({ id: `profile:${profile.id}`, providerId: "custom", providerLabel: profile.label, label: profile.label,
      email: null, plan: null, identityKey: null, sources: ["Configured route"], windows: [], credits: null, canReset: false, updatedAt: null, checkedAt: null,
      ...(profile.routeKind === "api-key"
        ? { status: "unavailable" as const, detail: "Usage and limits are not available for API keys." }
        : { status: "unsupported" as const, detail: "This custom route does not expose subscription quotas. Connecting a usage hub does not change agent routing." }) }));
    const timeout = AbortSignal.timeout(20000);
    const signal = AbortSignal.any([this.dependencies.signal, timeout]);
    const hubs = this.dependencies.repository.sources().filter((source) => source.enabled).map(async (source) => {
      try {
        const key = await this.dependencies.credentials?.resolve(backendSecretReferenceForProfile(usageSourceProfileId(source.id)), signal);
        if (!key) throw new Error();
        const auths = await this.hub.accounts(source, key, signal);
        const accounts: NativeUsageAccount[] = [];
        for (let offset = 0; offset < auths.length; offset += 4) {
          const batch = await Promise.all(auths.slice(offset, offset + 4).map(async (auth) => {
            const account = await this.hub.read(source, key, auth, signal);
            this.routes.set(account.id, { source, auth }); return account;
          }));
          publish(batch);
          accounts.push(...batch);
        }
        return accounts;
      } catch {
        this.sourceErrors.set(source.id, "The hub could not be read. Check its address, management key, and account limit (32).");
        return [...previous.values()].filter((account) => account.id.startsWith(`hub:${source.id}:`)).map((account) => ({ ...account, status: "stale" as const, canReset: false, checkedAt: new Date().toISOString(), detail: "Hub unavailable; showing previously reported quota." }));
      }
    });
    const [nativeAccounts, hubAccounts] = await Promise.all([Promise.all(native), Promise.all(hubs)]);
    this.accounts = [...nativeAccounts, ...profiles, ...hubAccounts.flat()].map(reconcile);
    this.checkedAt = new Date().toISOString();
    return this.snapshot();
  }
  private async readNative(info: ProviderInfo): Promise<NativeUsageAccount> {
    try {
      return this.dependencies.enabled ? await this.dependencies.native.read(info) : this.reportedAccount(info, info.rateLimits.length ? "ready" : "unsupported");
    } catch {
      return { id: `native:${info.id}`, providerId: info.id, providerLabel: info.label, label: `${info.label} account`,
        email: null, plan: null, identityKey: null, sources: ["This computer"], status: "error", detail: "Account usage could not be read.", windows: [], credits: null, canReset: false, updatedAt: null, checkedAt: new Date().toISOString() };
    }
  }
  private reportedAccount(info: ProviderInfo, status: "ready" | "stale" | "unsupported"): NativeUsageAccount {
    return { id: `native:${info.id}`, providerId: info.id, providerLabel: info.label, label: `${info.label} account`,
      email: null, plan: null, identityKey: null, sources: ["This computer"], status,
      detail: status === "unsupported" ? "This provider does not expose a supported subscription quota API." : status === "stale" ? "Showing the last reported quota while this account is checked." : null,
      windows: usageWindows(info.rateLimits), credits: null, canReset: false, updatedAt: info.metadataState.rateLimits.updatedAt, checkedAt: status === "stale" ? null : new Date().toISOString() };
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
