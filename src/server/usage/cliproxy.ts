import { z } from "zod";
import { usageSourceOrigin, type UsageAccount, type UsageSource, type UsageResetOutcome } from "../../shared/provider-usage-limits";
import { createHash } from "node:crypto";
import { providerTimestamp } from "../provider/usage-values";
import { parseCodexRateLimits } from "../codex-metadata";
import { parseClaudeRateLimits } from "../provider/claude-agent-sdk-metadata";

const text = z.string().min(1).max(256);
const authSchema = z.object({ id: text, auth_index: text, provider: z.string().min(1).max(200), email: text.optional(), disabled: z.boolean().optional(),
  id_token: z.object({ chatgpt_account_id: text.optional(), chatgpt_plan_type: z.string().min(1).max(200).optional() }).optional() });
type HubAuth = z.infer<typeof authSchema>;
export const opaqueUsageIdentity = (provider: string, id: string): string => createHash("sha256").update(`${provider}\0${id}`).digest("hex");
const CODEX_BASE = "https://chatgpt.com/backend-api/wham";
const CREDIT_URL = `${CODEX_BASE}/rate-limit-reset-credits`;
const MAX_RESPONSE_BYTES = 1024 * 1024;
export const usageWindows = (limits: ReturnType<typeof parseCodexRateLimits>): UsageAccount["windows"] => limits.map(({ id, label, remainingPercent, windowMinutes, resetsAt }) => {
  const duration = windowMinutes && Number.isFinite(windowMinutes) && windowMinutes > 0 && windowMinutes <= 525600 ? windowMinutes : null;
  const title = id.startsWith("codex:") && duration
    ? duration === 10080 ? "Weekly" : duration % 60 === 0 ? `${duration / 60}-hour window` : `${duration}-minute window`
    : label;
  return { id: id.slice(0, 256), label: title.slice(0, 200), remainingPercent, windowMinutes: duration, resetsAt };
});

/** Only fixed management paths and provider URLs cross this privileged boundary. */
export class CliproxyUsageClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}
  private async management(source: UsageSource, key: string, path: "auth-files" | "api-call" | "reset-quota", signal: AbortSignal, body?: unknown): Promise<unknown> {
    const origin = usageSourceOrigin(source.url);
    if (!origin) throw new Error("The hub URL is invalid.");
    try {
      const response = await this.fetcher(`${origin}/v0/management/${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(); }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) throw new Error();
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { throw new Error("The hub management request failed. Check its address and management key."); }
  }
  async accounts(source: UsageSource, key: string, signal: AbortSignal): Promise<HubAuth[]> {
    const raw = await this.management(source, key, "auth-files", signal);
    const parsed = z.object({ files: z.array(authSchema).max(32) }).safeParse(raw);
    if (!parsed.success) throw new Error("The hub account list is invalid or exceeds 32 accounts.");
    if (new Set(parsed.data.files.map(({ id }) => id)).size !== parsed.data.files.length) throw new Error("The hub returned duplicate account IDs.");
    return parsed.data.files;
  }
  private async api(source: UsageSource, key: string, account: HubAuth, url: string, signal: AbortSignal, data?: unknown): Promise<unknown> {
    const raw = await this.management(source, key, "api-call", signal, {
      auth_index: account.auth_index, method: data === undefined ? "GET" : "POST", url,
      header: { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json",
        ...(account.provider === "codex" ? { "OpenAI-Beta": "codex-1", Originator: "Codex Desktop",
          ...(account.id_token?.chatgpt_account_id ? { "Chatgpt-Account-Id": account.id_token.chatgpt_account_id } : {}) }
          : { "anthropic-beta": "oauth-2025-04-20" }) },
      ...(data === undefined ? {} : { data: JSON.stringify(data) }),
    });
    const response = z.object({ status_code: z.number().int().min(200).max(299), body: z.string().max(MAX_RESPONSE_BYTES) }).safeParse(raw);
    if (!response.success) throw new Error("The provider refused the hub usage request.");
    try { return JSON.parse(response.data.body); } catch { throw new Error("The provider returned invalid usage data."); }
  }
  async read(source: UsageSource, key: string, auth: HubAuth, signal: AbortSignal): Promise<UsageAccount> {
    const now = new Date().toISOString();
    const supported = auth.provider === "codex" || auth.provider === "claude";
    const base: UsageAccount = {
      id: `hub:${source.id}:${opaqueUsageIdentity(auth.provider, auth.id)}`, providerId: auth.provider,
      providerLabel: auth.provider === "codex" ? "Codex" : auth.provider === "claude" ? "Claude" : auth.provider,
      label: `${auth.provider === "codex" ? "Codex" : auth.provider === "claude" ? "Claude" : "Provider"} account`,
      email: auth.email ?? null, plan: auth.id_token?.chatgpt_plan_type ?? null,
      identityKey: auth.provider === "codex" && auth.id_token?.chatgpt_account_id ? opaqueUsageIdentity("codex", auth.id_token.chatgpt_account_id) : null,
      sources: [source.label], status: auth.disabled ? "disabled" : supported ? "ready" : "unsupported",
      detail: auth.disabled ? "This account is disabled in the hub." : supported ? null : "This provider does not have a supported hub quota API.",
      updatedAt: null, checkedAt: now, windows: [], credits: null, canReset: false,
    };
    if (auth.disabled || !supported) return base;
    try {
      if (auth.provider === "claude") {
        const raw = await this.api(source, key, auth, "https://api.anthropic.com/api/oauth/usage", signal);
        const body = z.record(z.string(), z.unknown()).parse(raw);
        const scoped = z.array(z.object({ kind: z.string(), percent: z.number().min(0).max(100).nullable().optional(), resets_at: z.string().nullable().optional(), scope: z.object({ model: z.object({ display_name: text }).nullable().optional() }).nullable().optional() })).max(32).safeParse(body.limits ?? []);
        const model_scoped = scoped.success ? scoped.data.filter((limit) => limit.kind === "weekly_scoped" && limit.scope?.model && typeof limit.percent === "number").map((limit) => ({ display_name: limit.scope!.model!.display_name, utilization: limit.percent, resets_at: limit.resets_at ?? null })) : [];
        base.windows = usageWindows(parseClaudeRateLimits({ rate_limits_available: true, rate_limits: { ...body, model_scoped } }));
      } else {
        const window = z.object({ used_percent: z.number().min(0).max(100), reset_at: z.number().nullable().optional(), limit_window_seconds: z.number().positive().max(31536000).optional() }).nullable().optional();
        const body = z.object({ plan_type: z.string().min(1).max(200).optional(), rate_limit: z.object({ primary_window: window, secondary_window: window }).nullable() }).parse(await this.api(source, key, auth, `${CODEX_BASE}/usage`, signal));
        const convert = (value: z.infer<typeof window>) => value ? { usedPercent: value.used_percent, resetsAt: value.reset_at, windowDurationMins: value.limit_window_seconds === undefined ? undefined : value.limit_window_seconds / 60 } : null;
        base.plan = body.plan_type ?? base.plan;
        base.windows = usageWindows(parseCodexRateLimits({ rateLimits: { limitId: "codex", primary: convert(body.rate_limit?.primary_window), secondary: convert(body.rate_limit?.secondary_window) } }));
        try {
          const credits = z.object({ credits: z.array(z.object({ id: text, status: text, reset_type: text, expires_at: z.iso.datetime({ offset: true }) })).max(256) }).parse(await this.api(source, key, auth, CREDIT_URL, signal)).credits
            .filter((credit) => credit.status === "available" && credit.reset_type === "codex_rate_limits" && Date.parse(credit.expires_at) > Date.now())
            .sort((a,b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
          base.credits = { availableCount: credits.length, nextCreditId: credits[0]?.id ?? null, expiresAt: credits[0] ? new Date(credits[0].expires_at).toISOString() : null };
          base.canReset = credits.length > 0 && base.identityKey !== null;
        } catch { base.detail = "Quota loaded; reset credits are unavailable."; }
      }
      base.updatedAt = now;
      if (base.windows.length === 0) { base.status = "unavailable"; base.detail = "No quota windows were reported. API-key accounts may not expose subscription limits."; }
      return base;
    } catch { return { ...base, status: "error", detail: "The hub could not read this account's usage." }; }
  }
  async consume(source: UsageSource, key: string, auth: HubAuth, creditId: string, idempotencyKey: string, signal: AbortSignal): Promise<UsageResetOutcome> {
    const body = z.object({ code: z.enum(["reset", "already_redeemed", "nothing_to_reset", "no_credit"]) }).parse(
      await this.api(source, key, auth, `${CREDIT_URL}/consume`, signal, { credit_id: creditId, redeem_request_id: idempotencyKey }));
    return { reset: "reset", already_redeemed: "alreadyRedeemed", nothing_to_reset: "nothingToReset", no_credit: "noCredit" }[body.code] as UsageResetOutcome;
  }
}

export function nativeResetCredits(value: unknown): UsageAccount["credits"] {
  const parsed = z.object({ availableCount: z.number().int().min(0).max(100000), credits: z.array(z.object({ id: text, status: text, resetType: text, expiresAt: z.number().nullable() })).max(256).nullable().optional() }).safeParse(value);
  if (!parsed.success) return null;
  const next = parsed.data.credits?.filter((credit) => credit.status === "available" && credit.resetType === "codexRateLimits" && (credit.expiresAt === null || credit.expiresAt * 1000 > Date.now()))
    .sort((a,b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity))[0];
  return { availableCount: parsed.data.availableCount, nextCreditId: next?.id ?? null, expiresAt: providerTimestamp(next?.expiresAt) };
}
