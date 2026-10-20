import { describe, expect, it } from "vitest";

import {
  accessModesAboveCeiling,
  applyInitiativePreferencesPatch,
  clampAccessMode,
  defaultInitiativePreferences,
  effectiveBrowserAccess,
  effectiveClaudeBudget,
  exceedsAccessCeiling,
  initiativeAccessCeilingMessage,
  initiativePatchSchema,
  initiativePreferencesPatchSchema,
  initiativePreferencesSchema,
  MAX_INITIATIVE_PREFERENCES_JSON_CHARS,
  parseInitiativePreferences,
} from "../../src/shared/initiatives";
import { providerNativeModelSelection } from "../../src/shared/model-routing";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const model = providerNativeModelSelection({ providerId: "claude", modelId: "opus", alias: "opus" });

describe("initiative preferences", () => {
  it("treats an empty record as every layer deferring", () => {
    expect(initiativePreferencesSchema.parse({})).toEqual(defaultInitiativePreferences());
    expect(defaultInitiativePreferences()).toEqual({
      defaultModel: null,
      defaultReasoningEffort: null,
      defaultAccessMode: null,
      accessCeiling: null,
      browserAccess: null,
      claudeMaxBudgetUsd: null,
      defaultProjectId: null,
      skillsFolder: false,
      mcpServers: [],
    });
  });

  it("validates every field strictly", () => {
    const valid = {
      ...defaultInitiativePreferences(),
      defaultModel: model,
      defaultReasoningEffort: "high",
      defaultAccessMode: "full",
      accessCeiling: "auto-edit",
      browserAccess: false,
      claudeMaxBudgetUsd: 2.5,
      defaultProjectId: PROJECT_ID,
      skillsFolder: true,
    };
    expect(initiativePreferencesSchema.parse(valid)).toEqual(valid);
    for (const invalid of [
      { ...valid, unknown: true },
      { ...valid, accessCeiling: "root" },
      { ...valid, defaultAccessMode: "auto" },
      { ...valid, claudeMaxBudgetUsd: 0 },
      { ...valid, claudeMaxBudgetUsd: 1.234 },
      { ...valid, claudeMaxBudgetUsd: 10_000.01 },
      { ...valid, browserAccess: "no" },
      { ...valid, defaultProjectId: "project" },
      { ...valid, defaultReasoningEffort: "" },
      { ...valid, defaultReasoningEffort: " high" },
      { ...valid, defaultReasoningEffort: "hi\ngh" },
      { ...valid, defaultModel: { ...model, harnessId: 7 } },
      { ...valid, skillsFolder: null },
    ]) {
      expect(initiativePreferencesSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("salvages valid fields from damaged or newer records and never throws", () => {
    expect(parseInitiativePreferences(JSON.stringify({
      accessCeiling: "auto-edit",
      claudeMaxBudgetUsd: -4,
      browserAccess: "maybe",
      skillsFolder: true,
      addedLater: { anything: true },
    }))).toEqual({ ...defaultInitiativePreferences(), accessCeiling: "auto-edit", skillsFolder: true });
    for (const unreadable of ["{", "null", "[]", "42", "\"text\"", undefined, null, 7, "x".repeat(MAX_INITIATIVE_PREFERENCES_JSON_CHARS + 1)]) {
      expect(parseInitiativePreferences(unreadable)).toEqual(defaultInitiativePreferences());
    }
    // Inherited keys never count as fields.
    expect(parseInitiativePreferences(JSON.stringify({ toString: "x", accessCeiling: "supervised" })))
      .toEqual({ ...defaultInitiativePreferences(), accessCeiling: "supervised" });
  });

  it("patches only the fields it names and drops a reasoning level without a model", () => {
    const current = { ...defaultInitiativePreferences(), defaultModel: model, defaultReasoningEffort: "high", browserAccess: false };
    expect(applyInitiativePreferencesPatch(current, { accessCeiling: "supervised" }))
      .toEqual({ ...current, accessCeiling: "supervised" });
    expect(applyInitiativePreferencesPatch(current, { browserAccess: null })).toEqual({ ...current, browserAccess: null });
    expect(applyInitiativePreferencesPatch(current, { defaultModel: null }))
      .toEqual({ ...current, defaultModel: null, defaultReasoningEffort: null });
    expect(initiativePreferencesPatchSchema.safeParse({}).success).toBe(false);
    expect(initiativePreferencesPatchSchema.safeParse({ skillsFolder: true, extra: 1 }).success).toBe(false);
    expect(initiativePatchSchema.safeParse({ preferences: { accessCeiling: null } }).success).toBe(true);
  });
});

describe("initiative restrictions", () => {
  it("clamps access down to a ceiling and never up", () => {
    expect(clampAccessMode("full", "auto-edit")).toBe("auto-edit");
    expect(clampAccessMode("full", "supervised")).toBe("supervised");
    expect(clampAccessMode("auto-edit", "supervised")).toBe("supervised");
    expect(clampAccessMode("supervised", "full")).toBe("supervised");
    expect(clampAccessMode("auto-edit", "auto-edit")).toBe("auto-edit");
    expect(clampAccessMode("full", null)).toBe("full");
    expect(clampAccessMode("full", undefined)).toBe("full");
    expect(exceedsAccessCeiling("full", "auto-edit")).toBe(true);
    expect(exceedsAccessCeiling("auto-edit", "auto-edit")).toBe(false);
    expect(exceedsAccessCeiling("full", null)).toBe(false);
    expect(accessModesAboveCeiling("supervised")).toEqual(["auto-edit", "full"]);
    expect(accessModesAboveCeiling("auto-edit")).toEqual(["full"]);
    expect(accessModesAboveCeiling("full")).toEqual([]);
    expect(initiativeAccessCeilingMessage("Checkout", "auto-edit"))
      .toBe("“Checkout” limits chats to Auto-accept edits.");
  });

  it("lets a block at either layer win for browser access", () => {
    const at = (browserAccess: boolean | null) => ({ browserAccess });
    expect(effectiveBrowserAccess(at(false), at(true))).toEqual({ allowed: false, source: "initiative" });
    expect(effectiveBrowserAccess(at(true), at(false))).toEqual({ allowed: false, source: "project" });
    expect(effectiveBrowserAccess(at(null), at(false))).toEqual({ allowed: false, source: "project" });
    expect(effectiveBrowserAccess(at(true), at(null))).toEqual({ allowed: true, source: "initiative" });
    expect(effectiveBrowserAccess(at(null), at(true))).toEqual({ allowed: true, source: "project" });
    expect(effectiveBrowserAccess(at(null), at(null))).toEqual({ allowed: true, source: "default" });
    expect(effectiveBrowserAccess(null, undefined)).toEqual({ allowed: true, source: "default" });
  });

  it("applies the lower Claude spend limit when both layers set one", () => {
    const at = (claudeMaxBudgetUsd: number | null) => ({ claudeMaxBudgetUsd });
    expect(effectiveClaudeBudget(at(2), at(5))).toEqual({ usd: 2, source: "initiative" });
    expect(effectiveClaudeBudget(at(5), at(2))).toEqual({ usd: 2, source: "project" });
    expect(effectiveClaudeBudget(at(3), at(3))).toEqual({ usd: 3, source: "initiative" });
    expect(effectiveClaudeBudget(at(4), at(null))).toEqual({ usd: 4, source: "initiative" });
    expect(effectiveClaudeBudget(at(null), at(4))).toEqual({ usd: 4, source: "project" });
    expect(effectiveClaudeBudget(null, at(null))).toEqual({ usd: null, source: "default" });
  });
});
