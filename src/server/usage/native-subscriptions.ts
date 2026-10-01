import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import type { ProviderId } from "../../shared/contracts";
import type { UsageAccount } from "../../shared/provider-usage-limits";
import { providerChildEnvironment, providerEnvironment } from "../environment";
import { cursorSubscriptionWindows, kimiSubscriptionWindows, openCodeSubscriptionWindows } from "./subscription-parsers";
import { readSubscriptionFile, subscriptionFingerprint, subscriptionJson } from "./subscription-io";

interface Credential { token: string; scope: string }
export interface NativeSubscriptionDependencies {
  environment?: () => Promise<NodeJS.ProcessEnv>;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  readFile?: typeof readSubscriptionFile;
  readCursorKeychain?: () => Promise<string | null>;
  openCodeAccount?: (cwd: string, model: string | undefined, signal: AbortSignal) => Promise<Credential | null>;
}
const token = z.string().min(1).max(64 * 1024);
const CURSOR_ENDPOINT = "https://api2.cursor.sh";
const KIMI_ENDPOINT = "https://api.kimi.com/coding/v1";
const trimEnd = (value: string) => value.replace(/\/+$/u, "");

/** Native account probes for providers whose CLI has no quota RPC. The same
 * credential precedence and selected route as the CLI must own the response. */
export class NativeSubscriptionReader {
  private keychainRead: Promise<string | null> | null = null;
  constructor(private readonly dependencies: NativeSubscriptionDependencies = {}) {}
  private keychain(): Promise<string | null> {
    if (!this.keychainRead) {
      this.keychainRead = (async () => {
        if (this.dependencies.readCursorKeychain) return this.dependencies.readCursorKeychain();
        const { AsyncEntry } = await import("@napi-rs/keyring");
        return await new AsyncEntry("cursor-access-token", "cursor-user").getPassword() ?? null;
      })().finally(() => { this.keychainRead = null; });
    }
    return this.keychainRead;
  }
  private async credentials(provider: ProviderId, model: string | undefined, env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal): Promise<Credential | null> {
    const platform = this.dependencies.platform ?? process.platform;
    const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || homedir();
    const read = this.dependencies.readFile ?? readSubscriptionFile;
    if (provider === "cursor") {
      // Stored logins must never be sent to an overridden API endpoint.
      if (trimEnd(env.CURSOR_API_ENDPOINT?.trim() || CURSOR_ENDPOINT) !== CURSOR_ENDPOINT) return null;
      if (env.CURSOR_AUTH_TOKEN?.trim()) return { token: token.parse(env.CURSOR_AUTH_TOKEN.trim()), scope: "cursor:subscription" };
      if (env.CURSOR_API_KEY?.trim() || env.AGENT_CLI_CREDENTIAL_STORE === "memory") return null;
      if (platform === "darwin" && env.AGENT_CLI_CREDENTIAL_STORE !== "file") {
        const value = await this.keychain();
        return value ? { token: token.parse(value), scope: "cursor:subscription" } : null;
      }
      const directory = platform === "win32" ? join(env.APPDATA || join(home, "AppData", "Roaming"), "Cursor")
        : platform === "darwin" ? join(home, ".cursor") : join(env.XDG_CONFIG_HOME || join(home, ".config"), "cursor");
      const contents = await read(join(directory, "auth.json"));
      const value = contents ? z.object({ accessToken: token.optional() }).parse(JSON.parse(contents)).accessToken : undefined;
      return value ? { token: value, scope: "cursor:subscription" } : null;
    }
    if (provider === "opencode") {
      return await this.dependencies.openCodeAccount?.(cwd, model, signal) ?? null;
    }
    if (provider !== "kimi") return null;
    const share = env.KIMI_SHARE_DIR || join(home, ".kimi");
    const toml = await read(join(share, "config.toml"));
    const legacy = toml === null ? await read(join(share, "config.json")) : null;
    if (toml === null && legacy === null) return null;
    const config = z.object({ default_model: z.string().optional(),
      models: z.record(z.string(), z.object({ model: z.string(), provider: z.string() })),
      providers: z.record(z.string(), z.object({ type: z.string(), base_url: z.string(), api_key: z.string().optional(),
        oauth: z.object({ storage: z.enum(["file", "keyring"]).default("file"), key: z.string() }).optional() })) }).parse(toml !== null ? parseToml(toml) : JSON.parse(legacy!));
    const selected = !model || model === "provider-default" ? config.default_model : model.replace(/,thinking$/u, "");
    const exact = selected ? config.models[selected] : undefined;
    const matches = exact ? [exact] : Object.values(config.models).filter((entry) => entry.model === selected);
    if (matches.length !== 1) return null;
    const entry = matches[0]!;
    const providerConfig = config.providers[entry.provider];
    if (entry.provider !== "managed:kimi-code" || providerConfig?.type !== "kimi"
      || trimEnd(env.KIMI_BASE_URL || providerConfig.base_url) !== KIMI_ENDPOINT
      || (env.KIMI_CODE_BASE_URL && trimEnd(env.KIMI_CODE_BASE_URL) !== KIMI_ENDPOINT)) return null;
    let value: string | undefined;
    if (providerConfig.oauth) {
      if (providerConfig.oauth.storage !== "file" || providerConfig.oauth.key !== "oauth/kimi-code") return null;
      const credentials = await read(join(share, "credentials", "kimi-code.json"));
      if (credentials) {
        const account = z.object({ access_token: token, expires_at: z.number().finite() }).parse(JSON.parse(credentials));
        if (account.expires_at * 1000 <= Date.now()) return null;
        value = account.access_token;
      }
    }
    value ||= env.KIMI_API_KEY?.trim() || providerConfig.api_key;
    return value ? { token: token.parse(value), scope: "kimi:code" } : null;
  }
  async read(base: UsageAccount, model: string | undefined, lifetime: AbortSignal, cwd: string): Promise<UsageAccount> {
    const provider = base.providerId as ProviderId;
    if (provider === "antigravity") return { ...base, windows: [], status: "unsupported", detail: "Antigravity's current CLI protocol does not report subscription reset times." };
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(10_000)]);
    const work = async (): Promise<UsageAccount> => {
      const env = providerChildEnvironment(provider, await (this.dependencies.environment?.() ?? providerEnvironment().then(({ env }) => env)));
      const account = await this.credentials(provider, model, env, cwd, signal);
      if (!account) return { ...base, windows: [], status: "unsupported", detail: provider === "opencode"
        ? "Reset times are available for OpenCode Go models with a Go subscription. Other OpenCode backends do not expose a shared quota API."
        : "This account or selected model does not expose a supported subscription reset time." };
      signal.throwIfAborted();
      const fingerprint = subscriptionFingerprint(account.scope, account.token);
      const fetcher = this.dependencies.fetch ?? fetch;
      const raw = provider === "cursor"
        ? await subscriptionJson(fetcher, `${CURSOR_ENDPOINT}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, account.token, signal,
          { post: true, headers: { "connect-protocol-version": "1", "x-cursor-client-type": "cli" } })
        : await subscriptionJson(fetcher, provider === "kimi" ? `${KIMI_ENDPOINT}/usages` : "https://opencode.ai/zen/go/v1/usage", account.token, signal);
      const receivedAt = Date.now();
      const current = await this.credentials(provider, model, env, cwd, signal);
      signal.throwIfAborted();
      if (!current || subscriptionFingerprint(current.scope, current.token) !== fingerprint) throw new Error("The provider account changed during the read.");
      const windows = provider === "cursor" ? cursorSubscriptionWindows(raw) : provider === "kimi" ? kimiSubscriptionWindows(raw, receivedAt) : openCodeSubscriptionWindows(raw);
      return { ...base, windows, credentialFingerprint: fingerprint, status: windows.length ? "ready" : "unavailable",
        updatedAt: new Date(receivedAt).toISOString(), checkedAt: new Date().toISOString(),
        detail: windows.length ? null : "The provider did not report quota windows." };
    };
    // Keychain access can wait on a native OS prompt. Keep that one request in
    // flight for the next read, while the caller's deadline remains bounded.
    let aborted!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => { aborted = () => reject(new Error("Subscription read cancelled.")); signal.addEventListener("abort", aborted, { once: true }); if (signal.aborted) aborted(); });
    try { return await Promise.race([work(), cancelled]); }
    catch { return { ...base, windows: [], status: "error", detail: "Subscription limits could not be checked. Refresh Limits after signing in to this provider." }; }
    finally { signal.removeEventListener("abort", aborted); }
  }
}
