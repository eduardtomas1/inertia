import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderInfo } from "../../src/shared/contracts";
import {
  continuationIdentityForSelection,
  modelSelectionSchema,
  nativeBackendProfile,
  nativeModelSelection,
  resolveHarnessBackendCompatibility,
} from "../../src/shared/model-routing";
import { RuntimeStore } from "../../src/server/database";
import type { ProviderRunInput } from "../../src/server/provider/contracts";
import type {
  TurnControllerHooks,
  TurnProviderRuntime,
} from "../../src/server/runtime/turns/turn-controller-types";
import { resolveTurnRequest } from "../../src/server/runtime/turns/turn-request-preparation";
import { resolveNativeModelRoute } from "./model-route-fixture";

const directories: string[] = [];

function provider(modelId: string, label: string): ProviderInfo {
  const metadata = {
    freshness: "fresh" as const,
    provenance: "provider" as const,
    updatedAt: "2030-01-01T00:00:00.000Z",
    lastAttemptedAt: "2030-01-01T00:00:00.000Z",
    refreshing: false,
  };
  return {
    id: "codex",
    label: "Codex",
    command: "codex",
    available: true,
    version: "test",
    executable: "codex",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [{
      id: modelId,
      label,
      description: "Current provider default",
      isDefault: true,
      inputModalities: ["text"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }],
      defaultReasoningEffort: "high",
    }],
    rateLimits: [],
    metadataState: { models: metadata, rateLimits: metadata },
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("provider-default turn resolution", () => {
  it("leaves provider requests unpinned and records the concrete model per turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-provider-default-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const store = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Provider default", workspace);
    const conversation = store.createConversation(project.id, "Default route", {
      modelSelection: nativeModelSelection({
        providerId: "codex",
        modelId: "provider-default",
      }),
    });
    let providerInfo = provider("gpt-first", "GPT First");
    let sequence = 0;
    const providers = {
      resolveModelRoute: resolveNativeModelRoute,
      harnessIdFor: (input: ProviderRunInput) => input.harnessId,
    } as unknown as TurnProviderRuntime;
    const hooks = {
      broadcast: () => undefined,
      broadcastSnapshot: () => undefined,
      providerInfo: () => [providerInfo],
    } satisfies TurnControllerHooks;
    const dependencies = {
      store,
      providers,
      hooks,
      id: () => `turn-resolution-${++sequence}`,
      now: () => "2030-01-01T00:00:00.000Z",
      clock: () => new Date("2030-01-01T00:00:00.000Z"),
    };

    const first = resolveTurnRequest(dependencies, {
      conversationId: conversation.id,
      content: "Use the first default.",
    });
    expect(first.input).toMatchObject({
      model: "gpt-first",
      modelAlias: "GPT First",
      reasoningEffort: "high",
    });
    const firstQueued = store.beginAgentTurn(first.input);
    expect(first.adopt(firstQueued).active.providerInput)
      .toMatchObject({
        model: undefined,
        modelSelection: { modelId: "provider-default" },
      });

    providerInfo = provider("gpt-next", "GPT Next");
    const second = resolveTurnRequest(dependencies, {
      conversationId: conversation.id,
      content: "Use the next default.",
    });
    expect(second.input).toMatchObject({
      model: "gpt-next",
      modelAlias: "GPT Next",
      reasoningEffort: "high",
    });
    expect(second.adopt(firstQueued).active.providerInput).toMatchObject({
      model: undefined,
      modelSelection: { modelId: "provider-default" },
    });
    expect(store.conversation(conversation.id).modelSelection.modelId)
      .toBe("provider-default");
    store.close();
  });

  it("rejects scanned pages when the exact provider-default catalog loses image support", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-provider-image-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const image = join(workspace, "scan.jpg");
    await writeFile(image, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const store = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Provider default", workspace);
    const conversation = store.createConversation(project.id, "Default route", {
      modelSelection: nativeModelSelection({ providerId: "codex" }),
    });
    const providers = {
      resolveModelRoute: resolveNativeModelRoute,
      harnessIdFor: (input: ProviderRunInput) => input.harnessId,
    } as unknown as TurnProviderRuntime;

    expect(() => resolveTurnRequest({
      store,
      providers,
      hooks: {
        broadcast: () => undefined,
        broadcastSnapshot: () => undefined,
        providerInfo: () => [provider("gpt-default", "GPT Default")],
      },
      id: () => "exact-provider-image",
      now: () => "2030-01-01T00:00:00.000Z",
      clock: () => new Date("2030-01-01T00:00:00.000Z"),
    }, {
      conversationId: conversation.id,
      content: "Inspect this scan.",
      imagePaths: [image],
      generatedAttachmentPaths: [image],
    })).toThrow("cannot inspect scanned PDF page images");
    expect(store.agentTurnsForConversation(conversation.id)).toEqual([]);
    store.close();
  });

  it.each([
    { state: "verified" as const, accepted: true },
    { state: "unknown" as const, accepted: false },
  ])("uses exact external '$state' image evidence instead of a native catalog ID collision", async ({
    state,
    accepted,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-external-image-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const image = join(workspace, "scan.jpg");
    await writeFile(image, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const customProfile = {
      ...nativeBackendProfile("codex"),
      id: `custom:${state}`,
      displayName: `Custom ${state}`,
      source: "custom" as const,
      configurationRevision: 1,
      endpointIdentity: `endpoint:${state}`,
    };
    const selection = modelSelectionSchema.parse({
      ...nativeModelSelection({ providerId: "codex", modelId: "gpt-collision" }),
      backendProfileId: customProfile.id,
      backendProfileDisplayName: customProfile.displayName,
      backendConfigurationRevision: 1,
      capabilities: [{
        id: "images",
        state,
        provenance: state === "verified" ? "probe" : "unknown",
        detail: null,
      }],
    });
    const store = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("External", workspace);
    const conversation = store.createConversation(project.id, "External route", {
      modelSelection: selection,
    });
    const compatibility = resolveHarnessBackendCompatibility(
      "codex-app-server",
      customProfile,
    );
    const providers = {
      resolveModelRoute: () => ({
        providerId: "codex" as const,
        harnessId: "codex-app-server" as const,
        backendProfile: customProfile,
        compatibility,
        continuationIdentity: continuationIdentityForSelection(
          selection,
          customProfile.endpointIdentity,
          !compatibility.allowsModelSwitchWithinSession,
        ),
      }),
      harnessIdFor: (input: ProviderRunInput) => input.harnessId,
    } as unknown as TurnProviderRuntime;
    const resolve = () => resolveTurnRequest({
      store,
      providers,
      hooks: {
        broadcast: () => undefined,
        broadcastSnapshot: () => undefined,
        providerInfo: () => [provider("gpt-collision", "Native collision")],
        validateModelSelection: () => selection,
      },
      id: () => `exact-external-${state}`,
      now: () => "2030-01-01T00:00:00.000Z",
      clock: () => new Date("2030-01-01T00:00:00.000Z"),
    }, {
      conversationId: conversation.id,
      content: "Inspect this external scan.",
      imagePaths: [image],
      generatedAttachmentPaths: [image],
    });

    if (accepted) expect(resolve).not.toThrow();
    else expect(resolve).toThrow("cannot inspect scanned PDF page images");
    store.close();
  });
});
