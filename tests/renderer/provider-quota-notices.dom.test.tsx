import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { useProviderQuotaNotices } from "../../src/renderer/src/hooks/useProviderQuotaNotices";
import type { ProviderInfo } from "../../src/shared/contracts";
import type { QuotaWarningSettings } from "../../src/shared/quota-warnings";

function codex(remainingPercent: number): ProviderInfo {
  return {
    id: "codex",
    label: "Codex",
    command: "codex",
    available: true,
    version: "1.0.0",
    executable: "/bin/codex",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [],
    rateLimits: [{
      id: "primary",
      label: "primary",
      usedPercent: 100 - remainingPercent,
      remainingPercent,
      windowMinutes: 300,
      resetsAt: "2026-07-29T10:00:00.000Z",
    }],
    metadataState: {
      models: { freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null, refreshing: false },
      rateLimits: {
        freshness: "fresh",
        provenance: "provider",
        updatedAt: "2026-07-28T10:00:00.000Z",
        lastAttemptedAt: "2026-07-28T10:00:00.000Z",
        refreshing: false,
      },
    },
  };
}

afterEach(() => {
  window.localStorage.clear();
});

describe("provider quota notices", () => {
  it("follows the quota warning settings and clears visible notices when warnings turn off", () => {
    const hook = renderHook(
      ({ providers, warnings }: { providers: ProviderInfo[]; warnings: QuotaWarningSettings }) =>
        useProviderQuotaNotices(providers, warnings),
      { initialProps: { providers: [codex(24)], warnings: { enabled: true, firstThreshold: 15 } } },
    );
    expect(hook.result.current.notices).toEqual([]);

    hook.rerender({ providers: [codex(14)], warnings: { enabled: true, firstThreshold: 15 } });
    expect(hook.result.current.notices.map(({ threshold }) => threshold)).toEqual([15]);

    act(() => hook.rerender({ providers: [codex(14)], warnings: { enabled: false, firstThreshold: 15 } }));
    expect(hook.result.current.notices).toEqual([]);

    hook.rerender({ providers: [codex(4)], warnings: { enabled: false, firstThreshold: 15 } });
    expect(hook.result.current.notices).toEqual([]);
  });
});
