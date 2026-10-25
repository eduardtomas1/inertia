import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ModelChooserRow, modelChooserRowFromRoute, modelChooserSecondaryIdentity } from "../../src/renderer/src/components/ModelChooserRow";
import { searchModelRoutes } from "../../src/renderer/src/utils/modelSearch";
import { composerProviderReady, composerRouteReadiness } from "../../src/renderer/src/utils/composerReadiness";
import { buildComposerModelRoutes, readyModelChooserRoutes } from "../../src/renderer/src/utils/modelChooserRoutes";
import { modelFavoriteKey, resolveModelFavorites } from "../../src/renderer/src/utils/modelFavorites";
import { deriveModelSourceRailItems, filterModelRoutesBySource } from "../../src/renderer/src/utils/modelSourceRail";
import { selectedModelChipGlyph } from "../../src/renderer/src/utils/selectedModelChip";
import { API_KEY_USAGE_UNAVAILABLE, usageQuotaSourceForSelection } from "../../src/renderer/src/utils/usageDisplay";
import type {
  HarnessBackendCompatibility,
  ModelBackendProfileView,
  ProviderInfo,
} from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { backendView } from "./backend-view-fixtures";

function provider(id: ProviderInfo["id"], overrides: Partial<ProviderInfo> = {}): ProviderInfo {
  const metadata = {
    freshness: "fresh" as const,
    provenance: "provider" as const,
    updatedAt: null,
    lastAttemptedAt: null,
    refreshing: false,
  };
  return {
    id,
    label: id === "claude" ? "Claude" : id === "kimi" ? "Kimi Code" : "Codex",
    command: id,
    available: true,
    version: "1.0.0",
    executable: `/usr/local/bin/${id}`,
    installState: "installed",
    authState: "unauthenticated",
    canRun: false,
    statusMessage: null,
    models: [],
    rateLimits: [],
    metadataState: { models: metadata, rateLimits: metadata },
    ...overrides,
  };
}

function compatibility(
  profileId: string,
  state: HarnessBackendCompatibility["state"],
  reason = "The endpoint passed the compatibility probe.",
): HarnessBackendCompatibility {
  return {
    harnessId: "claude-agent-sdk",
    backendProfileId: profileId,
    backendProtocol: "anthropic-messages",
    state,
    provenance: state === "unknown" ? "unknown" : "probe",
    allowsModelSwitchWithinSession: false,
    reasonCode: state === "unknown" ? "probe-required" : state === "unavailable" ? "probe-failed" : "anthropic-probe-verified",
    reason,
  };
}

function anthropicKey(overrides: Partial<ModelBackendProfileView> = {}): ModelBackendProfileView {
  const id = "custom:anthropic";
  return backendView({
    id,
    displayName: "Personal",
    harnessId: "claude-agent-sdk",
    protocol: "anthropic-messages",
    authenticationMode: "api-key",
    source: "custom",
    enabled: true,
    configurationRevision: 3,
    endpointIdentity: "endpoint:anthropic",
    preset: "anthropic-api-key",
    allowInsecureLocalhost: false,
    credentialGeneration: "generation:1",
    models: [
      {
        id: "claude-opus-5-5",
        displayName: "Claude Opus 5.5",
        contextWindowTokens: null,
        reasoningOptions: [],
        capabilities: [],
        compatibility: compatibility(id, "verified"),
        latestProbe: null,
      },
      {
        id: "claude-haiku-5-5",
        displayName: "Claude Haiku 5.5",
        contextWindowTokens: null,
        reasoningOptions: [],
        capabilities: [],
        compatibility: compatibility(id, "unavailable", "Claude Haiku 5.5 is not available to this key."),
        latestProbe: null,
      },
    ],
    routing: { mode: "simple", primaryModelId: "claude-opus-5-5" },
    capabilityHints: [],
    createdAt: "2026-10-24T10:00:00.000Z",
    updatedAt: "2026-10-24T10:00:00.000Z",
    endpointHost: "api.anthropic.com",
    authState: "configured",
    connectionState: "connected",
    compatibility: compatibility(id, "verified"),
    latestProbe: null,
    canDelete: true,
    canDisable: true,
    ...overrides,
  });
}

function nativeClaude(): ModelBackendProfileView {
  return backendView({
    ...anthropicKey(),
    id: "builtin:anthropic",
    displayName: "Anthropic",
    routeKind: "account",
    authenticationMode: "harness-managed",
    source: "built-in",
    preset: "native",
    configurationRevision: 0,
    endpointIdentity: null,
    endpointHost: null,
    authState: "harness-managed",
    canDelete: false,
    canDisable: false,
    models: [{ id: "claude-opus-5-5", displayName: "Claude Opus 5.5", contextWindowTokens: null, reasoningOptions: [], capabilities: [] }],
    compatibility: compatibility("builtin:anthropic", "verified"),
  });
}

function kimiKeyRoute(): ModelBackendProfileView {
  return backendView({
    ...anthropicKey(),
    id: "builtin:kimi-code",
    displayName: "Kimi",
    source: "built-in",
    preset: "kimi-code",
    providerId: "kimi",
    models: [{ id: "kimi-for-coding", displayName: "Kimi for Coding", contextWindowTokens: null, reasoningOptions: [], capabilities: [] }],
    compatibility: compatibility("builtin:kimi-code", "verified"),
  });
}

const current = providerNativeModelSelection({ providerId: "claude" });

describe("API key routes in the model chooser", () => {
  it("offers API key routes when the provider CLI is installed but signed out", () => {
    const routes = buildComposerModelRoutes([provider("claude")], [nativeClaude(), anthropicKey()], current);
    const offered = readyModelChooserRoutes(routes);
    expect(offered.map(({ backendProfileId, modelId }) => `${backendProfileId}/${modelId}`)).toEqual([
      "custom:anthropic/claude-opus-5-5",
      "custom:anthropic/claude-haiku-5-5",
    ]);
    expect(readyModelChooserRoutes(buildComposerModelRoutes(
      [provider("claude", { installState: "not-installed", available: false })],
      [anthropicKey()],
      current,
    ))).toEqual([]);
  });

  it("judges each model on its own compatibility", () => {
    const routes = buildComposerModelRoutes([provider("claude")], [anthropicKey()], current);
    const opus = routes.find(({ modelId }) => modelId === "claude-opus-5-5")!;
    const haiku = routes.find(({ modelId }) => modelId === "claude-haiku-5-5")!;
    expect(opus.selectable).toBe(true);
    expect(haiku.selectable).toBe(false);
    expect(haiku.unavailableReason).toBe("Claude Haiku 5.5 is not available to this key.");
  });

  it("labels key routes by profile name and keeps the account name on account routes", () => {
    const routes = buildComposerModelRoutes(
      [provider("claude", { authState: "authenticated", canRun: true })],
      [nativeClaude(), anthropicKey()],
      current,
      { claude: "Work account" },
    );
    const account = routes.find(({ backendProfileId }) => backendProfileId === "builtin:anthropic")!;
    const key = routes.find(({ backendProfileId }) => backendProfileId === "custom:anthropic")!;
    expect(account.providerLabel).toBe("Work account");
    expect(key.providerLabel).toBe("Personal · API key");
    expect(key.routeKind).toBe("api-key");
    expect(modelChooserSecondaryIdentity(modelChooserRowFromRoute(key, { active: false, favorite: false })))
      .toBe("Claude · Personal · API key");
    const presetNamed = buildComposerModelRoutes([provider("claude")], [anthropicKey({ displayName: "Anthropic API key" })], current)[0]!;
    expect(presetNamed.providerLabel).toBe("Anthropic API key");
  });

  it("lists the API key route beside the account route under its provider", () => {
    const routes = buildComposerModelRoutes(
      [provider("claude", { authState: "authenticated", canRun: true })],
      [nativeClaude(), anthropicKey()],
      current,
    );
    const items = deriveModelSourceRailItems(routes);
    expect(items.map(({ id }) => id)).toEqual(["provider:claude"]);
    expect(filterModelRoutesBySource(routes, { kind: "provider", providerId: "claude" })
      .map(({ backendProfileId }) => backendProfileId)).toContain("custom:anthropic");
  });

  it("groups the Kimi key route under Kimi with the Kimi glyph", () => {
    const routes = buildComposerModelRoutes([provider("claude"), provider("kimi")], [kimiKeyRoute()], current);
    const kimi = routes.find(({ backendProfileId }) => backendProfileId === "builtin:kimi-code")!;
    expect(kimi.sourceProviderId).toBe("kimi");
    expect(kimi.providerId).toBe("claude");
    expect(kimi.providerLabel).toBe("Kimi · API key");
    expect(selectedModelChipGlyph(kimi)).toBe("kimi");
    expect(deriveModelSourceRailItems([kimi]).map(({ id }) => id)).toEqual(["provider:kimi"]);
    expect(filterModelRoutesBySource([kimi], { kind: "provider", providerId: "claude" })).toEqual([]);
  });

  it("keeps custom backends in their own group with the custom glyph", () => {
    const custom = anthropicKey({ preset: "custom", displayName: "Team gateway", id: "custom:team" });
    const route = buildComposerModelRoutes([provider("claude")], [backendView({ ...custom, models: custom.models.map(({ compatibility: _c, latestProbe: _l, ...model }) => model) })], current)[0]!;
    expect(route.sourceProviderId).toBeUndefined();
    expect(selectedModelChipGlyph(route)).toBe("custom");
    expect(deriveModelSourceRailItems([route]).map(({ filter }) => filter.kind)).toEqual(["custom"]);
  });

  it("keeps favorites resolving to the same API key route", () => {
    const routes = buildComposerModelRoutes([provider("claude")], [anthropicKey()], current);
    const favorite = routes[0]!;
    const resolved = resolveModelFavorites([{ ...favorite }], routes);
    expect(resolved[0]?.route).toMatchObject({
      backendProfileId: "custom:anthropic",
      modelId: "claude-opus-5-5",
      routeKind: "api-key",
      selectable: true,
    });
    expect(resolved[0]!.key).toBe(modelFavoriteKey(resolved[0]!.reference));
  });
});

describe("API key routes in the composer", () => {
  const selection = (modelId: string) => ({
    harnessId: "claude-agent-sdk" as const,
    backendProfileId: "custom:anthropic",
    backendProfileDisplayName: "Personal",
    modelId,
  });

  it("sends through an API key while the account is signed out", () => {
    expect(composerRouteReadiness({
      provider: provider("claude"),
      profile: anthropicKey(),
      selection: selection("claude-opus-5-5"),
    })).toEqual({ ready: true });
    expect(composerProviderReady(provider("claude"), anthropicKey(), "claude-opus-5-5")).toBe(true);
    expect(composerProviderReady(provider("claude"), anthropicKey(), "claude-haiku-5-5")).toBe(false);
  });

  it("judges the selected model rather than the profile", () => {
    expect(composerRouteReadiness({
      provider: provider("claude"),
      profile: anthropicKey(),
      selection: selection("claude-haiku-5-5"),
    })).toMatchObject({ ready: false, action: "probe", detail: "Claude Haiku 5.5 is not available to this key." });
  });

  it("never blocks a usable model while the backend renews in the background", () => {
    expect(composerRouteReadiness({
      provider: provider("claude"),
      profile: anthropicKey({ renewing: true }),
      selection: selection("claude-opus-5-5"),
    })).toEqual({ ready: true });
  });

  it("shows Checking the backend only while a renewal runs for a model that is not usable yet", () => {
    expect(composerRouteReadiness({
      provider: provider("claude"),
      profile: anthropicKey({ renewing: true }),
      selection: selection("claude-haiku-5-5"),
    })).toMatchObject({ ready: false, transient: true, title: "Checking the backend…", action: null });
    expect(composerRouteReadiness({
      provider: provider("claude"),
      profile: anthropicKey({ renewing: false }),
      selection: selection("claude-haiku-5-5"),
    })).toMatchObject({ ready: false, action: "probe", badge: "Test failed" });
    expect(composerRouteReadiness({
      provider: provider("claude"),
      profile: { ...anthropicKey(), connectionState: "testing" },
      selection: selection("claude-opus-5-5"),
    })).toMatchObject({ ready: false, transient: true, title: "Checking the backend…" });
  });

  it("lets stale or untested evidence through so the runtime can check it before sending", () => {
    const stale = anthropicKey();
    const models = stale.models.map((model) => ({
      ...model,
      compatibility: { ...model.compatibility, state: "unknown" as const, reasonCode: "probe-stale" as const },
    }));
    const route = buildComposerModelRoutes([provider("claude")], [{ ...stale, models }], current)[0]!;
    expect(route.selectable).toBe(true);
    expect(composerRouteReadiness({
      provider: provider("claude"),
      profile: { ...stale, models },
      selection: selection("claude-opus-5-5"),
    })).toEqual({ ready: true });
    expect(composerRouteReadiness({
      provider: provider("claude"),
      profile: { ...stale, models, authState: "missing" },
      selection: selection("claude-opus-5-5"),
    })).toMatchObject({ ready: false, action: "add-key" });
  });

  it("names Accounts and API keys in repair copy", () => {
    expect(composerRouteReadiness({
      provider: provider("claude"),
      profile: { ...anthropicKey(), enabled: false },
      selection: selection("claude-opus-5-5"),
    })).toMatchObject({ detail: "Turn it on in Settings → Agents → Accounts and API keys." });
    expect(composerRouteReadiness({
      provider: provider("claude"),
      profile: { ...anthropicKey(), authState: "missing" },
      selection: selection("claude-opus-5-5"),
    })).toMatchObject({ action: "add-key", detail: "Add the API key in Settings → Agents → Accounts and API keys." });
  });

  it("says usage is not available for API keys", () => {
    expect(usageQuotaSourceForSelection({ backendProfileId: "custom:anthropic" }, anthropicKey())).toBe("api-key");
    expect(usageQuotaSourceForSelection({ backendProfileId: "builtin:anthropic" }, nativeClaude())).toBe("selected-route");
    expect(API_KEY_USAGE_UNAVAILABLE).toBe("Usage is not available for API keys.");
  });
});

function rowText(route: ReturnType<typeof buildComposerModelRoutes>[number]): string {
  const html = renderToStaticMarkup(createElement(ModelChooserRow, {
    row: modelChooserRowFromRoute(route, { active: false, favorite: false }),
    onSelect: () => undefined,
  }));
  return html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
}

describe("API key rows in the model chooser", () => {
  it("names every API key route as an API key instead of marking it Custom", () => {
    const custom = buildComposerModelRoutes(
      [provider("claude")],
      [anthropicKey({ preset: "custom", displayName: "Anthropic API key" })],
      current,
    )[0]!;
    const text = rowText(custom);
    expect(text).toContain("Claude Opus 5.5");
    expect(text).toContain("Claude harness · Anthropic API key");
    expect(text).not.toMatch(/API key · API key/u);
    expect(text).not.toContain("Custom");
    expect(selectedModelChipGlyph(custom)).toBe("custom");

    const gateway = buildComposerModelRoutes(
      [provider("claude")],
      [anthropicKey({ preset: "custom", displayName: "Team gateway" })],
      current,
    )[0]!;
    expect(rowText(gateway)).toContain("Claude harness · Team gateway · API key");

    const open = buildComposerModelRoutes(
      [provider("codex")],
      [anthropicKey({ preset: "custom", displayName: "Open gateway", authenticationMode: "none", harnessId: "codex-app-server", protocol: "openai-responses" })],
      current,
    )[0]!;
    expect(rowText(open)).toContain("Custom");
    expect(rowText(open)).not.toContain("API key");
  });

  it("ranks the named provider's own routes above routes that only share its harness", () => {
    const routes = buildComposerModelRoutes(
      [provider("claude", { authState: "authenticated", canRun: true }), provider("kimi")],
      [nativeClaude(), kimiKeyRoute(), anthropicKey({ preset: "custom", displayName: "Anthropic API key" })],
      current,
    );
    const order = searchModelRoutes(routes, "Claude").items
      .map(({ backendProfileId, modelId }) => `${backendProfileId}/${modelId}`);
    expect(order.indexOf("builtin:anthropic/provider-default")).toBe(0);
    const lastClaude = Math.max(
      order.indexOf("custom:anthropic/claude-opus-5-5"),
      order.indexOf("builtin:anthropic/claude-opus-5-5"),
    );
    expect(lastClaude).toBeLessThan(order.indexOf("builtin:kimi-code/kimi-for-coding"));
  });

  it("keeps favorites ahead of the provider ranking", () => {
    const routes = buildComposerModelRoutes(
      [provider("claude", { authState: "authenticated", canRun: true }), provider("kimi")],
      [nativeClaude(), kimiKeyRoute(), anthropicKey({ preset: "custom", displayName: "Anthropic API key" })],
      current,
    );
    const kimi = routes.find(({ backendProfileId }) => backendProfileId === "builtin:kimi-code")!;
    const items = searchModelRoutes(routes, "claude", { pinned: (route) => route.key === kimi.key }).items;
    expect(items[0]?.key).toBe(kimi.key);
    expect(items[1]?.modelId).toBe("provider-default");
  });

  it("keeps ordinary ranking when the query names no provider", () => {
    const routes = buildComposerModelRoutes(
      [provider("claude"), provider("kimi")],
      [kimiKeyRoute(), anthropicKey({ preset: "custom", displayName: "Anthropic API key" })],
      current,
    );
    expect(searchModelRoutes(routes, "kimi for coding").items[0]?.modelId).toBe("kimi-for-coding");
    expect(searchModelRoutes(routes, "opus").items[0]?.modelId).toBe("claude-opus-5-5");
  });
});

describe("keyless Claude-compatible routes", () => {
  const message = "Add an API key or bearer token to use this backend.";
  function keyless(): ModelBackendProfileView {
    const key = anthropicKey({ preset: "custom", displayName: "Open gateway", authenticationMode: "none", authState: "not-required" });
    const refused = { ...key.compatibility, state: "unavailable" as const, provenance: "built-in" as const, reasonCode: "credential-required" as const, reason: message };
    return {
      ...key,
      routeKind: "api-key",
      compatibility: refused,
      models: key.models.map((model) => ({ ...model, compatibility: refused })),
    };
  }

  it("shows the credential message in the chooser and asks for a key in the composer", () => {
    const route = buildComposerModelRoutes([provider("claude")], [keyless()], current)[0]!;
    expect(route.selectable).toBe(false);
    expect(route.unavailableReason).toBe(message);
    expect(composerRouteReadiness({
      provider: provider("claude"),
      profile: keyless(),
      selection: {
        harnessId: "claude-agent-sdk",
        backendProfileId: "custom:anthropic",
        backendProfileDisplayName: "Open gateway",
        modelId: "claude-opus-5-5",
      },
    })).toMatchObject({ ready: false, badge: "Key missing", detail: message, action: "add-key" });
  });
});
