import type { ProviderId } from "../../shared/contracts";
import type { UsageAccount } from "../../shared/provider-usage-limits";
import { providerChildEnvironment, providerEnvironment } from "../environment";
import { cursorSubscriptionWindows, kimiSubscriptionWindows, openCodeSubscriptionWindows } from "./subscription-parsers";
import { readSubscriptionFile, subscriptionAccountIdentity, subscriptionJson, type NativeUsageAccount } from "./subscription-io";
import {
  CURSOR_ENDPOINT,
  KIMI_ENDPOINT,
  credentialContinuity,
  cursorCredential,
  kimiCredential,
  type SubscriptionCredential,
} from "./subscription-credentials";

export interface NativeSubscriptionDependencies {
  environment?: () => Promise<NodeJS.ProcessEnv>;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  readFile?: typeof readSubscriptionFile;
  readCursorKeychain?: () => Promise<string | null>;
  openCodeAccount?: (cwd: string, model: string | undefined, signal: AbortSignal) => Promise<{ token: string; scope: string } | null>;
  accountKey?: (signal: AbortSignal) => Promise<string | null>;
}
const KEYCHAIN_REASON = "Inertia reads this Cursor login from the macOS Keychain only when you ask, so it cannot confirm the account at the reset.";
const SESSION_REASON = "This login does not name a stable account, so Inertia cannot confirm it at the reset.";
const STORAGE_REASON = "Secure storage is unavailable, so Inertia cannot confirm the account at the reset.";
const NO_ACCOUNT_REASON = "The provider did not report an account Inertia can confirm at the reset.";
const UNSUPPORTED_DETAIL = "This account or selected model does not expose a supported subscription reset time.";
const OPENCODE_UNSUPPORTED_DETAIL = "Reset times are available for OpenCode Go models with a Go subscription. "
  + "Other OpenCode backends do not expose a shared quota API.";
const ERROR_DETAIL = "Subscription limits could not be checked. Refresh Limits after signing in to this provider.";
const sameAccount = (left: SubscriptionCredential, right: SubscriptionCredential) => left.scope === right.scope
  && (credentialContinuity(left) ?? left.token) === (credentialContinuity(right) ?? right.token);

export class NativeSubscriptionReader {
  private keychainRead: Promise<string | null> | null = null;
  private identityKey: string | null = null;
  constructor(private readonly dependencies: NativeSubscriptionDependencies = {}) {}
  private keychain(): Promise<string | null> {
    if (!this.keychainRead) {
      this.keychainRead = (async () => {
        if (this.dependencies.readCursorKeychain) return this.dependencies.readCursorKeychain();
        const { AsyncEntry } = await import("@napi-rs/keyring");
        return await new AsyncEntry("cursor-access-token", "cursor-user").getPassword() ?? null;
      })().finally(() => {
        this.keychainRead = null;
      });
    }
    return this.keychainRead;
  }
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
    if (credential.keychain) return { keychain: "read", resumeUnavailable: KEYCHAIN_REASON };
    const continuity = credentialContinuity(credential);
    if (!continuity) return { resumeUnavailable: SESSION_REASON };
    const key = await this.key(signal);
    if (!key) return { resumeUnavailable: STORAGE_REASON };
    return { credentialFingerprint: subscriptionAccountIdentity(key, credential.scope, continuity) };
  }
  private async credentials(provider: ProviderId, model: string | undefined, env: NodeJS.ProcessEnv, cwd: string,
    signal: AbortSignal, interactive: boolean): Promise<SubscriptionCredential | "deferred" | null> {
    const source = {
      env,
      platform: this.dependencies.platform ?? process.platform,
      read: this.dependencies.readFile ?? readSubscriptionFile,
      keychain: () => this.keychain(),
      interactive,
    };
    if (provider === "cursor") return cursorCredential(source);
    if (provider === "kimi") return kimiCredential(source, model);
    if (provider !== "opencode") return null;
    const account = await this.dependencies.openCodeAccount?.(cwd, model, signal);
    return account ? { ...account, kind: "key" } : null;
  }
  private async quota(provider: ProviderId, token: string, signal: AbortSignal): Promise<unknown> {
    const fetcher = this.dependencies.fetch ?? fetch;
    if (provider === "cursor") {
      return subscriptionJson(fetcher, `${CURSOR_ENDPOINT}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, token, signal,
        { post: true, headers: { "connect-protocol-version": "1", "x-cursor-client-type": "cli" } });
    }
    const url = provider === "kimi" ? `${KIMI_ENDPOINT}/usages` : "https://opencode.ai/zen/go/v1/usage";
    return subscriptionJson(fetcher, url, token, signal);
  }
  async read(base: UsageAccount, model: string | undefined, lifetime: AbortSignal, cwd: string, interactive = false): Promise<NativeUsageAccount> {
    const provider = base.providerId as ProviderId;
    if (provider === "antigravity") {
      return { ...base, windows: [], status: "unsupported", detail: "Antigravity's current CLI protocol does not report subscription reset times." };
    }
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(10_000)]);
    const work = async (): Promise<NativeUsageAccount> => {
      const source = await (this.dependencies.environment?.() ?? providerEnvironment().then(({ env }) => env));
      const env = providerChildEnvironment(provider, source);
      const account = await this.credentials(provider, model, env, cwd, signal, interactive);
      if (account === "deferred") {
        return { ...base, windows: [], status: "unavailable", keychain: "deferred",
          detail: "Refresh Limits to read this Cursor login from the macOS Keychain." };
      }
      if (!account) {
        return { ...base, windows: [], status: "unsupported", detail: provider === "opencode" ? OPENCODE_UNSUPPORTED_DETAIL : UNSUPPORTED_DETAIL };
      }
      signal.throwIfAborted();
      const raw = await this.quota(provider, account.token, signal);
      const receivedAt = Date.now();
      const current = account.keychain ? account : await this.credentials(provider, model, env, cwd, signal, interactive);
      signal.throwIfAborted();
      if (!current || current === "deferred" || !sameAccount(current, account)) throw new Error("The provider account changed during the read.");
      const windows = provider === "cursor" ? cursorSubscriptionWindows(raw)
        : provider === "kimi" ? kimiSubscriptionWindows(raw, receivedAt) : openCodeSubscriptionWindows(raw);
      const identity = await this.resumeIdentity(account, signal);
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
    } catch {
      return { ...base, windows: [], status: "error", detail: ERROR_DETAIL };
    } finally {
      signal.removeEventListener("abort", aborted);
    }
  }
}
