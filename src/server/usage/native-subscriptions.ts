import type { ProviderId } from "../../shared/contracts";
import type { UsageAccount } from "../../shared/provider-usage-limits";
import { openCodeSubscriptionWindows } from "./subscription-parsers";
import { subscriptionAccountIdentity, subscriptionJson, SubscriptionHttpError, type NativeUsageAccount } from "./subscription-io";

export interface NativeSubscriptionDependencies {
  fetch?: typeof fetch;
  openCodeAccount?: (cwd: string, model: string | undefined, signal: AbortSignal) => Promise<{ token: string; scope: string } | null>;
  accountKey?: (signal: AbortSignal) => Promise<string | null>;
}
type SubscriptionCredential = { token: string; scope: string };
const STORAGE_REASON = "Secure storage is unavailable, so Inertia cannot confirm the account at the reset.";
const NO_ACCOUNT_REASON = "The provider did not report an account Inertia can confirm at the reset.";
const UNREPORTED_DETAIL = "Usage is not reported by this agent.";
const OPENCODE_UNSUPPORTED_DETAIL = "Reset times are available for OpenCode Go models with a Go subscription. "
  + "Other OpenCode backends do not expose a shared quota API.";
const FAILED_DETAIL = "The provider did not answer the quota check.";
const REFUSED_DETAIL = "The provider refused the quota check for this login.";
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const MAX_COOLDOWNS = 32;
const waitDetail = (until: number) =>
  `The provider asked Inertia to wait ${Math.max(1, Math.ceil((until - Date.now()) / 60_000))} min before checking quota again.`;
const sameAccount = (left: SubscriptionCredential, right: SubscriptionCredential) => left.scope === right.scope && left.token === right.token;

export class NativeSubscriptionReader {
  private identityKey: string | null = null;
  private readonly cooldowns = new Map<string, number>();
  constructor(private readonly dependencies: NativeSubscriptionDependencies = {}) {}
  private async key(signal: AbortSignal): Promise<string | null> {
    this.identityKey ??= await this.dependencies.accountKey?.(signal).catch(() => null) ?? null;
    return this.identityKey;
  }
  async withMetadataIdentity(account: NativeUsageAccount, signal: AbortSignal): Promise<NativeUsageAccount> {
    if (account.identityKey || account.credentialFingerprint) return account;
    if (!account.email) return { ...account, resumeUnavailable: NO_ACCOUNT_REASON };
    const key = await this.key(signal);
    if (!key) return { ...account, resumeUnavailable: STORAGE_REASON };
    const reported = JSON.stringify([account.providerId, account.email, account.organization ?? null, account.plan]);
    return { ...account, credentialFingerprint: subscriptionAccountIdentity(key, `metadata:${account.providerId}`, reported) };
  }
  private async resumeIdentity(credential: SubscriptionCredential, signal: AbortSignal): Promise<Partial<NativeUsageAccount>> {
    const key = await this.key(signal);
    if (!key) return { resumeUnavailable: STORAGE_REASON };
    return { credentialFingerprint: subscriptionAccountIdentity(key, credential.scope, JSON.stringify(["key", credential.token])) };
  }
  private coolDown(fingerprint: string, until: number): void {
    this.cooldowns.delete(fingerprint);
    for (const [key, at] of this.cooldowns) if (at <= Date.now()) this.cooldowns.delete(key);
    if (this.cooldowns.size >= MAX_COOLDOWNS) this.cooldowns.delete(this.cooldowns.keys().next().value!);
    this.cooldowns.set(fingerprint, until);
  }
  private async credentials(provider: ProviderId, model: string | undefined, cwd: string, signal: AbortSignal): Promise<SubscriptionCredential | null> {
    if (provider !== "opencode") return null;
    return await this.dependencies.openCodeAccount?.(cwd, model, signal) ?? null;
  }
  async read(base: UsageAccount, model: string | undefined, lifetime: AbortSignal, cwd: string): Promise<NativeUsageAccount> {
    const provider = base.providerId as ProviderId;
    if (provider === "cursor" || provider === "kimi") return { ...base, windows: [], status: "unavailable", detail: UNREPORTED_DETAIL };
    if (provider === "antigravity") {
      return { ...base, windows: [], status: "unsupported", detail: "Antigravity's current CLI protocol does not report subscription reset times." };
    }
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(10_000)]);
    let identity: Partial<NativeUsageAccount> = {};
    const work = async (): Promise<NativeUsageAccount> => {
      const account = await this.credentials(provider, model, cwd, signal);
      if (!account) return { ...base, windows: [], status: "unsupported", detail: OPENCODE_UNSUPPORTED_DETAIL };
      signal.throwIfAborted();
      identity = await this.resumeIdentity(account, signal);
      const fingerprint = identity.credentialFingerprint;
      const until = fingerprint ? this.cooldowns.get(fingerprint) ?? 0 : 0;
      if (until > Date.now()) return { ...base, ...identity, windows: [], status: "error", detail: waitDetail(until) };
      const raw = await subscriptionJson(this.dependencies.fetch ?? fetch, "https://opencode.ai/zen/go/v1/usage", account.token, signal);
      const receivedAt = Date.now();
      const current = await this.credentials(provider, model, cwd, signal);
      signal.throwIfAborted();
      if (!current || !sameAccount(current, account)) {
        identity = {};
        throw new Error("The provider account changed during the read.");
      }
      if (fingerprint) this.cooldowns.delete(fingerprint);
      const windows = openCodeSubscriptionWindows(raw);
      return {
        ...base,
        windows,
        ...identity,
        status: windows.length ? "ready" : "unavailable",
        updatedAt: new Date(receivedAt).toISOString(),
        checkedAt: new Date().toISOString(),
        detail: windows.length ? null : "The provider did not report quota windows.",
      };
    };
    let aborted!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(new Error("Subscription read cancelled."));
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
    try {
      return await Promise.race([work(), cancelled]);
    } catch (error) {
      const failed = { ...base, ...identity, windows: [], status: "error" as const };
      if (!(error instanceof SubscriptionHttpError)) return { ...failed, detail: FAILED_DETAIL };
      if (error.status === 401 || error.status === 403) return { ...failed, detail: REFUSED_DETAIL };
      const throttled = error.status === 429 || (error.status === 503 && error.retryAfterMs !== null);
      if (!throttled) return { ...failed, detail: FAILED_DETAIL };
      const until = Date.now() + Math.min(MAX_COOLDOWN_MS, error.retryAfterMs || DEFAULT_COOLDOWN_MS);
      if (identity.credentialFingerprint) this.coolDown(identity.credentialFingerprint, until);
      return { ...failed, detail: waitDetail(until) };
    } finally {
      signal.removeEventListener("abort", aborted);
    }
  }
}
