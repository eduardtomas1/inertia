import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_API_KEY_TIER_MODEL_IDS,
  BACKEND_PRESETS,
  BACKEND_PRESET_IDS,
  backendPresetDefinition,
  isBackendPresetId,
} from "../../src/shared/backend-presets";
import { MODEL_BACKEND_PROFILE_PRESETS } from "../../src/shared/backend-profile-settings";
import {
  CLAUDE_INTERNAL_TIER_IDS,
  KIMI_CLAUDE_BUILTIN_PROFILE_ID,
  KIMI_CODING_BASE_URL,
  KIMI_CODING_MODELS,
  builtInKimiClaudeBackendProfile,
} from "../../src/shared/claude-backend-profiles";

describe("backend preset catalogue", () => {
  it("covers every preset except native and custom", () => {
    expect(MODEL_BACKEND_PROFILE_PRESETS).toEqual([
      "native",
      "kimi-code",
      "custom",
      "anthropic-api-key",
      "openai-api-key",
    ]);
    expect([...BACKEND_PRESET_IDS].sort()).toEqual(
      MODEL_BACKEND_PROFILE_PRESETS
        .filter((preset) => preset !== "native" && preset !== "custom")
        .sort(),
    );
    expect(Object.keys(BACKEND_PRESETS).sort()).toEqual([...BACKEND_PRESET_IDS].sort());
    expect(isBackendPresetId("anthropic-api-key")).toBe(true);
    expect(isBackendPresetId("native")).toBe(false);
    expect(isBackendPresetId("custom")).toBe(false);
    expect(isBackendPresetId(7)).toBe(false);
  });

  it("routes an Anthropic API key through the Claude harness", () => {
    const preset = backendPresetDefinition("anthropic-api-key");
    expect(preset).toMatchObject({
      harnessId: "claude-agent-sdk",
      protocol: "anthropic-messages",
      authenticationMode: "api-key",
      baseUrl: "https://api.anthropic.com",
      displayName: "Anthropic API key",
      providerId: "claude",
    });
    expect(preset.defaultModels.map(({ id }) => id)).toEqual(
      CLAUDE_INTERNAL_TIER_IDS.map((tier) => ANTHROPIC_API_KEY_TIER_MODEL_IDS[tier]),
    );
    expect(Object.keys(ANTHROPIC_API_KEY_TIER_MODEL_IDS)).toEqual([...CLAUDE_INTERNAL_TIER_IDS]);
    expect(preset.defaultModels).toEqual([
      { id: "claude-fable-5-1", displayName: "Claude Fable 5.1" },
      { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" },
      { id: "claude-haiku-5-5", displayName: "Claude Haiku 5.5" },
    ]);
  });

  it("routes an OpenAI API key through the Codex harness", () => {
    expect(backendPresetDefinition("openai-api-key")).toEqual({
      harnessId: "codex-app-server",
      protocol: "openai-responses",
      authenticationMode: "bearer-token",
      baseUrl: "https://api.openai.com/v1",
      displayName: "OpenAI API key",
      providerId: "codex",
      defaultModels: [{ id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" }],
    });
  });

  it("describes the Kimi key route with the built-in Kimi profile values", () => {
    const builtIn = builtInKimiClaudeBackendProfile("secret:kimi-test");
    const preset = backendPresetDefinition("kimi-code");
    expect(builtIn.id).toBe(KIMI_CLAUDE_BUILTIN_PROFILE_ID);
    expect(preset).toMatchObject({
      harnessId: "claude-agent-sdk",
      protocol: builtIn.protocol,
      authenticationMode: builtIn.authenticationMode,
      baseUrl: KIMI_CODING_BASE_URL,
      displayName: builtIn.displayName,
      providerId: "kimi",
    });
    expect(preset.baseUrl).toBe(builtIn.baseUrl);
    expect(preset.defaultModels).toEqual(
      KIMI_CODING_MODELS.map(({ id, displayName }) => ({ id, displayName })),
    );
  });

  it("cannot be mutated by a consumer", () => {
    const preset = backendPresetDefinition("anthropic-api-key");
    expect(Object.isFrozen(BACKEND_PRESETS)).toBe(true);
    expect(Object.isFrozen(preset)).toBe(true);
    expect(Object.isFrozen(preset.defaultModels)).toBe(true);
    expect(Object.isFrozen(preset.defaultModels[0])).toBe(true);
    expect(Object.isFrozen(ANTHROPIC_API_KEY_TIER_MODEL_IDS)).toBe(true);
  });
});
