import { describe, expect, it } from "vitest";

import { promptPresetCommandSchema } from "../../src/shared/contracts/client-command/prompt-presets";
import {
  MAX_PROMPT_PRESET_BODY_CHARS,
  MAX_PROMPT_PRESET_ROUTE_JSON_CHARS,
  promptPresetDraftSchema,
  promptPresetNameFromBody,
  promptPresetRouteMatches,
} from "../../src/shared/prompt-presets";

const route = {
  harnessId: "codex-app-server",
  backendProfileId: "builtin:openai",
  modelId: "gpt-5.6-sol",
  reasoningEffort: "xhigh",
} as const;

function escapedRoute(controlCharacters: number) {
  return {
    harnessId: "h".repeat(200),
    backendProfileId: "b".repeat(200),
    modelId: "m".repeat(300),
    reasoningEffort: "\u0001".repeat(controlCharacters),
  };
}

describe("prompt preset boundary contracts", () => {
  it("accepts only bounded text and the narrow safe route identity", () => {
    expect(promptPresetDraftSchema.parse({
      name: "Review this patch",
      body: "Review the patch for lifecycle races.",
      route,
    })).toEqual({
      name: "Review this patch",
      body: "Review the patch for lifecycle races.",
      route,
    });
    expect(promptPresetDraftSchema.safeParse({
      name: "Leaky route",
      body: "Do work",
      route: {
        ...route,
        providerOptions: { apiKey: "never-store-this" },
      },
    }).success).toBe(false);
    expect(promptPresetDraftSchema.safeParse({
      name: "False Fast route",
      body: "Do work",
      route: {
        ...route,
        harnessId: "cursor-acp",
        backendProfileId: "builtin:cursor",
        fastMode: true,
      },
    }).success).toBe(false);
    expect(promptPresetDraftSchema.safeParse({
      name: "Attachment",
      body: "Do work",
      route: null,
      attachments: [{ path: "/private/attachment.txt" }],
    }).success).toBe(false);
    expect(promptPresetDraftSchema.safeParse({
      name: "Too large",
      body: "x".repeat(MAX_PROMPT_PRESET_BODY_CHARS + 1),
      route: null,
    }).success).toBe(false);
  });

  it("bounds the persisted route JSON after control-character escaping", () => {
    const maximum = escapedRoute(42);
    const overflow = escapedRoute(43);

    expect(Array.from(JSON.stringify(maximum))).toHaveLength(
      MAX_PROMPT_PRESET_ROUTE_JSON_CHARS,
    );
    expect(promptPresetDraftSchema.safeParse({
      name: "Maximum route",
      body: "Keep the exact persisted route bound.",
      route: maximum,
    }).success).toBe(true);
    for (const command of [
      {
        type: "prompt-preset.create",
        payload: {
          name: "Maximum route",
          body: "Accept this create at the shared boundary.",
          route: maximum,
        },
      },
      {
        type: "prompt-preset.update",
        payload: {
          presetId: "22222222-2222-4222-8222-222222222222",
          expectedRevision: 1,
          route: maximum,
        },
      },
    ]) {
      expect(promptPresetCommandSchema.safeParse({
        ...command,
        requestId: "11111111-1111-4111-8111-111111111111",
      }).success).toBe(true);
    }
    expect(Array.from(JSON.stringify(overflow))).toHaveLength(
      MAX_PROMPT_PRESET_ROUTE_JSON_CHARS + 6,
    );
    expect(promptPresetDraftSchema.safeParse({
      name: "Overflow route",
      body: "Reject this before persistence.",
      route: overflow,
    }).success).toBe(false);
  });

  it("validates every mutation payload and rejects unknown privileged fields", () => {
    expect(promptPresetCommandSchema.safeParse({
      type: "prompt-preset.create",
      requestId: "11111111-1111-4111-8111-111111111111",
      payload: {
        name: "Explain",
        body: "Explain this code.",
        route: null,
      },
    }).success).toBe(true);
    expect(promptPresetCommandSchema.safeParse({
      type: "prompt-preset.update",
      requestId: "11111111-1111-4111-8111-111111111111",
      payload: {
        presetId: "22222222-2222-4222-8222-222222222222",
        expectedRevision: 1,
        credential: "not allowed",
      },
    }).success).toBe(false);
    for (const command of [
      {
        type: "prompt-preset.create",
        payload: {
          name: "Escaped overflow",
          body: "Reject this create at the shared boundary.",
          route: escapedRoute(43),
        },
      },
      {
        type: "prompt-preset.update",
        payload: {
          presetId: "22222222-2222-4222-8222-222222222222",
          expectedRevision: 1,
          route: escapedRoute(43),
        },
      },
    ]) {
      expect(promptPresetCommandSchema.safeParse({
        ...command,
        requestId: "11111111-1111-4111-8111-111111111111",
      }).success).toBe(false);
    }
    expect(promptPresetCommandSchema.safeParse({
      type: "prompt-preset.reorder",
      requestId: "11111111-1111-4111-8111-111111111111",
      payload: {
        expectedPresetIds: [],
        presetIds: [
          "22222222-2222-4222-8222-222222222222",
          "22222222-2222-4222-8222-222222222222",
        ],
      },
    }).success).toBe(false);
  });

  it("derives compact names and compares every route identity field", () => {
    expect(promptPresetNameFromBody("  First reusable line  \nSecond"))
      .toBe("First reusable line");
    const unicodeName = promptPresetNameFromBody("🧭".repeat(100));
    expect(unicodeName.at(-2)).not.toMatch(/[\uD800-\uDBFF]/u);
    expect(promptPresetRouteMatches(route, route)).toBe(true);
    expect(promptPresetRouteMatches(route, {
      ...route,
      reasoningEffort: "high",
    })).toBe(false);
    expect(promptPresetRouteMatches(route, {
      ...route,
      fastMode: true,
    })).toBe(false);
    expect(promptPresetDraftSchema.safeParse({
      name: "Fast review",
      body: "Review quickly.",
      route: { ...route, fastMode: true },
    }).success).toBe(true);
  });
});
