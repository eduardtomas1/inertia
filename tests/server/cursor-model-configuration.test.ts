// @inertia-test-suite portable
import { resolve } from "node:path";

import type { ClientContext, SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ProviderInfo, ProviderModel } from "../../src/shared/contracts";
import { providerNativeModelSelection } from "../../src/shared/model-routing";
import { resolveComposerRouteState } from "../../src/renderer/src/utils/composerRouteState";
import { createAgentHarnessEmitter } from "../../src/server/provider/agent-harness";
import { emitCursorMetadata } from "../../src/server/provider/cursor-acp-metadata";
import { configureCursorSession } from "../../src/server/provider/cursor-acp-session";
import { emitKimiMetadata } from "../../src/server/provider/kimi-acp-projection";
import {
  ProviderMetadataCache,
  type PersistedProviderMetadata,
} from "../../src/server/provider/metadata";

function configuration(currentValue: string): SessionConfigOption[] {
  return [{
    id: "model", name: "Model", category: "model", type: "select", currentValue,
    options: [{ value: "reasoner", name: "Reasoner" }, { value: "plain", name: "Plain" }],
  }, ...(currentValue === "reasoner" ? [{
    id: "effort", name: "Effort", category: "thought_level", type: "select" as const,
    currentValue: "high", options: [{ value: "high", name: "High" }],
  }] : [])];
}

function models(
  options: SessionConfigOption[],
  providerId: "cursor" | "kimi" = "cursor",
): ProviderModel[] {
  let result: ProviderModel[] = [];
  const emitter = createAgentHarnessEmitter(providerId, "chat", {
    onEvent: (event) => {
      if (event.type === "extension" && event.event.type === "metadata") {
        result = event.event.metadata.models ?? [];
      }
    },
  }, "run", "turn");
  (providerId === "cursor" ? emitCursorMetadata : emitKimiMetadata)(options, false, emitter);
  return result;
}

function sharedCatalog(currentValue: string): SessionConfigOption[] {
  return [{
    id: "model", name: "Model", category: "model", type: "select", currentValue,
    options: [{ value: "reasoner-a", name: "A" }, { value: "reasoner-b", name: "B" }],
  }, {
    id: "effort", name: "Effort", category: "thought_level", type: "select",
    currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }],
  }];
}

function provider(providerId: "cursor" | "kimi", models: ProviderModel[]): ProviderInfo {
  const fresh = { freshness: "fresh" as const, provenance: "session" as const, updatedAt: null, lastAttemptedAt: null, refreshing: false };
  return {
    id: providerId, label: providerId, command: providerId, available: true, version: "1.0.0",
    executable: `/opt/bin/${providerId}`, installState: "installed", authState: "authenticated",
    canRun: true, statusMessage: "Connected", models, rateLimits: [],
    metadataState: { models: fresh, rateLimits: { ...fresh, freshness: "unavailable", provenance: null } },
  } as ProviderInfo;
}

function persistedCache() {
  let persisted: PersistedProviderMetadata | undefined;
  const persistence = {
    load: () => persisted ? [persisted] : [],
    save: (metadata: PersistedProviderMetadata) => { persisted = structuredClone(metadata); },
  };
  return () => new ProviderMetadataCache({ persistence });
}

describe("Cursor model-scoped configuration", () => {
  it("only advertises effort for the model whose session options were observed", () => {
    expect(models(configuration("reasoner"))).toMatchObject([
      { id: "reasoner", reasoningOptions: [{ value: "high" }], defaultReasoningEffort: "high" },
      { id: "plain", reasoningOptions: [], defaultReasoningEffort: "" },
    ]);
    expect(models(configuration("plain"))).toMatchObject([
      { id: "reasoner", reasoningOptions: [], defaultReasoningEffort: "" },
      { id: "plain", reasoningOptions: [], defaultReasoningEffort: "" },
    ]);
  });

  it("can select a model without thinking using its advertised default", async () => {
    const initial = configuration("reasoner");
    const selected = models(initial).find(({ id }) => id === "plain")!;
    const request = vi.fn(async () => ({ configOptions: configuration("plain") }));
    const result = await configureCursorSession(
      { request } as unknown as ClientContext,
      "session", null, initial, "build", selected.id, selected.defaultReasoningEffort,
    );
    expect(result).toEqual(configuration("plain"));
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]).toBeDefined();
  });

  it("still rejects an explicitly requested effort missing from the new model", async () => {
    const request = vi.fn(async () => ({ configOptions: configuration("plain") }));
    await expect(configureCursorSession(
      { request } as unknown as ClientContext,
      "session", null, configuration("reasoner"), "build", "plain", "high",
    )).rejects.toThrow("does not advertise the selected reasoning effort");
  });
});

describe.each(["cursor", "kimi"] as const)("%s session reasoning across chats", (providerId) => {
  const executable = resolve("session reasoning fixture", providerId);
  const high = [{ value: "low" }, { value: "high" }];

  it("keeps a saved effort usable after another chat reports a different model", () => {
    const cache = new ProviderMetadataCache({});
    cache.learn(providerId, executable, { models: models(sharedCatalog("reasoner-b"), providerId) }, "session");
    const chatB = { ...providerNativeModelSelection({ providerId, modelId: "reasoner-b" }), reasoningEffort: "high" };
    const readiness = () => resolveComposerRouteState({
      conversationProviderId: providerId, selection: chatB,
      providers: [provider(providerId, cache.current(providerId).models)], profiles: [],
    }).readiness;
    expect(readiness()).toMatchObject({ ready: true });

    cache.learn(providerId, executable, { models: models(sharedCatalog("reasoner-a"), providerId) }, "session");
    expect(readiness()).toMatchObject({ ready: true });
    expect(cache.current(providerId).models).toMatchObject([
      { id: "reasoner-a", isDefault: true, reasoningOptions: high, defaultReasoningEffort: "high" },
      { id: "reasoner-b", isDefault: false, reasoningOptions: high, defaultReasoningEffort: "high" },
    ]);
  });

  it("replaces only the observed model's options and keeps the rest across restart", () => {
    const open = persistedCache();
    const cache = open();
    cache.learn(providerId, executable, { models: models(sharedCatalog("reasoner-b"), providerId) }, "session");
    const plain = sharedCatalog("reasoner-a").slice(0, 1);
    cache.learn(providerId, executable, { models: models(plain, providerId) }, "session");
    const expected = [
      { id: "reasoner-a", reasoningOptions: [], defaultReasoningEffort: "" },
      { id: "reasoner-b", reasoningOptions: high, defaultReasoningEffort: "high" },
    ];
    expect(cache.current(providerId).models).toMatchObject(expected);
    expect(open().current(providerId).models).toMatchObject(expected);
  });
});
