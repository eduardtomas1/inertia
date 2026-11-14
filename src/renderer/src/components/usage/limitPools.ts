import type { UsageAccount, UsageWindow } from "@shared/provider-usage-limits";
import { deduplicateUsageAccounts, usagePools } from "@shared/usage-limits-projection";

import {
  elapsedShare,
  limitCountdown,
  limitReadings,
  limitResetTime,
  limitWindowKind,
  paceOfShares,
  type LimitCountdown,
  type LimitPace,
  type LimitReading,
} from "./limitMath";

export interface LimitSegment {
  account: UsageAccount;
  number: number;
  window: UsageWindow;
  reading: LimitReading;
  countdown: LimitCountdown;
  credits: number;
  stale: boolean;
}

export interface LimitCard {
  key: string;
  label: string;
  remaining: number | null;
  due: boolean;
  pace: LimitPace | null;
  columns: Array<LimitSegment | null>;
  segments: LimitSegment[];
  nextRestore: number | null;
  stale: boolean;
}

export interface LimitSection {
  providerId: string;
  providerLabel: string;
  accounts: UsageAccount[];
  cards: LimitCard[];
  unreported: UsageAccount[];
}

function poolable(account: UsageAccount): boolean {
  return Boolean(account.identityKey && account.plan);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function providerSection(accounts: UsageAccount[], now: number): LimitSection {
  const numbers = new Map(accounts.map((account, index) => [account.id, index + 1]));
  const readings = new Map(accounts.map((account) => [
    account.id,
    limitReadings(account.windows, now, account.checkedAt),
  ]));
  const pools = usagePools(accounts);
  const cards = pools.map((pool, order): LimitCard & { order: number; kind: number } => {
    const segmentOf = ({ account, window }: { account: UsageAccount; window: UsageWindow }): LimitSegment => {
      const reading = readings.get(account.id)![account.windows.indexOf(window)]!;
      return {
        account,
        number: numbers.get(account.id)!,
        window,
        reading,
        countdown: limitCountdown(reading.resetsAt, now),
        credits: account.credits?.availableCount ?? 0,
        stale: account.status === "stale",
      };
    };
    const segments = pool.entries.map(segmentOf);
    const pooled = pool.entries.every(({ account, window }) => poolable(account) && window.windowMinutes);
    const candidates = pooled
      ? accounts.filter((account) => poolable(account) && account.plan === pool.plan)
      : pool.entries.map(({ account }) => account);
    const columns = candidates.map((account) => segments.find((segment) => segment.account === account) ?? null);
    const live = segments.filter(({ reading }) => !reading.due);
    const known = live.every(({ reading }) => reading.used !== null);
    const used = live.length > 0 && known ? mean(live.map(({ reading }) => reading.used!)) : null;
    const timed = live.flatMap(({ reading }) => {
      const elapsed = elapsedShare(reading, now);
      return elapsed === null || reading.used === null ? [] : [{ used: reading.used, elapsed }];
    });
    const restores = segments
      .flatMap(({ reading }) => {
        const at = limitResetTime(reading.resetsAt);
        return at === null || reading.due ? [] : [{ at, percent: Math.round(reading.restore / segments.length) }];
      })
      .sort((left, right) => left.at - right.at);
    const shared = pool.plan && pools.some((other) => other !== pool && other.label === pool.label);
    return {
      key: pool.key,
      label: shared ? `${pool.label} · ${pool.plan}` : pool.label,
      remaining: used === null ? null : Math.round(100 - used),
      due: segments.length > 0 && live.length === 0,
      pace: timed.length > 0
        ? paceOfShares(mean(timed.map((entry) => entry.used)), mean(timed.map((entry) => entry.elapsed)))
        : null,
      columns,
      segments,
      nextRestore: columns.length > 1 ? restores.find(({ percent }) => percent > 0)?.percent ?? null : null,
      stale: segments.some(({ stale }) => stale),
      order,
      kind: limitWindowKind(pool.entries[0]?.window.windowMinutes ?? null),
    };
  });
  cards.sort((left, right) => left.kind - right.kind || left.order - right.order);
  return {
    providerId: accounts[0]!.providerId,
    providerLabel: accounts[0]!.providerLabel,
    accounts,
    cards,
    unreported: accounts.filter((account) => account.windows.length === 0),
  };
}

function sectionKey({ providerId, providerLabel }: UsageAccount): string {
  return providerId === "custom" ? `custom\0${providerLabel}` : providerId;
}

export function limitSections(accounts: readonly UsageAccount[], now: number): LimitSection[] {
  const unique = deduplicateUsageAccounts([...accounts]);
  return [...new Set(unique.map(sectionKey))].map((key) => providerSection(
    unique.filter((account) => sectionKey(account) === key),
    now,
  ));
}
