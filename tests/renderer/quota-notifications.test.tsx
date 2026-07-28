import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ProviderQuotaNotices } from "../../src/renderer/src/components/ProviderQuotaNotices";
import {
  evaluateQuotaNotifications,
  parseQuotaNotificationState,
  serializeQuotaNotificationState,
  type PersistedQuotaNotificationState,
} from "../../src/renderer/src/utils/quotaNotifications";
import type {
  ProviderInfo,
  ProviderMetadataFreshness,
  ProviderMetadataProvenance,
  ProviderRateLimit,
} from "../../src/shared/contracts";

function limit(
  id: string,
  remainingPercent: number,
  windowMinutes: number,
  resetsAt = "2026-07-29T10:00:00.000Z",
): ProviderRateLimit {
  return {
    id,
    label: id,
    usedPercent: 100 - remainingPercent,
    remainingPercent,
    windowMinutes,
    resetsAt,
  };
}

function provider(
  id: ProviderInfo["id"],
  rateLimits: ProviderRateLimit[],
  freshness: ProviderMetadataFreshness = "fresh",
  provenance: ProviderMetadataProvenance = "provider",
): ProviderInfo {
  return {
    id,
    label: id === "claude" ? "Claude" : "Codex",
    command: id,
    available: true,
    version: "1.0.0",
    executable: `/bin/${id}`,
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [],
    rateLimits,
    metadataState: {
      models: {
        freshness: "unavailable",
        provenance: null,
        updatedAt: null,
        lastAttemptedAt: null,
        refreshing: false,
      },
      rateLimits: {
        freshness,
        provenance,
        updatedAt: "2026-07-28T10:00:00.000Z",
        lastAttemptedAt: "2026-07-28T10:00:00.000Z",
        refreshing: false,
      },
    },
  };
}

const emptyState: PersistedQuotaNotificationState = {
  version: 1,
  windows: {},
};

describe("provider quota notifications", () => {
  it("announces 25, 15, and 5 percent once within one provider window", () => {
    const first = evaluateQuotaNotifications([
      provider("codex", [limit("primary", 24, 300)]),
    ], emptyState, "2026-07-28T10:00:00.000Z");
    expect(first.notices.map(({ threshold }) => threshold)).toEqual([25]);

    const duplicate = evaluateQuotaNotifications([
      provider("codex", [limit("primary", 24, 300)]),
    ], first.state, "2026-07-28T10:01:00.000Z");
    expect(duplicate.notices).toEqual([]);

    const second = evaluateQuotaNotifications([
      provider("codex", [limit("primary", 14, 300)]),
    ], duplicate.state, "2026-07-28T10:02:00.000Z");
    expect(second.notices.map(({ threshold }) => threshold)).toEqual([15]);

    const third = evaluateQuotaNotifications([
      provider("codex", [limit("primary", 4, 300)]),
    ], second.state, "2026-07-28T10:03:00.000Z");
    expect(third.notices.map(({ threshold }) => threshold)).toEqual([5]);
    expect(evaluateQuotaNotifications([
      provider("codex", [limit("primary", 3, 300)]),
    ], third.state).notices).toEqual([]);
  });

  it("emits only the most urgent threshold when the first reading is very low", () => {
    const result = evaluateQuotaNotifications([
      provider("claude", [limit("claude:five_hour", 4, 300)]),
    ], emptyState);
    expect(result.notices).toEqual([
      expect.objectContaining({
        providerId: "claude",
        windowLabel: "5-hour",
        threshold: 5,
        remainingPercent: 4,
      }),
    ]);
  });

  it("resets deduplication when the provider reports a new reset boundary", () => {
    const first = evaluateQuotaNotifications([
      provider("codex", [limit("primary", 24, 300)]),
    ], emptyState);
    const nextWindow = evaluateQuotaNotifications([
      provider("codex", [
        limit("primary", 24, 300, "2026-07-29T15:00:00.000Z"),
      ]),
    ], first.state);
    expect(nextWindow.notices.map(({ threshold }) => threshold)).toEqual([25]);
  });

  it("isolates provider and limit identities across five-hour and weekly windows", () => {
    const result = evaluateQuotaNotifications([
      provider("codex", [
        limit("primary", 24, 300),
        limit("secondary", 14, 10_080),
      ]),
      provider("claude", [
        limit("claude:five_hour", 4, 300),
      ]),
    ], emptyState);
    expect(result.notices.map((notice) => [
      notice.providerId,
      notice.limitId,
      notice.windowLabel,
      notice.threshold,
    ])).toEqual([
      ["codex", "primary", "5-hour", 25],
      ["codex", "secondary", "weekly", 15],
      ["claude", "claude:five_hour", "5-hour", 5],
    ]);
    expect(Object.keys(result.state.windows)).toHaveLength(3);
  });

  it("never alerts from stale, cached, unavailable, or unknown windows", () => {
    const providers = [
      provider("codex", [limit("primary", 5, 300)], "stale", "provider"),
      provider("claude", [limit("weekly", 5, 10_080)], "fresh", "persistent-cache"),
      provider("cursor", [limit("daily", 5, 1_440)], "fresh", "provider"),
      provider("opencode", [limit("primary", 5, 300)], "unavailable", "provider"),
    ];
    expect(evaluateQuotaNotifications(providers, emptyState)).toEqual({
      state: emptyState,
      notices: [],
    });
  });

  it("round-trips only bounded, valid persisted state", () => {
    const result = evaluateQuotaNotifications([
      provider("codex", [limit("primary", 24, 300)]),
    ], emptyState);
    expect(parseQuotaNotificationState(
      serializeQuotaNotificationState(result.state),
    )).toEqual(result.state);
    expect(parseQuotaNotificationState("{not-json")).toEqual(emptyState);
  });

  it("renders a small provider-scoped polite notification with a dismiss action", () => {
    const evaluation = evaluateQuotaNotifications([
      provider("claude", [limit("claude:seven_day", 14, 10_080)]),
    ], emptyState);
    const html = renderToStaticMarkup(
      <ProviderQuotaNotices
        notices={evaluation.notices}
        onDismiss={() => undefined}
      />,
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Claude weekly limit");
    expect(html).toContain("14% remaining");
    expect(html).toContain("Dismiss Claude weekly quota notice");
  });
});
