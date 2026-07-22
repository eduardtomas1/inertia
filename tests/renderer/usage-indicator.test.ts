import { readFileSync } from "node:fs";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ProviderMetadataFieldState, ProviderRateLimit, ThreadUsageSnapshot } from "../../src/shared/contracts";
import { contextRemaining, displayPercent, UsageIndicator } from "../../src/renderer/src/components/UsageIndicator";

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
): string {
  return renderToStaticMarkup(createElement(UsageIndicator, { usage: snapshot, rateLimits, rateLimitState, supportsUsage: true }));
}

describe("UsageIndicator", () => {
  it("caps the wide popover and keeps it inside compact viewports", () => {
    const css = readFileSync(new URL("../../src/renderer/src/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.usage-popover\s*\{[^}]*width:\s*min\(310px,\s*calc\(100vw\s*-\s*36px\)\)/su);
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
    const html = render(
      usage({ usedTokens: null, maxTokens: 200_000, totalProcessedTokens: 900, totalProcessedScope: "session" }),
      [],
      { ...freshState, freshness: "unavailable", provenance: null, updatedAt: null },
    );
    expect(html).toContain("current occupancy not reported");
    expect(html).toContain("900 processed in this session");
    expect(html).toContain("Provider quota unavailable");
    expect(html).not.toContain("Context 100%");
  });

  it("marks persisted provider quota as stale instead of live", () => {
    const html = render(
      usage(),
      [{ id: "quota", label: "Quota", usedPercent: 25, remainingPercent: 75, windowMinutes: 300, resetsAt: null }],
      { ...freshState, freshness: "stale", provenance: "persistent-cache" },
    );
    expect(html).toContain("Saved quota data");
    expect(html).not.toContain("Live values");
  });
});
