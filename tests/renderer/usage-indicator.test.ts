import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProviderMetadataFieldState, ProviderRateLimit, ThreadUsageSnapshot, UsageDisplayMode } from "../../src/shared/contracts";
import {
  contextRemaining,
  displayPercent,
  usageAutoCollapseReason,
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
): string {
  return renderToStaticMarkup(createElement(UsageIndicator, {
    usage: snapshot,
    rateLimits,
    rateLimitState,
    mode,
    providerLabel: "Codex",
    onModeChange: () => undefined,
  }));
}

describe("UsageIndicator", () => {
  it("supports expanded, compact, and hidden modes with explicit disclosure state", () => {
    const expanded = render(usage(), [], freshState);
    const compact = render(usage(), [], freshState, "compact");

    expect(expanded).toContain('data-mode="expanded"');
    expect(expanded).toContain('aria-label="Collapse usage and context"');
    expect(expanded).toContain('aria-expanded="true"');
    expect(compact).toContain('data-mode="compact"');
    expect(compact).toContain('aria-label="Expand usage and context"');
    expect(compact).toContain('aria-expanded="false"');
    expect(compact).toContain('aria-label="Hide usage and context"');
    expect(render(usage(), [], freshState, "hidden")).toBe("");
  });

  it("keeps the composer card bounded and collapses its grid in narrow composer regions", () => {
    const css = readFileSync(new URL("../../src/renderer/src/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.composer-usage\s*\{[^}]*width:\s*min\(830px,\s*100%\)[^}]*max-width:\s*830px/su);
    expect(css).toMatch(/\.composer-region\s*\{[^}]*container-type:\s*inline-size/su);
    expect(css).toMatch(/@container\s*\(max-width:\s*560px\)\s*\{[^}]*\.usage-expanded-content\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/su);
    expect(css).toMatch(/@media\s*\(max-width:\s*1024px\),\s*\(max-height:\s*760px\)\s*\{[^}]*\.usage-panel\.is-expanded\s+\.usage-expanded-content\s*\{[^}]*max-height:/su);
  });

  it("auto-collapses only when space is constrained or no useful report exists", () => {
    expect(usageAutoCollapseReason(usage(), [], false)).toBeNull();
    expect(usageAutoCollapseReason(usage(), [], true)).toBe("space");
    expect(usageAutoCollapseReason(null, [], false)).toBe("unavailable");
    expect(usageAutoCollapseReason(usage({ usedTokens: null, maxTokens: null, totalProcessedTokens: null }), [], false)).toBe("unavailable");
    expect(usageAutoCollapseReason(usage({ usedTokens: null, maxTokens: 200_000 }), [], false)).toBeNull();
  });

  it("keeps raw quota overflow out of display values and meter widths", () => {
    const html = render(
      usage(),
      [{ id: "quota", label: "Quota", usedPercent: 130, remainingPercent: -30, windowMinutes: 300, resetsAt: "2026-07-22T15:00:00.000Z" }],
      freshState,
    );
    expect(displayPercent(-30)).toBe(0);
    expect(displayPercent(130)).toBe(100);
    expect(displayPercent(Number.NaN)).toBeNull();
    expect(html).toContain("0% left");
    expect(html).toContain("width:0%");
    expect(html).not.toContain("-30%");
    expect(html).toMatch(/Resets Jul 22.*(?:UTC|GMT)/u);
  });

  it("does not invent context capacity for unknown occupancy or a zero denominator", () => {
    expect(contextRemaining(usage({ maxTokens: 0 }))).toBeNull();
    expect(contextRemaining(usage({ usedTokens: null, maxTokens: 200_000 }))).toBeNull();
    expect(contextRemaining(usage({ usedTokens: 200_001, maxTokens: 200_000 }))).toBeNull();
    expect(contextRemaining(usage({ usedTokens: -1, maxTokens: 200_000 }))).toBeNull();
    const html = render(
      usage({ usedTokens: null, maxTokens: 200_000, totalProcessedTokens: 900, totalProcessedScope: "session" }),
      [],
      { ...freshState, freshness: "unavailable", provenance: null, updatedAt: null },
    );
    expect(html).toContain("current occupancy unavailable");
    expect(html).toContain("900 processed in this session");
    expect(html).toContain("Provider quota");
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("100% left");
  });

  it("renders every provider window with reset timing and freshness provenance", () => {
    const fresh = render(
      usage(),
      [
        { id: "five-hour", label: "Five hour", usedPercent: 25, remainingPercent: 75, windowMinutes: 300, resetsAt: "2026-07-22T15:00:00.000Z" },
        { id: "weekly", label: "Weekly", usedPercent: 40, remainingPercent: 60, windowMinutes: 10_080, resetsAt: null },
      ],
      freshState,
    );
    const cached = render(
      usage(),
      [{ id: "quota", label: "Quota", usedPercent: 25, remainingPercent: 75, windowMinutes: 300, resetsAt: null }],
      { ...freshState, freshness: "stale", provenance: "persistent-cache" },
    );
    const stale = render(
      usage(),
      [{ id: "quota", label: "Quota", usedPercent: 25, remainingPercent: 75, windowMinutes: 300, resetsAt: null }],
      { ...freshState, freshness: "stale", provenance: "session" },
    );

    expect(fresh).toContain("2 windows reported");
    expect(fresh).toContain("Five hour · 5 hours");
    expect(fresh).toContain("Weekly · 7 days");
    expect(fresh).toContain("75% left");
    expect(fresh).toContain("60% left");
    expect(fresh).toContain("Fresh");
    expect(fresh).toMatch(/Resets Jul 22.*(?:UTC|GMT)/u);
    expect(fresh).toContain("Reset time unavailable");
    expect(cached).toContain("Cached · stale");
    expect(cached).toContain("Cached quota may be out of date");
    expect(stale).toContain(">Stale<");
    expect(stale).toContain("Provider quota may be out of date");
  });

  it("keeps stale status explicit while a last-known-good quota refreshes", () => {
    const html = render(
      usage(),
      [{ id: "quota", label: "Quota", usedPercent: 25, remainingPercent: 75, windowMinutes: 300, resetsAt: null }],
      { ...freshState, freshness: "stale", provenance: "persistent-cache", refreshing: true },
    );
    expect(html).toContain("Refreshing · stale");
    expect(html).toContain("shown quota may be out of date");
  });

  it("shows unavailable context and quota honestly even when no values exist", () => {
    const html = render(
      null,
      [],
      { ...freshState, freshness: "unavailable", provenance: null, updatedAt: null, lastAttemptedAt: null },
    );
    expect(html).toContain('data-mode="compact"');
    expect(html).toContain('data-auto-collapsed="true"');
    expect(html).toContain('data-collapse-reason="unavailable"');
    expect(html).toContain("Usage unavailable");
    expect(html).toContain("Provider quota unavailable");
    expect(html).toContain('aria-label="Expand usage and context"');
    expect(html).not.toContain('role="progressbar"');
  });
});
