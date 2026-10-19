import { describe, expect, it } from "vitest";

import type { ProviderId } from "../../src/shared/provider";
import {
  deriveDefaultRoutingPresets,
  effectiveRoutingPresets,
  routingCatalogFromProviders,
  routingModelRank,
  type RoutingBackendProfileSource,
} from "../../src/shared/routing/routing-catalog";
import { defaultRoutingSettings, type RoutingPreset } from "../../src/shared/routing/routing-policy";
import { ANTIGRAVITY, CLAUDE, CODEX, CURSOR, KIMI, OPENCODE, routingProvider } from "./routing-fixtures";

function presetOf(providerId: ProviderId, backendProfileId: string, modelId: string, reasoningEffort: string | null, weight: RoutingPreset["weight"] = "normal"): RoutingPreset {
  return { providerId, backendProfileId, modelId, reasoningEffort, fastMode: false, weight };
}

describe("routing model rank heuristic", () => {
  it.each([
    [["gpt-5.4-mini", "GPT-5.4 Mini"], 1],
    [["gemini-3-flash", "Gemini 3 Flash"], 1],
    [["claude-haiku-4-5", "Claude Haiku"], 1],
    [["claude-sonnet-5", "Claude Sonnet"], 2],
    [["claude-opus-5-5", "Claude Opus"], 3],
    [["gpt-6.1-sol", "GPT Sol"], 3],
    [["gemini-2.5-pro", "Gemini Pro"], 3],
    [["claude-fable-5", "Claude Fable"], 4],
    [["gpt-5.1-codex-max", "Codex Max"], 4],
  ] as const)("ranks %j as %i", ([id, label], rank) => {
    expect(routingModelRank({ id, label }, 3, 0)).toBe(rank);
  });

  it("ranks unknown names around the provider default", () => {
    expect(routingModelRank({ id: "alpha", label: "Alpha" }, 1, 1)).toBe(2);
    expect(routingModelRank({ id: "beta", label: "Beta" }, 0, 2)).toBeGreaterThan(2);
    expect(routingModelRank({ id: "gamma", label: "Gamma" }, 3, 1)).toBeLessThan(2);
  });
});

describe("default routing presets", () => {
  it("derives Codex tiers from the advertised catalog", () => {
    const derived = deriveDefaultRoutingPresets(routingCatalogFromProviders([CODEX]), "codex");
    expect(derived).toEqual({
      light: [presetOf("codex", "builtin:openai", "gpt-5.4-mini", "low", "prefer")],
      standard: [presetOf("codex", "builtin:openai", "gpt-5.6", "medium", "prefer")],
      heavy: [presetOf("codex", "builtin:openai", "gpt-6.1-sol", "high", "prefer")],
      max: [presetOf("codex", "builtin:openai", "gpt-6.1-sol", "xhigh", "prefer")],
    });
  });

  it("derives Claude tiers with the top model for Heavy and Max", () => {
    const derived = deriveDefaultRoutingPresets(routingCatalogFromProviders([CLAUDE]), "codex");
    expect(derived.light).toEqual([presetOf("claude", "builtin:anthropic", "claude-haiku-4-5", "low")]);
    expect(derived.standard).toEqual([presetOf("claude", "builtin:anthropic", "claude-sonnet-5", "medium")]);
    expect(derived.heavy).toEqual([presetOf("claude", "builtin:anthropic", "claude-fable-5", "high")]);
    expect(derived.max).toEqual([presetOf("claude", "builtin:anthropic", "claude-fable-5", "max")]);
    expect(derived.max.every(({ fastMode }) => fastMode === false)).toBe(true);
  });

  it("handles catalogs without reasoning choices (Cursor, Kimi, OpenCode)", () => {
    const catalog = routingCatalogFromProviders([CURSOR, KIMI, OPENCODE]);
    const derived = deriveDefaultRoutingPresets(catalog, "kimi");
    const cursor = catalog.find(({ providerId }) => providerId === "cursor")!.backendProfileId;
    const kimi = catalog.find(({ providerId }) => providerId === "kimi")!.backendProfileId;
    const opencode = catalog.find(({ providerId }) => providerId === "opencode")!.backendProfileId;
    expect(derived.standard).toEqual([
      presetOf("kimi", kimi, "kimi-for-coding", null, "prefer"),
      presetOf("cursor", cursor, "auto", null),
      presetOf("opencode", opencode, "anthropic/claude-sonnet-4-5", null),
    ]);
    expect(derived.light.map(({ modelId }) => modelId)).toEqual(["kimi-for-coding", "gpt-5.1-codex", "openai/gpt-5-nano"]);
    expect(derived.heavy.map(({ modelId }) => modelId)).toEqual(["kimi-for-coding", "claude-opus", "google/gemini-2.5-pro"]);
    expect([...derived.light, ...derived.max].every(({ reasoningEffort }) => reasoningEffort === null)).toBe(true);
  });

  it("derives Antigravity tiers whose only high option serves Heavy and Max", () => {
    const derived = deriveDefaultRoutingPresets(routingCatalogFromProviders([ANTIGRAVITY]), "antigravity");
    expect(derived.light[0]).toMatchObject({ modelId: "gemini-3-flash", reasoningEffort: "low", weight: "prefer" });
    expect(derived.standard[0]).toMatchObject({ modelId: "gemini-3-pro", reasoningEffort: "high" });
    expect(derived.heavy[0]).toMatchObject({ modelId: "gemini-3-pro", reasoningEffort: "high" });
    expect(derived.max[0]).toMatchObject({ modelId: "gemini-3-pro", reasoningEffort: "high" });
  });

  it("prefers the default provider, lists it first and skips empty catalogs and custom backends", () => {
    const empty = routingProvider("opencode", []);
    const backend: RoutingBackendProfileSource = {
      id: "custom:team",
      harnessId: "claude-agent-sdk",
      displayName: "Team gateway",
      enabled: true,
      authState: "configured",
      connectionState: "connected",
      models: [{ id: "team-model", displayName: "Team model", reasoningOptions: [], capabilities: [] }],
    };
    const catalog = routingCatalogFromProviders([CODEX, CLAUDE, empty], [backend]);
    expect(catalog.map(({ backendProfileId }) => backendProfileId)).toEqual([
      "builtin:openai", "builtin:anthropic", catalog[2]!.backendProfileId, "custom:team",
    ]);
    const derived = deriveDefaultRoutingPresets(catalog, "claude");
    expect(derived.standard.map(({ providerId, weight }) => [providerId, weight])).toEqual([
      ["claude", "prefer"],
      ["codex", "normal"],
    ]);
  });

  it("uses a customised tier verbatim and derives only tiers left at null", () => {
    const custom = [presetOf("codex", "builtin:openai", "gpt-5.6", "high", "less")];
    const settings = { ...defaultRoutingSettings(), tiers: { ...defaultRoutingSettings().tiers, heavy: { presets: custom } } };
    const effective = effectiveRoutingPresets(settings, routingCatalogFromProviders([CODEX]), "codex");
    expect(effective.heavy).toEqual(custom);
    expect(effective.heavy).not.toBe(custom);
    expect(effective.light).toEqual([presetOf("codex", "builtin:openai", "gpt-5.4-mini", "low", "prefer")]);
  });
});

describe("routing catalog", () => {
  it("marks readiness, usage and capabilities from provider state", () => {
    const [ready, signedOut, limited] = routingCatalogFromProviders([
      { ...CODEX, rateLimits: [{ remainingPercent: 40 }, { remainingPercent: 12 }] },
      { ...CLAUDE, authState: "unauthenticated" },
      { ...ANTIGRAVITY, rateLimits: [{ remainingPercent: 0 }] },
    ]);
    expect(ready).toMatchObject({ ready: true, usageLimited: false, remainingPercent: 12 });
    expect(ready!.models[0]).toMatchObject({ vision: true, fastMode: true, defaultReasoningEffort: "medium" });
    expect(signedOut!.ready).toBe(false);
    expect(limited).toMatchObject({ usageLimited: true, remainingPercent: 0 });
    expect(limited!.models[0]!.vision).toBe(false);
  });

  it("only treats enabled, authenticated custom backends on an installed harness as ready", () => {
    const profile: RoutingBackendProfileSource = {
      id: "custom:vision",
      harnessId: "claude-agent-sdk",
      displayName: "Vision gateway",
      enabled: true,
      authState: "configured",
      connectionState: "connected",
      models: [{
        id: "vision-model",
        displayName: "Vision model",
        reasoningOptions: [{ value: "high" }],
        capabilities: [{ id: "images", state: "verified" }],
      }],
    };
    const [, entry] = routingCatalogFromProviders([CLAUDE], [profile]);
    expect(entry).toMatchObject({ native: false, ready: true, providerId: "claude" });
    expect(entry!.models[0]).toMatchObject({ vision: true, reasoningOptions: ["high"] });
    expect(routingCatalogFromProviders([CLAUDE], [{ ...profile, authState: "missing" }])[1]!.ready).toBe(false);
    expect(routingCatalogFromProviders([], [profile])[0]!.ready).toBe(false);
  });
});
