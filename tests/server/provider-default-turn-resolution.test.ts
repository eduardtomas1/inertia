import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
import { RuntimeStore } from "../../src/server/database";
import type { ProviderRunInput } from "../../src/server/provider/contracts";
import type {
  TurnControllerHooks,
  TurnProviderRuntime,
} from "../../src/server/runtime/turns/turn-controller-types";
import { resolveTurnRequest } from "../../src/server/runtime/turns/turn-request-preparation";
import { resolveNativeModelRoute } from "./model-route-fixture";

const directories: string[] = [];

function provider(
  modelId: string,
  label: string,
  fastMode: ProviderInfo["models"][number]["fastMode"] = {
    providerValue: "priority",
    label: "Fast",
    description: "Faster responses with increased usage.",
    isDefault: false,
  },
): ProviderInfo {
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
      fastMode,
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
      modelSelection: providerNativeModelSelection({
        providerId: "codex",
        modelId: "provider-default",
        providerOptions: { fastMode: "priority" },
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
      modelSelection: { providerOptions: { fastMode: "priority" } },
    });
    const firstQueued = store.beginAgentTurn(first.input);
    expect(first.adopt(firstQueued).active.providerInput)
      .toMatchObject({
        model: undefined,
        supportedFastMode: "priority",
        modelSelection: {
          modelId: "provider-default",
          providerOptions: { fastMode: "priority" },
        },
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
      supportedFastMode: "priority",
      modelSelection: {
        modelId: "provider-default",
        providerOptions: { fastMode: "priority" },
      },
    });
    expect(store.conversation(conversation.id).modelSelection.modelId)
      .toBe("provider-default");
    store.close();
  });

  it("marks provider-default Fast routes so Standard is forced after restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-provider-default-fast-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const databasePath = join(directory, "runtime.sqlite");
    const createStore = () => new RuntimeStore(databasePath, workspace, {
      recoverInterruptedRuns: false,
    });
    const initial = createStore();
    const project = initial.createProject("Provider default Fast", workspace);
    const conversation = initial.createConversation(project.id, "Standard route", {
      modelSelection: providerNativeModelSelection({
        providerId: "codex",
        modelId: "provider-default",
      }),
    });
    initial.close();

    const restarted = createStore();
    const providers = {
      resolveModelRoute: resolveNativeModelRoute,
      harnessIdFor: (input: ProviderRunInput) => input.harnessId,
    } as unknown as TurnProviderRuntime;
    const resolved = resolveTurnRequest({
      store: restarted,
      providers,
      hooks: {
        broadcast: () => undefined,
        broadcastSnapshot: () => undefined,
        providerInfo: () => [provider("gpt-fast-default", "GPT Fast Default", {
          providerValue: "priority",
          label: "Fast",
          description: "Provider global default is Fast.",
          isDefault: true,
        })],
      },
      id: () => "restart-standard-turn",
      now: () => "2030-01-01T00:00:00.000Z",
      clock: () => new Date("2030-01-01T00:00:00.000Z"),
    }, {
      conversationId: conversation.id,
      content: "Keep this restarted route on Standard.",
    });
    const queued = restarted.beginAgentTurn(resolved.input);
    expect(resolved.adopt(queued).active.providerInput).toMatchObject({
      supportedFastMode: "priority",
      modelSelection: { providerOptions: {} },
    });
    restarted.close();
  });

  it("does not request speed controls on an unsupported provider route", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-provider-no-fast-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const store = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("No Fast support", workspace);
    const conversation = store.createConversation(project.id, "Standard route", {
      modelSelection: providerNativeModelSelection({ providerId: "codex" }),
    });
    const providers = {
      resolveModelRoute: resolveNativeModelRoute,
      harnessIdFor: (input: ProviderRunInput) => input.harnessId,
    } as unknown as TurnProviderRuntime;
    const resolved = resolveTurnRequest({
      store,
      providers,
      hooks: {
        broadcast: () => undefined,
        broadcastSnapshot: () => undefined,
        providerInfo: () => [provider("gpt-old", "GPT Old", null)],
      },
      id: () => "unsupported-standard-turn",
      now: () => "2030-01-01T00:00:00.000Z",
      clock: () => new Date("2030-01-01T00:00:00.000Z"),
    }, {
      conversationId: conversation.id,
      content: "Use the old route without new fields.",
    });
    const queued = store.beginAgentTurn(resolved.input);
    expect(resolved.adopt(queued).active.providerInput)
      .not.toHaveProperty("supportedFastMode");
    store.close();
  });

  it("does not resume a Fast session when Standard is no longer forceable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inertia-provider-lost-fast-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    const store = new RuntimeStore(join(directory, "runtime.sqlite"), workspace, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Lost Fast support", workspace);
    const conversation = store.createConversation(project.id, "Fast route", {
      modelSelection: providerNativeModelSelection({
        providerId: "codex",
        modelId: "gpt-old",
        providerOptions: { fastMode: "priority" },
      }),
    });
    store.updateConversation(conversation.id, {
      providerSessionId: "fast-session",
    });
    store.updateConversation(conversation.id, {
      modelSelection: providerNativeModelSelection({
        providerId: "codex",
        modelId: "gpt-old",
      }),
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
        providerInfo: () => [provider("gpt-old", "GPT Old", null)],
      },
      id: () => "lost-fast-turn",
      now: () => "2030-01-01T00:00:00.000Z",
      clock: () => new Date("2030-01-01T00:00:00.000Z"),
    }, {
      conversationId: conversation.id,
      content: "Do not silently inherit Fast.",
    })).toThrow("Start a new chat to change response speed");
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
      modelSelection: providerNativeModelSelection({ providerId: "codex" }),
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
      ...providerNativeBackendProfile("codex"),
      id: `custom:${state}`,
      displayName: `Custom ${state}`,
      source: "custom" as const,
      configurationRevision: 1,
      endpointIdentity: `endpoint:${state}`,
    };
    const selection = modelSelectionSchema.parse({
      ...providerNativeModelSelection({ providerId: "codex", modelId: "gpt-collision" }),
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
