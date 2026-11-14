import { describe, expect, it } from "vitest";

import { limitSections } from "../../src/renderer/src/components/usage/limitPools";
import { accountMatchesSource, usageProviderOptions } from "../../src/renderer/src/components/usage/usageFilters";
import type { UsageAccount } from "../../src/shared/provider-usage-limits";
import { usageAccount } from "../helpers/usage-limits";

const NOW = Date.parse("2026-11-11T10:00:00.000Z");
const HOUR = 3_600_000;
const at = (offset: number): string => new Date(NOW + offset).toISOString();
const window = (id: string, label: string, remainingPercent: number | null, windowMinutes: number | null, resetsAt: string | null) => (
  { id, label, remainingPercent, windowMinutes, resetsAt }
);
const codexWindows = (session: number, weekly: number) => [
  window("codex:secondary", "Weekly", weekly, 10_080, at(48 * HOUR)),
  window("codex:primary", "Session", session, 300, at(2 * HOUR)),
];
const codex = (update: Partial<UsageAccount> = {}): UsageAccount => usageAccount({ updatedAt: at(0), checkedAt: at(0), windows: codexWindows(64, 20), ...update });
const hub = (update: Partial<UsageAccount> = {}): UsageAccount => codex({ id: "hub:1:second", identityKey: "account-b", sources: ["Home hub"], credits: null, canReset: false, ...update });

describe("limit sections", () => {
  it("makes one section per provider in first-seen order with session cards before weekly ones", () => {
    const claude = usageAccount({ id: "native:claude", providerId: "claude", providerLabel: "Claude", label: "Claude account", identityKey: "claude-a", plan: "max", credits: null, canReset: false,
      windows: [
        window("claude:five_hour", "Session", 90, 300, at(HOUR)),
        window("claude:seven_day", "Weekly", 84, 10_080, at(78 * HOUR)),
        window("claude:seven_day_overage_included", "Weekly · Fable", 68, 10_080, at(78 * HOUR)),
        window("claude:overage", "Extra usage", 100, null, null),
      ] });
    const sections = limitSections([codex(), claude], NOW);
    expect(sections.map(({ providerLabel }) => providerLabel)).toEqual(["Codex", "Claude"]);
    expect(sections[0]!.cards.map(({ label }) => label)).toEqual(["Session", "Weekly"]);
    expect(sections[1]!.cards.map(({ label }) => label)).toEqual(["Session", "Weekly", "Weekly · Fable", "Extra usage"]);
    expect(sections[1]!.cards.map(({ remaining, pace }) => [remaining, pace])).toEqual([[90, "under"], [84, "under"], [68, "under"], [100, null]]);
  });

  it("gives equivalent accounts one segment each and averages them without weighting", () => {
    const [section] = limitSections([codex(), hub({ windows: codexWindows(90, 40) })], NOW);
    const [session, weekly] = section!.cards;
    expect(session!.columns.map((segment) => segment?.number)).toEqual([1, 2]);
    expect(session!.columns.map((segment) => segment?.reading.remaining)).toEqual([64, 90]);
    expect(session!.remaining).toBe(77);
    expect(weekly!.remaining).toBe(30);
    expect(session!.columns.map((segment) => segment?.credits)).toEqual([2, 0]);
    expect(session!.nextRestore).toBe(18);
    expect(weekly!.nextRestore).toBe(40);
  });

  it("keeps an account in its own column when it lacks a window the others report", () => {
    const partial = hub({ windows: [window("codex:primary", "Session", 90, 300, at(2 * HOUR))] });
    const [section] = limitSections([codex(), partial], NOW);
    const weekly = section!.cards.find(({ label }) => label === "Weekly")!;
    expect(weekly.columns.map((segment) => segment?.number ?? null)).toEqual([1, null]);
    expect(weekly.segments).toHaveLength(1);
    expect(weekly.remaining).toBe(20);
  });

  it("does not pool accounts whose equivalence is unproven and names their cards by plan", () => {
    const [section] = limitSections([codex(), hub({ plan: "plus" }), hub({ id: "hub:1:third", identityKey: null })], NOW);
    expect(section!.cards.map(({ label, columns }) => [label, columns.length])).toEqual([
      ["Session · pro", 1], ["Session · plus", 1], ["Session · pro", 1],
      ["Weekly · pro", 1], ["Weekly · plus", 1], ["Weekly · pro", 1],
    ]);
    expect(section!.cards.every(({ nextRestore }) => nextRestore === null)).toBe(true);
  });

  it("never turns an unknown measurement into a number, and reports a passed reset as due", () => {
    const unknown = hub({ windows: [window("codex:primary", "Session", null, 300, at(2 * HOUR)), window("codex:secondary", "Weekly", 40, 10_080, at(-HOUR))] });
    const [section] = limitSections([codex(), unknown], NOW);
    const [session, weekly] = section!.cards;
    expect(session!.remaining).toBeNull();
    expect(session!.due).toBe(false);
    expect(weekly!.remaining).toBe(20);
    expect(weekly!.columns.map((segment) => segment?.reading.due)).toEqual([false, true]);
    const [alone] = limitSections([codex({ windows: [window("codex:primary", "Session", 12, 300, at(-HOUR))] })], NOW);
    expect(alone!.cards[0]).toMatchObject({ due: true, remaining: null, pace: null });
  });

  it("carries the exhausted weekly limit into the session card", () => {
    const [section] = limitSections([codex({ windows: codexWindows(58, 0) })], NOW);
    expect(section!.cards[0]).toMatchObject({ label: "Session", remaining: 0, pace: null });
    expect(section!.cards[0]!.segments[0]!.reading.resetsAt).toBe(at(48 * HOUR));
    expect(section!.cards[1]).toMatchObject({ label: "Weekly", remaining: 0, pace: "ahead" });
  });

  it("lists accounts without windows apart, and keeps custom routes under their own name", () => {
    const cursor = usageAccount({ id: "native:cursor", providerId: "cursor", providerLabel: "Cursor", identityKey: null, status: "unavailable", detail: "Usage is not reported by this agent.", windows: [], credits: null, canReset: false });
    const profile = (id: string, label: string): UsageAccount => usageAccount({ id: `profile:${id}`, providerId: "custom", providerLabel: label, label, identityKey: null, plan: null, status: "unavailable", detail: "Usage and limits are not available for API keys.", windows: [], credits: null, canReset: false, sources: ["Configured route"] });
    const sections = limitSections([cursor, profile("a", "Work key"), profile("b", "Home gateway")], NOW);
    expect(sections.map(({ providerLabel, cards, unreported }) => [providerLabel, cards.length, unreported.length])).toEqual([
      ["Cursor", 0, 1], ["Work key", 0, 1], ["Home gateway", 0, 1],
    ]);
  });

  it("merges the copies of one account and marks stale segments", () => {
    const copy = hub({ identityKey: "account-a", status: "stale", updatedAt: at(-HOUR) });
    const [section] = limitSections([codex(), copy], NOW);
    expect(section!.accounts).toHaveLength(1);
    expect(section!.accounts[0]!.sources).toEqual(["This computer", "Home hub"]);
    expect(section!.cards[0]!.stale).toBe(false);
    const [stale] = limitSections([codex({ status: "stale" })], NOW);
    expect(stale!.cards[0]!.stale).toBe(true);
  });
});

describe("usage filters", () => {
  const sources = [{ id: "1", label: "Home hub", url: "https://hub.example.test", enabled: true, error: null }];

  it("matches accounts to this computer or to the hub that reported them", () => {
    const merged = codex({ sources: ["This computer", "Home hub"] });
    expect(accountMatchesSource(codex(), "all", sources)).toBe(true);
    expect(accountMatchesSource(codex(), "local", sources)).toBe(true);
    expect(accountMatchesSource(codex(), "1", sources)).toBe(false);
    expect(accountMatchesSource(hub(), "local", sources)).toBe(false);
    expect(accountMatchesSource(hub(), "1", sources)).toBe(true);
    expect(accountMatchesSource(merged, "local", sources)).toBe(true);
    expect(accountMatchesSource(merged, "1", sources)).toBe(true);
  });

  it("offers every known provider and adds custom backends once", () => {
    const profile = usageAccount({ id: "profile:a", providerId: "custom", providerLabel: "Work key" });
    expect(usageProviderOptions(null).map(({ label }) => label)).toEqual(["Codex", "Claude", "Cursor", "Kimi Code", "OpenCode", "Antigravity", "Grok"]);
    expect(usageProviderOptions({ accounts: [codex(), profile, profile], sources: [], checkedAt: null }).at(-1)).toEqual({ id: "custom", label: "Custom backends" });
  });
});
