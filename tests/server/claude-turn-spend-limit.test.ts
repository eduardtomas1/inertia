import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  modelSelectionSchema,
  providerNativeBackendProfile,
  providerNativeModelSelection,
  resolveHarnessBackendCompatibility,
} from "../../src/shared/model-routing";
import { defaultProjectPreferences } from "../../src/shared/project-preferences";
import { RuntimeStore } from "../../src/server/database";
import { validateProviderRunInput } from "../../src/server/provider/adapters";
import type { ProviderId, ProviderRunInput } from "../../src/server/provider/contracts";
import type { TurnProviderRuntime } from "../../src/server/runtime/turns/turn-controller-types";
import { resolveTurnRequest } from "../../src/server/runtime/turns/turn-request-preparation";
import { nativeProviderRunFields, resolveNativeModelRoute } from "./model-route-fixture";

const directories: string[] = [];
const stores: RuntimeStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

function runInput(
  providerId: ProviderId,
  overrides: Partial<ProviderRunInput> = {},
): ProviderRunInput {
  return {
    ...nativeProviderRunFields(providerId),
    conversationId: "conversation-1",
    runId: "run-1",
    turnId: "turn-1",
    cwd: "/workspace",
    prompt: "Inspect this project",
    interactionMode: "build",
    access: "supervised",
    ...overrides,
  } as ProviderRunInput;
}

function providerInfo(id: ProviderId): ProviderInfo {
  const metadata = {
    freshness: "fresh" as const,
    provenance: "provider" as const,
    updatedAt: "2030-01-01T00:00:00.000Z",
    lastAttemptedAt: "2030-01-01T00:00:00.000Z",
    refreshing: false,
  };
  return {
    id,
    label: id,
    command: id,
    available: true,
    version: "test",
    executable: id,
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [{
      id: `${id}-default`,
      label: `${id} default`,
      description: "Current provider default",
      isDefault: true,
      inputModalities: ["text"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }],
      defaultReasoningEffort: "high",
      fastMode: null,
    }],
    rateLimits: [],
    metadataState: { models: metadata, rateLimits: metadata },
  };
}

async function projectWithLimit(limit: number | null) {
  const directory = await mkdtemp(join(tmpdir(), "inertia-claude-spend-limit-"));
  directories.push(directory);
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  const store = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, {
    recoverInterruptedRuns: false,
  });
  stores.push(store);
  const project = store.createProject("Spend limit", workspace);
  store.updateProject(project.id, {
    preferences: { ...defaultProjectPreferences(), claudeMaxBudgetUsd: limit },
  });
  return { store, project };
}

function resolveFor(
  store: RuntimeStore,
  conversationId: string,
  routing: {
    resolveModelRoute?: TurnProviderRuntime["resolveModelRoute"];
    validateModelSelection?: () => ReturnType<typeof modelSelectionSchema.parse>;
  } = {},
): ProviderRunInput {
  let sequence = 0;
  const providers = {
    resolveModelRoute: routing.resolveModelRoute ?? resolveNativeModelRoute,
    harnessIdFor: (input: ProviderRunInput) => input.harnessId,
  } as unknown as TurnProviderRuntime;
  const resolved = resolveTurnRequest({
    store,
    providers,
    hooks: {
      broadcast: () => undefined,
      broadcastSnapshot: () => undefined,
      providerInfo: () => [providerInfo("claude"), providerInfo("codex")],
      ...(routing.validateModelSelection
        ? { validateModelSelection: routing.validateModelSelection }
        : {}),
    },
    id: () => `spend-limit-${conversationId}-${++sequence}`,
    now: () => "2030-01-01T00:00:00.000Z",
    clock: () => new Date("2030-01-01T00:00:00.000Z"),
  }, {
    conversationId,
    content: "Do the work.",
  });
  return resolved.adopt(store.beginAgentTurn(resolved.input)).active.providerInput;
}

describe("Claude per-turn spend limit", () => {
  it("accepts only a finite positive limit up to 10,000 USD on the run input", () => {
    expect(validateProviderRunInput(runInput("claude"))).toBe("conversation-1");
    for (const maxBudgetUsd of [0.01, 2.5, 10_000]) {
      expect(validateProviderRunInput(runInput("claude", { maxBudgetUsd }))).toBe("conversation-1");
    }
    // Other harnesses ignore the field rather than rejecting the run.
    expect(validateProviderRunInput(runInput("codex", { maxBudgetUsd: 5 }))).toBe("conversation-1");
    for (const maxBudgetUsd of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      10_000.01,
      "5" as unknown as number,
    ]) {
      expect(() => validateProviderRunInput(runInput("claude", { maxBudgetUsd })))
        .toThrow(expect.objectContaining({
          code: "invalid_input",
          message: "The spend limit is invalid.",
        }));
    }
  });

  it("forwards a project's limit only on native Anthropic Claude turns", async () => {
    const { store, project } = await projectWithLimit(2.5);
    const claude = store.createConversation(project.id, "Claude", {
      modelSelection: providerNativeModelSelection({ providerId: "claude" }),
    });
    const claudeInput = resolveFor(store, claude.id);
    expect(claudeInput).toMatchObject({
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      backendProfile: { id: "builtin:anthropic" },
      maxBudgetUsd: 2.5,
    });
    expect(validateProviderRunInput(claudeInput)).toBe(claude.id);

    const codex = store.createConversation(project.id, "Codex", {
      modelSelection: providerNativeModelSelection({ providerId: "codex" }),
    });
    expect(resolveFor(store, codex.id)).not.toHaveProperty("maxBudgetUsd");
  });

  it("omits the limit when the project has none", async () => {
    const { store, project } = await projectWithLimit(null);
    const claude = store.createConversation(project.id, "Claude", {
      modelSelection: providerNativeModelSelection({ providerId: "claude" }),
    });
    expect(resolveFor(store, claude.id)).not.toHaveProperty("maxBudgetUsd");
  });

  it("does not forward the limit to a Claude-compatible custom backend", async () => {
    const { store, project } = await projectWithLimit(2.5);
    const customProfile = {
      ...providerNativeBackendProfile("claude"),
      id: "custom:proxy",
      displayName: "Proxy",
      source: "custom" as const,
      configurationRevision: 1,
      endpointIdentity: "endpoint:proxy",
    };
    const selection = modelSelectionSchema.parse({
      ...providerNativeModelSelection({ providerId: "claude", modelId: "proxy-model" }),
      backendProfileId: customProfile.id,
      backendProfileDisplayName: customProfile.displayName,
      backendConfigurationRevision: 1,
    });
    const conversation = store.createConversation(project.id, "Proxy", {
      modelSelection: selection,
    });
    const compatibility = resolveHarnessBackendCompatibility("claude-agent-sdk", customProfile);
    const input = resolveFor(store, conversation.id, {
      validateModelSelection: () => selection,
      resolveModelRoute: () => ({
        providerId: "claude" as const,
        harnessId: "claude-agent-sdk" as const,
        backendProfile: customProfile,
        compatibility,
        continuationIdentity: continuationIdentityForSelection(
          selection,
          customProfile.endpointIdentity,
          !compatibility.allowsModelSwitchWithinSession,
        ),
      }),
    });
    expect(input.backendProfile.id).toBe("custom:proxy");
    expect(input).not.toHaveProperty("maxBudgetUsd");
  });
});
