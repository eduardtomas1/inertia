import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type {
  ProviderMetadataFieldState,
  ProviderRateLimit,
  ThreadUsageSnapshot,
  UsageDisplayMode,
} from "../../src/shared/contracts";
import {
  contextUsageDisplayValue,
  type ContextUsageDataQuality,
  usageQuotaSourceForSelection,
} from "../../src/renderer/src/utils/usageDisplay";
import {
  CONTEXT_NEAR_LIMIT_REMAINING_PERCENT,
  contextRemaining,
  contextRingState,
  contextTriggerSummary,
  displayPercent,
  UsageIndicator,
} from "../../src/renderer/src/components/UsageIndicator";

const freshState: ProviderMetadataFieldState = {
  freshness: "fresh",
  provenance: "provider",
  updatedAt: "2026-07-22T10:00:00.000Z",
  lastAttemptedAt: "2026-07-22T10:00:00.000Z",
  refreshing: false,
};

function usage(update: Partial<ThreadUsageSnapshot> = {}): ThreadUsageSnapshot {
  return {
    conversationId: "conversation",
    turnId: null,
    usedTokens: 50,
    totalProcessedTokens: 500,
    totalProcessedScope: "thread",
    maxTokens: 100,
    inputTokens: 40,
    cachedInputTokens: 10,
    cacheWriteInputTokens: null,
    outputTokens: 10,
    reasoningOutputTokens: 2,
    compactsAutomatically: null,
    updatedAt: "2026-07-22T10:00:00.000Z",
    ...update,
  };
}

function render(
  snapshot: ThreadUsageSnapshot | null,
  rateLimits: ProviderRateLimit[],
  rateLimitState: ProviderMetadataFieldState,
  mode: UsageDisplayMode = "expanded",
  options: {
    contextQuality?: ContextUsageDataQuality;
    providerLabel?: string;
    quotaSource?: "selected-route" | "isolated";
  } = {},
): string {
  return renderToStaticMarkup(createElement(UsageIndicator, {
    usage: snapshot,
    rateLimits,
    rateLimitState,
    quotaSource: options.quotaSource ?? "selected-route",
    mode,
    providerLabel: options.providerLabel ?? "Codex · Native · GPT-5",
    contextQuality: options.contextQuality,
    onModeChange: () => undefined,
  }));
}

describe("UsageIndicator", () => {
  it("never falls back from a missing custom profile to native account quota", () => {
    expect(usageQuotaSourceForSelection({
      backendProfileId: "custom:deleted",
    }, undefined)).toBe("isolated");
    expect(usageQuotaSourceForSelection({
      backendProfileId: "builtin:anthropic",
    }, undefined)).toBe("selected-route");
    expect(usageQuotaSourceForSelection({
      backendProfileId: "builtin:anthropic",
    }, {
      id: "custom:mismatched",
      preset: "custom",
    })).toBe("isolated");
    expect(usageQuotaSourceForSelection({
      backendProfileId: "builtin:anthropic",
    }, {
      id: "builtin:anthropic",
      preset: "native",
    })).toBe("selected-route");
  });

  it("renders task-30 circle surfaces as an anchored, closed disclosure", () => {
    const compact = render(usage(), [], freshState, "compact");
    const expanded = render(usage(), [], freshState, "expanded");
    const controls = compact.match(/aria-controls="([^"]+)"/u)?.[1];

    expect(compact).toContain('data-mode="compact"');
    expect(compact).toContain('data-composer-control="usage"');
    expect(compact).toContain('aria-haspopup="dialog"');
    expect(compact).toContain('aria-expanded="false"');
    expect(compact).toContain('data-context-state="current"');
    expect(compact).toContain('data-context-ring-state="current"');
    expect(compact).toContain('title="Context window 50% remaining."');
    expect(compact).toContain('aria-label="Open usage and context. Context window 50% remaining."');
    expect(compact).toContain('class="usage-context-ring-value"');
    expect(compact).toContain('stroke-dasharray="50 50"');
    expect(compact).not.toContain("usage-trigger-value");
    expect(compact).not.toContain("spinner");
    expect(controls).toBeTruthy();
    expect(compact).toContain(`id="${controls}"`);
    expect(compact).toContain('role="dialog"');
    expect(compact).toContain('hidden=""');

    expect(expanded).toContain('data-mode="expanded"');
    expect(expanded).toContain('class="usage-trigger-value"');
    expect(expanded).toContain(">50%</span>");
    expect(render(usage(), [], freshState, "hidden")).toBe("");
  });

  it("keeps the anchored popover width and height bounded", () => {
    const css = readFileSync(new URL("../../src/renderer/src/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(
      /\.usage-popover\s*\{[^}]*width:\s*min\(320px,\s*calc\(100vw\s*-\s*24px\)\)[^}]*max-width:\s*calc\(100vw\s*-\s*24px\)[^}]*max-height:\s*min\(460px,\s*calc\(100vh\s*-\s*72px\)\)/su,
    );
    expect(css).toMatch(/\.usage-popover\s*\{[^}]*position:\s*absolute[^}]*right:\s*0[^}]*bottom:\s*calc\(100%\s*\+\s*8px\)/su);
    expect(css).toMatch(/\.composer-usage\s*\{[^}]*flex:\s*0 0 auto[^}]*align-self:\s*center/su);
    expect(css).not.toMatch(/\.composer-usage\s*\{[^}]*width:/su);
    expect(css).not.toContain(".usage-panel");
    expect(css).not.toContain(".usage-expanded-content");
    expect(css).not.toContain(".usage-compact-main");
  });

  it("retains conservative context handling", () => {
    expect(contextRemaining(usage())).toBe(50);
    expect(contextRemaining(usage({ maxTokens: 0 }))).toBeNull();
    expect(contextRemaining(usage({ usedTokens: null, maxTokens: 200_000 }))).toBeNull();
    expect(contextRemaining(usage({ usedTokens: 200_001, maxTokens: 200_000 }))).toBeNull();
    expect(contextRemaining(usage({ usedTokens: -1, maxTokens: 200_000 }))).toBeNull();
  });

  it("distinguishes current, stale, near-limit, and unavailable context honestly", () => {
    const current = contextUsageDisplayValue({ usedTokens: 50, maxTokens: 100 }, "current");
    const stale = contextUsageDisplayValue({ usedTokens: 50, maxTokens: 100 }, "stale");
    const nearLimit = contextUsageDisplayValue({ usedTokens: 85, maxTokens: 100 }, "current");
    const staleNearLimit = contextUsageDisplayValue({ usedTokens: 85, maxTokens: 100 }, "stale");
    const unavailable = contextUsageDisplayValue(null, "unavailable");

    expect(CONTEXT_NEAR_LIMIT_REMAINING_PERCENT).toBe(20);
    expect(contextRingState(current)).toBe("current");
    expect(contextRingState(stale)).toBe("stale");
    expect(contextRingState(nearLimit)).toBe("near-limit");
    expect(contextRingState(staleNearLimit)).toBe("near-limit");
    expect(contextRingState(unavailable)).toBe("unavailable");
    expect(contextTriggerSummary(current, false)).toBe("Context window 50% remaining.");
    expect(contextTriggerSummary(stale, false)).toBe("Context window 50% remaining, stale.");
    expect(contextTriggerSummary(nearLimit, false)).toBe("Context window 15% remaining, near limit.");
    expect(contextTriggerSummary(staleNearLimit, false)).toBe("Context window 15% remaining, stale and near limit.");
    expect(contextTriggerSummary(unavailable, false)).toBe("Context window unavailable.");
  });

  it("renders a calm near-limit ring without borrowing quota semantics", () => {
    const html = render(
      usage({ usedTokens: 85, maxTokens: 100 }),
      [{
        id: "weekly",
        label: "Weekly quota",
        usedPercent: 5,
        remainingPercent: 95,
        windowMinutes: 10_080,
        resetsAt: null,
      }],
      freshState,
      "expanded",
    );

    expect(html).toContain('data-context-state="near-limit"');
    expect(html).toContain('data-context-ring-state="near-limit"');
    expect(html).toContain('stroke-dasharray="15 85"');
    expect(html).toContain('title="Context window 15% remaining, near limit."');
    expect(html).toContain("15%");
    expect(html).toContain("95% left");
    expect(html).not.toContain('title="Context window 95%');
  });

  it("keeps provider quota refresh separate from unavailable context", () => {
    const html = render(
      null,
      [],
      {
        ...freshState,
        freshness: "unavailable",
        provenance: null,
        updatedAt: null,
        refreshing: true,
      },
      "compact",
    );

    expect(html).toContain('data-context-state="unavailable"');
    expect(html).toContain('data-quota-refreshing="true"');
    expect(html).toContain("usage-quota-refresh-indicator");
    expect(html).toContain('title="Context window unavailable. Provider quota refreshing."');
    expect(html).toContain('aria-label="Open usage and context. Context window unavailable. Provider quota refreshing."');
    expect(html).not.toContain('data-context-ring-state="refreshing"');
  });

  it("uses semantic, scale-aware ring styling with no idle spinner motion", () => {
    const css = readFileSync(new URL("../../src/renderer/src/styles.css", import.meta.url), "utf8");
    const ringBlock = css.match(/\.usage-context-ring\s*\{(?<body>[^}]*)\}/su)?.groups?.body ?? "";
    const refreshBlock = css.match(/\.usage-quota-refresh-indicator\s*\{(?<body>[^}]*)\}/su)?.groups?.body ?? "";
    const reducedRuleIndex = css.indexOf(
      ".usage-context-ring-value {\n    transition: none;",
    );
    const reducedMotionStart = css.lastIndexOf(
      "@media (prefers-reduced-motion: reduce)",
      reducedRuleIndex,
    );
    const reducedMotionEnd = css.indexOf(
      "@media (prefers-reduced-motion: reduce)",
      reducedRuleIndex + 1,
    );
    const reducedMotion = css.slice(
      reducedMotionStart,
      reducedMotionEnd === -1 ? undefined : reducedMotionEnd,
    );

    expect(ringBlock).toMatch(/width:\s*clamp\(23px,\s*calc\(var\(--control-height\)\s*-\s*7px\),\s*31px\)/su);
    expect(css).toMatch(/\.usage-context-ring-value\s*\{[^}]*stroke:\s*color-mix\(in srgb,\s*var\(--accent\)\s*72%,\s*var\(--text-muted\)\)/su);
    expect(css).toMatch(/\.usage-context-ring-track,\s*\.usage-context-ring-value\s*\{[^}]*stroke-width:\s*1\.65/su);
    expect(css).toMatch(/\.usage-context-ring\.is-near-limit\s+\.usage-context-ring-value\s*\{[^}]*stroke:\s*var\(--warning\)/su);
    expect(css).toMatch(/\.usage-context-ring\.is-unavailable\s+\.usage-context-ring-track\s*\{[^}]*stroke-dasharray:/su);
    expect(ringBlock).not.toContain("animation");
    expect(css).not.toMatch(/\.usage-context-ring-value\s*\{[^}]*animation:/su);
    expect(refreshBlock).not.toContain("animation");
    expect(reducedRuleIndex).toBeGreaterThan(reducedMotionStart);
    expect(reducedMotion).toMatch(/\.usage-context-ring-value\s*\{[^}]*transition:\s*none/su);
  });

  it("shows only reported context details and never substitutes processed totals", () => {
    const html = render(
      usage({
        usedTokens: null,
        maxTokens: 200_000,
        totalProcessedTokens: 900,
        totalProcessedScope: "session",
      }),
      [],
      { ...freshState, freshness: "unavailable", provenance: null, updatedAt: null },
    );
    expect(html).toContain("Context window unavailable");
    expect(html).toContain("200K window · occupancy unavailable");
    expect(html).toContain("Processed in this session");
    expect(html).toContain("Provider-reported session total");
    expect(html).not.toContain("100% left");

    const invalidScope = render(
      usage({ totalProcessedTokens: 900, totalProcessedScope: null }),
      [],
      freshState,
    );
    expect(invalidScope).not.toContain("Processed in this");
    expect(invalidScope).not.toContain("Provider-reported session total");
  });

  it("shows only provider-reported token details and explicit compaction state", () => {
    const reported = render(
      usage({
        inputTokens: 1_500,
        cachedInputTokens: 900,
        cacheWriteInputTokens: 200,
        outputTokens: 350,
        reasoningOutputTokens: 125,
        compactsAutomatically: true,
      }),
      [],
      freshState,
    );

    expect(reported).toContain("Latest token breakdown");
    expect(reported).toContain("<dt>Input</dt><dd>1.5K</dd>");
    expect(reported).toContain("<dt>Cache read</dt><dd>900</dd>");
    expect(reported).toContain("<dt>Cache write</dt><dd>200</dd>");
    expect(reported).toContain("<dt>Output</dt><dd>350</dd>");
    expect(reported).toContain("<dt>Reasoning</dt><dd>125</dd>");
    expect(reported).toContain("cache counts are a breakdown of input where applicable");
    expect(reported).toContain("Automatic compaction enabled");

    const unavailable = render(
      usage({
        inputTokens: null,
        cachedInputTokens: null,
        cacheWriteInputTokens: null,
        outputTokens: null,
        reasoningOutputTokens: null,
        compactsAutomatically: null,
      }),
      [],
      freshState,
    );
    expect(unavailable).not.toContain("Latest token breakdown");
    expect(unavailable).not.toContain("Automatic compaction");

    const explicitlyDisabled = render(
      usage({ compactsAutomatically: false }),
      [],
      freshState,
    );
    expect(explicitlyDisabled).toContain("Automatic compaction disabled");
  });

  it("renders reported quota windows, reset timing, and bounded percentages", () => {
    const html = render(
      usage(),
      [
        {
          id: "five-hour",
          label: "Five hour",
          usedPercent: 25,
          remainingPercent: 75,
          windowMinutes: 300,
          resetsAt: "2026-07-22T15:00:00.000Z",
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPercent: 130,
          remainingPercent: -30,
          windowMinutes: 10_080,
          resetsAt: null,
        },
      ],
      freshState,
    );

    expect(displayPercent(-30)).toBe(0);
    expect(displayPercent(130)).toBe(100);
    expect(displayPercent(Number.NaN)).toBeNull();
    expect(html).toContain("Five hour · 5 hours");
    expect(html).toContain("Weekly · 7 days");
    expect(html).toContain("75% left");
    expect(html).toContain("0% left");
    expect(html).toContain("width:75%");
    expect(html).toContain("width:0%");
    expect(html).toMatch(/Resets Jul 22.*(?:UTC|GMT)/u);
    expect(html).not.toContain("Reset time unavailable");
  });

  it("keeps stale and cached data quality explicit without inventing timestamps", () => {
    const cached = render(
      usage(),
      [{
        id: "quota",
        label: "Quota",
        usedPercent: 25,
        remainingPercent: 75,
        windowMinutes: 300,
        resetsAt: null,
      }],
      {
        ...freshState,
        freshness: "stale",
        provenance: "persistent-cache",
        updatedAt: null,
      },
      "expanded",
      { contextQuality: "stale" },
    );
    const refreshing = render(
      usage(),
      [{
        id: "quota",
        label: "Quota",
        usedPercent: 25,
        remainingPercent: 75,
        windowMinutes: 300,
        resetsAt: null,
      }],
      {
        ...freshState,
        freshness: "stale",
        provenance: "persistent-cache",
        refreshing: true,
      },
    );

    expect(cached).toContain('data-context-quality="stale"');
    expect(cached).toContain("50% · stale");
    expect(cached).toContain("Cached · stale");
    expect(cached).toContain("Cached quota may be out of date");
    expect(cached).not.toContain("Update time unavailable");
    expect(refreshing).toContain("Refreshing · stale");
    expect(refreshing).toContain("shown quota may be out of date");
  });

  it("isolates native account quota from custom routes even when values are passed", () => {
    const html = render(
      usage(),
      [{
        id: "native-weekly",
        label: "Native weekly",
        usedPercent: 10,
        remainingPercent: 90,
        windowMinutes: 10_080,
        resetsAt: "2026-07-29T10:00:00.000Z",
      }],
      { ...freshState, refreshing: true },
      "expanded",
      {
        quotaSource: "isolated",
        providerLabel: "Codex CLI · External gateway · custom-model",
      },
    );

    expect(html).toContain('data-quota-source="isolated"');
    expect(html).toContain("Codex CLI · External gateway · custom-model");
    expect(html).toContain("Quota is unavailable for this selected custom route.");
    expect(html).not.toContain("Native weekly");
    expect(html).not.toContain("90% left");
    expect(html).not.toContain(">Fresh<");
    expect(html).not.toContain("Jul 29");
    expect(html).not.toContain("usage-quota-refresh-indicator");
  });

  it("preserves the selected route identity as text without exposing unavailable fields", () => {
    const html = render(
      null,
      [],
      {
        freshness: "unavailable",
        provenance: null,
        updatedAt: null,
        lastAttemptedAt: null,
        refreshing: false,
      },
      "compact",
      { providerLabel: "Claude SDK · Team profile · sonnet" },
    );

    expect(html).toContain("Claude SDK · Team profile · sonnet");
    expect(html).toContain("Unavailable");
    expect(html).toContain("Provider quota unavailable");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain("Update time unavailable");
    expect(html).not.toContain("Reset time unavailable");
  });
});
