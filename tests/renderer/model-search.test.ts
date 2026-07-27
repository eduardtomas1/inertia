import { describe, expect, it } from "vitest";

import {
  normalizeModelSearchText,
  searchModelRoutes,
  type ModelSearchRoute,
} from "../../src/renderer/src/utils/modelSearch";

function route(
  input: Partial<ModelSearchRoute> & Pick<ModelSearchRoute, "key" | "displayName" | "modelId">,
): ModelSearchRoute {
  return {
    alias: null,
    harnessId: "codex-app-server",
    harnessLabel: "Codex",
    backendProfileId: "builtin:openai",
    backendProfileName: "OpenAI",
    providerLabel: "Codex",
    source: "built-in",
    routeTerms: [],
    selectable: true,
    unavailableReason: null,
    ...input,
  };
}

const routes = [
  route({
    key: "codex-openai-sol",
    displayName: "GPT-5.6-Sol",
    modelId: "gpt-5.6-sol",
    alias: "Sol",
    routeTerms: ["OpenAI"],
  }),
  route({
    key: "claude-kimi-k3",
    displayName: "Kimi K3",
    modelId: "k3",
    harnessId: "claude-agent-sdk",
    harnessLabel: "Claude",
    backendProfileId: "builtin:kimi-code",
    backendProfileName: "Kimi",
    providerLabel: "Claude",
    routeTerms: ["Kimi", "Moonshot"],
  }),
  route({
    key: "claude-anthropic-sonnet",
    displayName: "Claude Sónnet",
    modelId: "claude-sonnet-4-6",
    harnessId: "claude-agent-sdk",
    harnessLabel: "Claude",
    backendProfileId: "builtin:anthropic",
    backendProfileName: "Anthropic",
    providerLabel: "Claude",
    routeTerms: ["Anthropic"],
  }),
  route({
    key: "claude-custom-model-x",
    displayName: "model-x",
    modelId: "team/model-x-2026",
    alias: "Review model",
    harnessId: "claude-agent-sdk",
    harnessLabel: "Claude",
    backendProfileId: "custom:team-gateway",
    backendProfileName: "Équipe Gateway",
    providerLabel: "Claude",
    source: "custom",
    routeTerms: ["Company inference"],
    selectable: false,
    unavailableReason: "Add an API key.",
  }),
] satisfies ModelSearchRoute[];

describe("model route search", () => {
  it("normalizes case, whitespace, and diacritics with platform APIs", () => {
    expect(normalizeModelSearchText("  CLÁUDE   Sónnet ")).toBe("claude sonnet");
    expect(searchModelRoutes(routes, "claude sonnet").items.map(({ key }) => key))
      .toEqual(["claude-anthropic-sonnet"]);
    expect(searchModelRoutes(routes, "equipe").items.map(({ key }) => key))
      .toEqual(["claude-custom-model-x"]);
  });

  it("matches display names, exact ids, aliases, harnesses, backends, providers, and route terms", () => {
    expect(searchModelRoutes(routes, "GPT-5.6-Sol").items[0]?.key)
      .toBe("codex-openai-sol");
    expect(searchModelRoutes(routes, "team model x 2026").items[0]?.key)
      .toBe("claude-custom-model-x");
    expect(searchModelRoutes(routes, "Review model").items[0]?.key)
      .toBe("claude-custom-model-x");
    expect(searchModelRoutes(routes, "agent sdk").items.map(({ key }) => key)
      .slice(0, 3))
      .toEqual([
        "claude-kimi-k3",
        "claude-anthropic-sonnet",
        "claude-custom-model-x",
      ]);
    expect(searchModelRoutes(routes, "Anthropic").items.map(({ key }) => key))
      .toEqual(["claude-anthropic-sonnet"]);
    expect(searchModelRoutes(routes, "Moonshot").items.map(({ key }) => key))
      .toEqual(["claude-kimi-k3"]);
  });

  it("supports multi-term searches spanning truthful route fields", () => {
    expect(searchModelRoutes(routes, "Claude Kimi K3").items.map(({ key }) => key))
      .toEqual(["claude-kimi-k3"]);
    expect(searchModelRoutes(routes, "custom company model").items.map(({ key }) => key))
      .toEqual(["claude-custom-model-x"]);
    expect(searchModelRoutes(routes, "Codex OpenAI Sol").items.map(({ key }) => key))
      .toEqual(["codex-openai-sol"]);
  });

  it("ranks exact and prefix matches first while retaining provider order for ties", () => {
    const ranked = [
      route({ key: "description", displayName: "Recommended GPT model", modelId: "other" }),
      route({ key: "exact", displayName: "GPT", modelId: "gpt" }),
      route({ key: "prefix-a", displayName: "GPT Alpha", modelId: "gpt-alpha" }),
      route({ key: "prefix-b", displayName: "GPT Beta", modelId: "gpt-beta" }),
    ];

    expect(searchModelRoutes(ranked, "gpt").items.map(({ key }) => key))
      .toEqual(["exact", "prefix-a", "prefix-b", "description"]);
  });

  it("preserves unavailable routes and returns the original objects without mutation", () => {
    const originalOrder = routes.map(({ key }) => key);
    const [result] = searchModelRoutes(routes, "custom").items;

    expect(result).toBe(routes[3]);
    expect(result).toMatchObject({
      selectable: false,
      unavailableReason: "Add an API key.",
    });
    expect(routes.map(({ key }) => key)).toEqual(originalOrder);
  });

  it("preserves input order for an empty query and exposes calm empty states", () => {
    const unfiltered = searchModelRoutes(routes, "   ");
    expect(unfiltered.items.map(({ key }) => key)).toEqual(routes.map(({ key }) => key));
    expect(unfiltered.emptyState).toBeNull();

    expect(searchModelRoutes([], "")).toMatchObject({
      items: [],
      emptyState: {
        kind: "no-models",
        message: "No models are available yet.",
      },
    });
    expect(searchModelRoutes(routes, "nonexistent route")).toMatchObject({
      items: [],
      emptyState: {
        kind: "no-results",
        message: "No models match “nonexistent route”.",
      },
    });
  });
});
