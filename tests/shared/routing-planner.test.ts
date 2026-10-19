import { describe, expect, it } from "vitest";

import { routingCatalogFromProviders } from "../../src/shared/routing/routing-catalog";
import {
  effectiveRoutingRoute,
  planRoutingDecision,
  routingCandidateRejection,
  routingTierCandidates,
  routingTierFallbackChain,
  sameRoutingRoute,
  scoreRoutingCandidate,
  type RoutingCurrentRoute,
  type RoutingPlanInput,
} from "../../src/shared/routing/routing-planner";
import { defaultRoutingSettings, type RoutingPreset, type RoutingTier } from "../../src/shared/routing/routing-policy";
import type { PickerResult } from "../../src/shared/routing/routing-rules-picker";
import { ANTIGRAVITY, CLAUDE, CODEX } from "./routing-fixtures";

const codexHigh: RoutingPreset = {
  providerId: "codex", backendProfileId: "builtin:openai", modelId: "gpt-6.1-sol", reasoningEffort: "high", fastMode: false, weight: "normal",
};
const claudeHigh: RoutingPreset = {
  providerId: "claude", backendProfileId: "builtin:anthropic", modelId: "claude-opus-5-5", reasoningEffort: "high", fastMode: false, weight: "normal",
};
const antigravityPro: RoutingPreset = {
  providerId: "antigravity", backendProfileId: "builtin:antigravity", modelId: "gemini-3-pro", reasoningEffort: "high", fastMode: false, weight: "normal",
};
const codexCurrent: RoutingCurrentRoute = {
  providerId: "codex", backendProfileId: "builtin:openai", modelId: "gpt-5.6", reasoningEffort: "medium", fastMode: false,
};

function picked(tier: RoutingTier, confidence = 0.9): PickerResult {
  return { tier, taskKind: "feature", confidence, trace: [] };
}

function tiers(entries: Partial<Record<RoutingTier, RoutingPreset[]>>): Record<RoutingTier, RoutingPreset[]> {
  return { light: [], standard: [], heavy: [], max: [], ...entries };
}

function plan(overrides: Partial<RoutingPlanInput> = {}) {
  const catalog = routingCatalogFromProviders([CODEX, CLAUDE, ANTIGRAVITY]);
  return planRoutingDecision({
    settings: defaultRoutingSettings(),
    picked: picked("heavy"),
    presets: tiers({ heavy: [codexHigh] }),
    catalog,
    current: codexCurrent,
    hasPriorTurns: false,
    requiresVision: false,
    ...overrides,
  });
}

describe("routing candidate filtering", () => {
  const catalog = routingCatalogFromProviders([CODEX, CLAUDE, ANTIGRAVITY]);
  const entryFor = (preset: RoutingPreset) => catalog.find(({ providerId }) => providerId === preset.providerId);
  const modelFor = (preset: RoutingPreset) => entryFor(preset)?.models.find(({ id }) => id === preset.modelId);
  const options = { quotaReservePercent: 10, requiresVision: false };

  it("accepts a valid preset", () => {
    expect(antigravityPro.backendProfileId).toBe(entryFor(antigravityPro)?.backendProfileId);
    expect(routingCandidateRejection(codexHigh, entryFor(codexHigh), modelFor(codexHigh), options)).toBeNull();
  });

  it("refuses Never presets, missing models and unknown reasoning or Fast mode", () => {
    expect(routingCandidateRejection({ ...codexHigh, weight: "never" }, entryFor(codexHigh), modelFor(codexHigh), options)).toMatch(/Never/u);
    expect(routingCandidateRejection({ ...codexHigh, modelId: "gone" }, entryFor(codexHigh), undefined, options)).toMatch(/no longer offers/u);
    expect(routingCandidateRejection({ ...codexHigh, reasoningEffort: "ultra" }, entryFor(codexHigh), modelFor(codexHigh), options)).toMatch(/ultra/u);
    expect(routingCandidateRejection({ ...codexHigh, fastMode: true }, entryFor(codexHigh), modelFor(codexHigh), options)).toMatch(/Fast/u);
    const fastPreset = { ...codexHigh, modelId: "gpt-5.6", fastMode: true };
    expect(routingCandidateRejection(fastPreset, entryFor(fastPreset), modelFor(fastPreset), options)).toBeNull();
  });

  it("refuses signed-out providers", () => {
    const signedOut = routingCatalogFromProviders([{ ...CODEX, authState: "unauthenticated" }]);
    expect(routingCandidateRejection(codexHigh, signedOut[0], signedOut[0]!.models[2], options)).toMatch(/not signed in/u);
    expect(routingCandidateRejection(codexHigh, undefined, undefined, options)).toMatch(/unavailable/u);
  });

  it("requires vision when images are attached", () => {
    expect(routingCandidateRejection(antigravityPro, entryFor(antigravityPro), modelFor(antigravityPro), { ...options, requiresVision: true }))
      .toMatch(/cannot read images/u);
    expect(routingCandidateRejection(codexHigh, entryFor(codexHigh), modelFor(codexHigh), { ...options, requiresVision: true })).toBeNull();
  });

  it("respects usage limits and the quota reserve", () => {
    const [low] = routingCatalogFromProviders([{ ...CODEX, rateLimits: [{ remainingPercent: 8 }] }]);
    expect(routingCandidateRejection(codexHigh, low, low!.models[2], options)).toMatch(/quota reserve/u);
    expect(routingCandidateRejection(codexHigh, low, low!.models[2], { ...options, quotaReservePercent: 5 })).toBeNull();
    expect(routingCandidateRejection(codexHigh, { ...low!, usageLimited: true }, low!.models[2], { ...options, quotaReservePercent: 0 }))
      .toMatch(/usage limited/u);
  });

  it("runs the runtime validator and reports every skipped preset", () => {
    const { candidates, rejected } = routingTierCandidates("heavy", [codexHigh, claudeHigh, { ...claudeHigh, weight: "never" }], catalog, {
      ...options,
      validate: ({ preset }) => preset.providerId === "codex" ? "the route failed validation" : null,
    });
    expect(candidates.map(({ preset }) => preset.providerId)).toEqual(["claude"]);
    expect(rejected).toEqual([
      "heavy#1 gpt-6.1-sol: the route failed validation",
      "heavy#3 claude-opus-5-5: weight is Never",
    ]);
  });
});

describe("routing candidate scoring", () => {
  const [codex] = routingCatalogFromProviders([CODEX]);
  const candidate = (preset: RoutingPreset, remainingPercent: number | null = null) => ({
    tier: "heavy" as const, presetIndex: 0, preset, entry: { ...codex!, remainingPercent }, model: codex!.models[2]!,
  });

  it("ranks weights and penalises low quota below one weight step", () => {
    expect(scoreRoutingCandidate(candidate({ ...codexHigh, weight: "prefer" }), { stickyProviderId: null })).toBe(3);
    expect(scoreRoutingCandidate(candidate(codexHigh), { stickyProviderId: null })).toBe(2);
    expect(scoreRoutingCandidate(candidate({ ...codexHigh, weight: "less" }), { stickyProviderId: null })).toBe(1);
    expect(scoreRoutingCandidate(candidate(codexHigh, 0), { stickyProviderId: null })).toBe(1.5);
    expect(scoreRoutingCandidate(candidate({ ...codexHigh, weight: "prefer" }, 0), { stickyProviderId: null }))
      .toBeGreaterThan(scoreRoutingCandidate(candidate(codexHigh, 100), { stickyProviderId: null }));
  });

  it("penalises leaving the sticky provider", () => {
    expect(scoreRoutingCandidate(candidate(codexHigh), { stickyProviderId: "claude" })).toBeLessThan(0);
  });
});

describe("routing plans", () => {
  it("applies the picker's tier when it is confident", () => {
    const result = plan();
    expect(result).toMatchObject({ requestedTier: "heavy", tier: "heavy", lowConfidence: false, fallback: false, changesRoute: true });
    expect(result.candidate?.preset).toEqual(codexHigh);
    expect(result.reason).toContain("Heavy tier");
  });

  it("uses the fallback tier below the confidence threshold", () => {
    const standard = { ...codexHigh, modelId: "gpt-5.6", reasoningEffort: "medium" };
    const result = plan({ picked: picked("heavy", 0.3), presets: tiers({ heavy: [codexHigh], standard: [standard] }) });
    expect(result).toMatchObject({ requestedTier: "standard", tier: "standard", lowConfidence: true, fallback: false, changesRoute: false });
    expect(result.trace.some((line) => line.includes("below 0.5"))).toBe(true);
  });

  it("flags low confidence only when the fallback tier changes the pick", () => {
    const standard = { ...codexHigh, modelId: "gpt-5.6", reasoningEffort: "medium" };
    const presets = tiers({ heavy: [codexHigh], standard: [standard] });
    const sameTier = plan({ picked: picked("standard", 0.3), presets });
    expect(sameTier).toMatchObject({ requestedTier: "standard", tier: "standard", lowConfidence: false, fallback: false });
    expect(sameTier.reason).toContain("Standard tier");
    const confident = plan({ picked: picked("heavy", 0.5), presets });
    expect(confident).toMatchObject({ tier: "heavy", lowConfidence: false });
  });

  it.each([
    ["checking install", { installState: "checking" }],
    ["unresponsive", { installState: "unresponsive" }],
    ["checking sign-in", { authState: "checking" }],
  ] as const)("keeps the route while the current provider is %s", (_label, state) => {
    const catalog = routingCatalogFromProviders([{ ...CODEX, canRun: false, ...state }, CLAUDE]);
    const result = plan({ catalog, presets: tiers({ heavy: [claudeHigh, codexHigh] }), hasPriorTurns: true });
    expect(result).toMatchObject({ candidate: null, changesRoute: false, fallback: false, lowConfidence: false });
    expect(result.reason).toContain("Codex is being checked");
    const signedOut = plan({
      catalog: routingCatalogFromProviders([{ ...CODEX, authState: "unauthenticated" }, CLAUDE]),
      presets: tiers({ heavy: [claudeHigh, codexHigh] }),
      hasPriorTurns: true,
    });
    expect(signedOut.candidate?.preset.providerId).toBe("claude");
  });

  it("walks the fallback tiers on the sticky provider before leaving it", () => {
    const codexStandard = { ...codexHigh, modelId: "gpt-6.1-sol", reasoningEffort: "medium" };
    const presets = tiers({ max: [claudeHigh], heavy: [claudeHigh], standard: [codexStandard] });
    const sticky = plan({ picked: picked("max"), presets, hasPriorTurns: true });
    expect(sticky).toMatchObject({ requestedTier: "max", tier: "standard", fallback: true, changesRoute: true });
    expect(sticky.candidate?.preset).toEqual(codexStandard);
    expect(sticky.reason).toContain("No Max preset is available on Codex; staying there with Standard");
    const light = plan({ picked: picked("max"), presets: tiers({ max: [claudeHigh], light: [codexStandard] }), hasPriorTurns: true });
    expect(light).toMatchObject({ tier: "light", candidate: expect.objectContaining({ preset: codexStandard }) });
    const rebalance = plan({ picked: picked("max"), presets, hasPriorTurns: true, settings: { ...defaultRoutingSettings(), stickiness: "rebalance" } });
    expect(rebalance).toMatchObject({ tier: "max", fallback: false, candidate: expect.objectContaining({ preset: claudeHigh }) });
  });

  it("keeps the current provider in sticky mode unless it has no candidate", () => {
    const presets = tiers({ heavy: [{ ...claudeHigh, weight: "prefer" }, codexHigh] });
    expect(plan({ presets, hasPriorTurns: true }).candidate?.preset.providerId).toBe("codex");
    expect(plan({ presets, hasPriorTurns: false }).candidate?.preset.providerId).toBe("claude");
    expect(plan({ presets, hasPriorTurns: true, settings: { ...defaultRoutingSettings(), stickiness: "rebalance" } })
      .candidate?.preset.providerId).toBe("claude");
    expect(plan({ presets: tiers({ heavy: [claudeHigh] }), hasPriorTurns: true }).candidate?.preset.providerId).toBe("claude");
  });

  it("breaks ties by preset order", () => {
    const presets = tiers({ heavy: [claudeHigh, codexHigh] });
    expect(plan({ presets, settings: { ...defaultRoutingSettings(), stickiness: "rebalance" } }).candidate?.preset).toEqual(claudeHigh);
  });

  it("steps toward Standard, then any tier, then keeps the current route", () => {
    expect(routingTierFallbackChain("max")).toEqual(["max", "heavy", "standard"]);
    expect(routingTierFallbackChain("light")).toEqual(["light", "standard"]);
    expect(routingTierFallbackChain("standard")).toEqual(["standard"]);
    const viaHeavy = plan({ picked: picked("max"), presets: tiers({ heavy: [codexHigh], light: [claudeHigh] }) });
    expect(viaHeavy).toMatchObject({ requestedTier: "max", tier: "heavy", fallback: true });
    const anyTier = plan({ picked: picked("max"), presets: tiers({ light: [claudeHigh] }) });
    expect(anyTier).toMatchObject({ tier: "light", fallback: true });
    const none = plan({ presets: tiers({}) });
    expect(none).toMatchObject({ candidate: null, fallback: true, changesRoute: false });
    expect(none.reason).toContain("current model stays");
  });

  it("detects an unchanged route after resolving provider defaults", () => {
    const catalog = routingCatalogFromProviders([CODEX]);
    const current = effectiveRoutingRoute({ ...codexCurrent, modelId: "provider-default", reasoningEffort: null }, catalog);
    expect(current).toMatchObject({ modelId: "gpt-5.6", reasoningEffort: "medium" });
    expect(sameRoutingRoute({ preset: { ...codexHigh, modelId: "gpt-5.6", reasoningEffort: "medium" } }, current)).toBe(true);
    expect(sameRoutingRoute({ preset: codexHigh }, current)).toBe(false);
  });
});
