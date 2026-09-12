import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";
import type { UsageAccount, UsageResetConfirmation, UsageResetOutcome } from "../../shared/provider-usage-limits";
import { usageResetOutcomeSchema } from "../../shared/provider-usage-limits";
import type { ProviderInfo } from "../../shared/contracts";
import { withCodexControlClient, type CodexControlClient } from "../codex/control-client";
import { parseCodexRateLimits } from "../codex-metadata";
import type { ProviderManager } from "../providers";
import { nativeResetCredits, opaqueUsageIdentity, usageWindows } from "./cliproxy";

/** Read only the provider-owned account identity. Tokens never leave this function. */
async function codexAccountIdentity(environment: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const directory = await realpath(environment.CODEX_HOME ?? join(environment.HOME ?? environment.USERPROFILE ?? homedir(), ".codex"));
    const path = join(directory, "auth.json");
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536) return null;
    const handle = await open(path, constants.O_RDONLY | FILE_OPEN_NO_FOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== metadata.dev || stat.ino !== metadata.ino || stat.size > 65536) return null;
      const buffer = Buffer.alloc(65537);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) return null;
      const value = z.object({ auth_mode: z.literal("chatgpt").optional(), tokens: z.object({ account_id: z.string().min(1).max(256) }) }).safeParse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")));
      buffer.fill(0);
      return value.success ? opaqueUsageIdentity("codex", value.data.tokens.account_id) : null;
    } finally { await handle.close(); }
  } catch { return null; }
}
async function verifiedFileIdentity(client: CodexControlClient, environment: NodeJS.ProcessEnv, before: string | null): Promise<string | null> {
  // account/read exposes email and plan, which cannot identify a workspace.
  // A leftover auth.json must never identify a keyring, auto or external session.
  if (!before || ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY"].some((key) => environment[key]?.trim())) return null;
  try {
    const result = z.object({ config: z.object({ cli_auth_credentials_store: z.literal("file") }) }).safeParse(await client.request("config/read", { includeLayers: false }));
    return result.success && before === await codexAccountIdentity(environment) ? before : null;
  } catch { return null; }
}
const accountSchema = z.object({ type: z.string(), email: z.string().max(256).nullable().optional(), planType: z.string().max(200).nullable().optional() }).nullable();
export class NativeUsageReader {
  constructor(private readonly providers: ProviderManager, private readonly cwd: string, private readonly signal: AbortSignal) {}
  async read(info: ProviderInfo): Promise<UsageAccount> {
    const base: UsageAccount = { id: `native:${info.id}`, providerId: info.id, providerLabel: info.label, label: `${info.label} account`,
      email: null, plan: null, identityKey: null, sources: ["This computer"], status: "unavailable", detail: null,
      windows: usageWindows(info.rateLimits), updatedAt: info.metadataState.rateLimits.updatedAt, checkedAt: new Date().toISOString(), credits: null, canReset: false };
    if (!info.canRun) return { ...base, detail: `${info.label} is ${info.authState === "unauthenticated" ? "not signed in" : "not ready"}.` };
    if (info.id !== "codex" && info.id !== "claude") return { ...base, windows: [], status: "unsupported", detail: "This provider does not expose a supported subscription quota API." };
    if (info.id === "claude") {
      const result = await this.providers.claudeUsage(this.cwd);
      const parsed = z.object({ email: z.string().max(256).optional(), subscriptionType: z.string().max(200).optional(), apiProvider: z.string().max(50).optional() }).safeParse(result.account);
      const account = parsed.success ? parsed.data : null;
      if (account?.apiProvider && account.apiProvider !== "firstParty") return { ...base, windows: [], status: "unsupported", detail: "This Claude API backend does not report subscription limits." };
      return { ...base, email: account?.email ?? null, plan: account?.subscriptionType ?? null,
        windows: usageWindows(result.rateLimits ?? []), updatedAt: result.rateLimits ? base.checkedAt : null,
        status: result.rateLimitsUnavailable ? "unsupported" : result.rateLimits?.length ? "ready" : "unavailable",
        detail: result.rateLimitsUnavailable ? "This Claude route does not report subscription limits." : result.rateLimits?.length ? null : "Claude did not report quota windows." };
    }
    const context = await this.providers.codexControlContext(this.cwd);
    const identityBefore = await codexAccountIdentity(context.environment);
    return await withCodexControlClient({ ...context, signal: this.signal }, async (client) => {
      const account = accountSchema.parse((await client.request("account/read", { refreshToken: false })).account);
      base.email = account?.email ?? null; base.plan = account?.planType ?? null;
      if (account?.type !== "chatgpt") return { ...base, windows: [], status: "unsupported", detail: "Subscription limits require a ChatGPT account; this authentication route does not expose them." };
      base.identityKey = await verifiedFileIdentity(client, context.environment, identityBefore);
      let result: Record<string, unknown>;
      try { result = await client.request("account/rateLimits/read"); }
      catch {
        const stillCurrent = base.identityKey && identityBefore === await codexAccountIdentity(context.environment);
        return { ...base, identityKey: stillCurrent ? identityBefore : null, windows: [], status: "error", detail: "Codex quota could not be refreshed." };
      }
      const identityAfter = await codexAccountIdentity(context.environment);
      if (identityBefore !== identityAfter) throw new Error("The signed-in account changed during the read.");
      base.windows = usageWindows(parseCodexRateLimits(result));
      base.credits = nativeResetCredits(result.rateLimitResetCredits);
      base.canReset = base.identityKey !== null && (base.credits?.availableCount ?? 0) > 0;
      return { ...base, status: base.windows.length ? "ready" : "unavailable", updatedAt: base.checkedAt,
        detail: !base.identityKey ? "Account identity could not be verified from the active credential store. Quota stays separate and reset redemption is unavailable." : base.windows.length ? null : "No quota windows were reported." };
    });
  }
  async consume(confirmation: UsageResetConfirmation, expected: UsageAccount): Promise<UsageResetOutcome> {
    const context = await this.providers.codexControlContext(this.cwd);
    const identityBefore = await codexAccountIdentity(context.environment);
    return await withCodexControlClient({ ...context, signal: this.signal, timeoutMs: 10000 }, async (client) => {
      const account = accountSchema.parse((await client.request("account/read", { refreshToken: false })).account);
      const identity = await verifiedFileIdentity(client, context.environment, identityBefore);
      if (!identity || identity !== await codexAccountIdentity(context.environment) || identity !== confirmation.accountKey || identity !== expected.identityKey || account?.type !== "chatgpt" || (account.email ?? null) !== confirmation.email || (account.planType ?? null) !== confirmation.plan) throw new Error("The signed-in Codex account changed. Refresh Limits and confirm the intended account.");
      return usageResetOutcomeSchema.parse((await client.request("account/rateLimitResetCredit/consume", {
        idempotencyKey: confirmation.id, ...(confirmation.creditId ? { creditId: confirmation.creditId } : {}),
      })).outcome);
    });
  }
}
