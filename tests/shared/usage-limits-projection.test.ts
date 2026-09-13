import { describe, expect, it } from "vitest";
import { deduplicateUsageAccounts, usagePools } from "../../src/shared/usage-limits-projection";
import { usageAccount } from "../helpers/usage-limits";

describe("usage account pooling", () => {
  it("counts a provider account visible locally and at a hub once and retains both sources", () => {
    const local = usageAccount();
    const hub = usageAccount({ id: "hub:a", sources: ["Home hub"], status: "stale" });
    expect(deduplicateUsageAccounts([local, hub])).toEqual([{ ...local, sources: ["This computer", "Home hub"] }]);
    expect(usagePools([local, hub])[0]?.entries).toHaveLength(1);
  });
  it("does not equate emails, unknown identities, plans, scopes or durations", () => {
    const account = usageAccount();
    const variants = [usageAccount({ id: "b", identityKey: null }), usageAccount({ id: "c", identityKey: "c", plan: "plus" }),
      usageAccount({ id: "d", identityKey: "d", windows: [{ ...account.windows[0]!, id: "codex:secondary" }] }),
      usageAccount({ id: "e", identityKey: "e", windows: [{ ...account.windows[0]!, windowMinutes: null }] })];
    expect(usagePools([account, ...variants])).toHaveLength(5);
  });
  it("keeps missing observations unavailable and averages equivalent accounts with known values", () => {
    const a = usageAccount();
    const b = usageAccount({ id: "b", identityKey: "b", windows: [{ ...a.windows[0]!, remainingPercent: 20 }] });
    expect(usagePools([a, b])[0]?.averageRemaining).toBe(40);
    b.windows[0]!.remainingPercent = null;
    expect(usagePools([a, b])[0]?.averageRemaining).toBeNull();
    b.windows = [];
    expect(usagePools([a, b])[0]?.entries).toHaveLength(1);
  });
});
