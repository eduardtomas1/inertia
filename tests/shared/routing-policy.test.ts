import { describe, expect, it } from "vitest";

import { clientCommandSchema } from "../../src/shared/contracts/client-command";
import { defaultSettings } from "../../src/shared/contracts/app";
import {
  boundedRoutingReason,
  DEFAULT_ROUTING_SETTINGS,
  defaultRoutingSettings,
  isRoutingDecisionSummary,
  isRoutingSettings,
  MAX_ROUTING_PRESETS_PER_TIER,
  mergeRoutingSettings,
  newChatRoutingMode,
  parseRoutingDecisionJson,
  parseRoutingSettings,
  parseRoutingSettingsJson,
  ROUTING_DECISION_JSON_MAX_LENGTH,
  ROUTING_REASON_MAX_LENGTH,
  ROUTING_SETTINGS_JSON_MAX_LENGTH,
  routingSettingsSchema,
  routingSettingsUpdateSchema,
  safeRoutingDecisionSummary,
  serializeRoutingDecision,
  serializeRoutingSettings,
  type RoutingDecisionSummary,
  type RoutingPreset,
} from "../../src/shared/routing/routing-policy";

const preset: RoutingPreset = {
  providerId: "claude",
  backendProfileId: "builtin:anthropic",
  modelId: "claude-opus-5-5",
  reasoningEffort: "high",
  fastMode: false,
  weight: "prefer",
};

const decision: RoutingDecisionSummary = {
  picker: "rules",
  tier: "heavy",
  taskKind: "debugging",
  confidence: 0.6,
  outcome: "applied",
  reason: "Debugging, 60% confidence → Heavy tier: Claude Opus 5.5 · high.",
  previousRoute: { providerId: "codex", modelId: "gpt-5.5", reasoningEffort: "medium" },
};

function settingsCommand(routing: unknown) {
  return { type: "settings.update", requestId: crypto.randomUUID(), payload: { routing } };
}

describe("routing settings defaults", () => {
  it("is off by default and derives every tier from the catalog", () => {
    expect(defaultRoutingSettings()).toEqual({
      enabled: false,
      autoForNewChats: false,
      picker: "rules",
      confidenceThreshold: 0.5,
      fallbackTier: "standard",
      stickiness: "sticky",
      quotaReservePercent: 10,
      tiers: {
        light: { presets: null },
        standard: { presets: null },
        heavy: { presets: null },
        max: { presets: null },
      },
    });
    expect(defaultSettings.routing).toEqual(DEFAULT_ROUTING_SETTINGS);
    expect(Object.isFrozen(DEFAULT_ROUTING_SETTINGS)).toBe(true);
    expect(isRoutingSettings(defaultRoutingSettings())).toBe(true);
  });

  it("only gives new chats Auto when routing and the new-chat default are both on", () => {
    expect(newChatRoutingMode({ enabled: false, autoForNewChats: true })).toBe("manual");
    expect(newChatRoutingMode({ enabled: true, autoForNewChats: false })).toBe("manual");
    expect(newChatRoutingMode({ enabled: true, autoForNewChats: true })).toBe("auto");
  });
});

describe("routing settings schema", () => {
  it("accepts a complete document with custom presets", () => {
    const settings = {
      ...defaultRoutingSettings(),
      enabled: true,
      tiers: { ...defaultRoutingSettings().tiers, heavy: { presets: [preset, { ...preset, weight: "never" }] } },
    };
    expect(routingSettingsSchema.safeParse(settings).success).toBe(true);
    expect(clientCommandSchema.safeParse(settingsCommand(settings)).success).toBe(true);
  });

  it("accepts partial updates through settings.update", () => {
    for (const routing of [
      { enabled: true },
      { confidenceThreshold: 0.75, fallbackTier: "light" },
      { stickiness: "rebalance", quotaReservePercent: 90 },
      { tiers: { max: { presets: null } } },
      { tiers: { light: { presets: [preset] } } },
    ]) {
      expect(clientCommandSchema.safeParse(settingsCommand(routing)).success, JSON.stringify(routing)).toBe(true);
    }
  });

  it.each([
    ["an unknown key", { enabled: true, extra: 1 }],
    ["a secret-like key", { apiKey: "sk-test" }],
    ["an unknown picker", { picker: "jev" }],
    ["a threshold above one", { confidenceThreshold: 1.01 }],
    ["a negative threshold", { confidenceThreshold: -0.1 }],
    ["a reserve above 90", { quotaReservePercent: 91 }],
    ["a fractional reserve", { quotaReservePercent: 12.5 }],
    ["an unknown tier", { tiers: { ultra: { presets: null } } }],
    ["an unknown stickiness", { stickiness: "always" }],
    ["an unknown preset key", { tiers: { light: { presets: [{ ...preset, token: "x" }] } } }],
    ["an unknown provider", { tiers: { light: { presets: [{ ...preset, providerId: "gemini" }] } } }],
    ["an unknown weight", { tiers: { light: { presets: [{ ...preset, weight: "always" }] } } }],
    ["a quoted model id", { tiers: { light: { presets: [{ ...preset, modelId: "a\"b" }] } } }],
    ["an oversized model id", { tiers: { light: { presets: [{ ...preset, modelId: "m".repeat(201) }] } } }],
    ["a malformed backend profile", { tiers: { light: { presets: [{ ...preset, backendProfileId: "1 bad" }] } } }],
    ["too many presets", { tiers: { light: { presets: Array.from({ length: MAX_ROUTING_PRESETS_PER_TIER + 1 }, () => preset) } } }],
  ])("refuses %s", (_label, routing) => {
    expect(routingSettingsUpdateSchema.safeParse(routing).success).toBe(false);
    expect(clientCommandSchema.safeParse(settingsCommand(routing)).success).toBe(false);
  });

  it("keeps the largest valid document within its stored bound", () => {
    const largest: RoutingPreset = {
      providerId: "antigravity",
      backendProfileId: `b${"x".repeat(199)}`,
      modelId: "m".repeat(200),
      reasoningEffort: "e".repeat(40),
      fastMode: false,
      weight: "normal",
    };
    const presets = Array.from({ length: MAX_ROUTING_PRESETS_PER_TIER }, () => largest);
    const settings = {
      ...defaultRoutingSettings(),
      tiers: { light: { presets }, standard: { presets }, heavy: { presets }, max: { presets } },
    };
    expect(serializeRoutingSettings(settings).length).toBeLessThanOrEqual(ROUTING_SETTINGS_JSON_MAX_LENGTH);
  });
});

describe("routing settings persistence helpers", () => {
  it("repairs each corrupt field and keeps valid ones", () => {
    expect(parseRoutingSettings({
      enabled: true,
      autoForNewChats: "yes",
      picker: "rules",
      confidenceThreshold: 7,
      fallbackTier: "heavy",
      stickiness: "rebalance",
      quotaReservePercent: -1,
      tiers: { light: { presets: [preset] }, heavy: { presets: [{ ...preset, weight: "x" }] } },
      unknown: true,
    })).toEqual({
      ...defaultRoutingSettings(),
      enabled: true,
      fallbackTier: "heavy",
      stickiness: "rebalance",
      tiers: { ...defaultRoutingSettings().tiers, light: { presets: [preset] } },
    });
  });

  it.each([undefined, null, 42, "[]", "{broken", `"${"x".repeat(ROUTING_SETTINGS_JSON_MAX_LENGTH)}"`])(
    "decodes %j defensively",
    (value) => expect(parseRoutingSettingsJson(value)).toEqual(defaultRoutingSettings()),
  );

  it("merges a partial update without dropping untouched tiers", () => {
    const current = mergeRoutingSettings(defaultRoutingSettings(), { tiers: { heavy: { presets: [preset] } } });
    const next = mergeRoutingSettings(current, { enabled: true, tiers: { light: { presets: [] } } });
    expect(next.enabled).toBe(true);
    expect(next.tiers.heavy.presets).toEqual([preset]);
    expect(next.tiers.light.presets).toEqual([]);
    expect(mergeRoutingSettings(next, { tiers: { heavy: { presets: null } } }).tiers.heavy.presets).toBeNull();
  });
});

describe("routing decision summaries", () => {
  it("round-trips a bounded decision", () => {
    expect(isRoutingDecisionSummary(decision)).toBe(true);
    const json = serializeRoutingDecision(decision);
    expect(json.length).toBeLessThanOrEqual(ROUTING_DECISION_JSON_MAX_LENGTH);
    expect(parseRoutingDecisionJson(json)).toEqual(decision);
  });

  it("rejects malformed or oversized decisions", () => {
    expect(parseRoutingDecisionJson(null)).toBeNull();
    expect(parseRoutingDecisionJson("{")).toBeNull();
    expect(parseRoutingDecisionJson(JSON.stringify({ ...decision, extra: true }))).toBeNull();
    expect(parseRoutingDecisionJson(JSON.stringify({ ...decision, confidence: 2 }))).toBeNull();
    expect(parseRoutingDecisionJson("x".repeat(ROUTING_DECISION_JSON_MAX_LENGTH + 1))).toBeNull();
    expect(() => serializeRoutingDecision({ ...decision, reason: "r".repeat(ROUTING_REASON_MAX_LENGTH + 1) })).toThrow();
  });

  it("builds safe summaries without throwing", () => {
    expect(safeRoutingDecisionSummary(decision)).toEqual(decision);
    const emptyEffort = { ...decision, previousRoute: { providerId: "codex", modelId: "gpt-5.6", reasoningEffort: "" } };
    expect(safeRoutingDecisionSummary(emptyEffort)?.previousRoute).toEqual({ providerId: "codex", modelId: "gpt-5.6", reasoningEffort: null });
    expect(safeRoutingDecisionSummary({ ...decision, previousRoute: { ...emptyEffort.previousRoute, reasoningEffort: "e".repeat(100) } })
      ?.previousRoute?.reasoningEffort).toHaveLength(100);
    expect(safeRoutingDecisionSummary({ ...decision, previousRoute: { providerId: "other", modelId: "m", reasoningEffort: null } }))
      .toEqual({ ...decision, previousRoute: null });
    expect(safeRoutingDecisionSummary({ ...decision, reason: "r".repeat(ROUTING_REASON_MAX_LENGTH + 1) })).toBeNull();
    expect(safeRoutingDecisionSummary(null)).toBeNull();
  });

  it("bounds and compacts reasons", () => {
    expect(boundedRoutingReason("  a \n  b  ")).toBe("a b");
    const long = boundedRoutingReason("word ".repeat(200));
    expect(long.length).toBeLessThanOrEqual(ROUTING_REASON_MAX_LENGTH);
    expect(long.endsWith("…")).toBe(true);
  });
});
