import type { UsageAccount, UsageWindow } from "./provider-usage-limits";

/** Provider-issued identity only. An email can describe several organizations. */
export function deduplicateUsageAccounts(accounts: UsageAccount[]): UsageAccount[] {
  const result = new Map<string, UsageAccount>();
  for (const account of accounts) {
    const key = account.identityKey ? `${account.providerId}:${account.identityKey}` : account.id;
    const prior = result.get(key);
    if (!prior) { result.set(key, account); continue; }
    const preferred = account.pendingReset !== prior.pendingReset && (account.pendingReset || prior.pendingReset)
      ? account.pendingReset ? account : prior
      : account.status === "ready" && prior.status !== "ready"
      || account.status === prior.status && Date.parse(account.updatedAt ?? "") > Date.parse(prior.updatedAt ?? "")
      ? account : prior;
    result.set(key, { ...preferred, sources: [...new Set([...prior.sources, ...account.sources])] });
  }
  return [...result.values()];
}
export interface UsagePool {
  key: string; label: string; plan: string | null;
  entries: Array<{ account: UsageAccount; window: UsageWindow }>;
  averageRemaining: number | null;
}
export function usagePools(accounts: UsageAccount[]): UsagePool[] {
  const groups = new Map<string, UsagePool>();
  for (const account of deduplicateUsageAccounts(accounts)) {
    for (const window of account.windows) {
      // Unknown durations, scopes, plans or account identities cannot prove equivalence.
      const equivalent = account.identityKey && account.plan && window.windowMinutes;
      const key = JSON.stringify([account.providerId, account.plan, window.id, window.label, window.windowMinutes, equivalent ? null : account.id]);
      const group = groups.get(key) ?? { key, label: window.label, plan: account.plan, entries: [], averageRemaining: null };
      group.entries.push({ account, window }); groups.set(key, group);
    }
  }
  for (const group of groups.values()) {
    // Do not turn partial availability into an apparently complete pool.
    if (group.entries.every(({ window }) => window.remainingPercent !== null)) {
      group.averageRemaining = group.entries.reduce((sum, { window }) => sum + window.remainingPercent!, 0) / group.entries.length;
    }
  }
  return [...groups.values()];
}
