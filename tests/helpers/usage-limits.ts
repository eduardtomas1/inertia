import type { UsageAccount } from "../../src/shared/provider-usage-limits";
export function usageAccount(update: Partial<UsageAccount> = {}): UsageAccount {
  const now = new Date().toISOString();
  return { id: "native:codex", providerId: "codex", providerLabel: "Codex", label: "Codex account", email: "fixture@example.test", plan: "pro", identityKey: "account-a", sources: ["This computer"], status: "ready", detail: null, updatedAt: now, checkedAt: now,
    windows: [{ id: "codex:primary", label: "Codex usage", remainingPercent: 60, windowMinutes: 300, resetsAt: new Date(Date.now() + 7200000).toISOString() }],
    credits: { availableCount: 2, nextCreditId: "test-credit-a", expiresAt: null }, canReset: true, ...update };
}
