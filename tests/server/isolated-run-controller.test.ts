import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HarnessBackendCompatibility,
  ModelBackendProfile,
  ModelSelection,
  WorkspaceRun,
} from "../../src/shared/contracts";
import type {
  ProviderRunCallbacks,
  ProviderRunInput,
  ProviderRunResult,
} from "../../src/server/providers";
import { providerRunTerminal } from "../../src/server/provider/contracts";
import {
  IsolatedRunController,
  type IsolatedRunFileSystem,
  type IsolatedRunProviderRuntime,
  type IsolatedRunStore,
  isolatedRunSelection,
} from "../../src/server/runtime/reviews/isolated-run-controller";
import { RuntimeStore } from "../../src/server/database";
import {
  continuationIdentityForSelection,
  modelSelectionSchema,
  nativeModelSelection,
  withModelSelectionFastMode,
} from "../../src/shared/model-routing";
import { resolveNativeModelRoute } from "./model-route-fixture";

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeStore implements IsolatedRunStore {
  readonly runs = new Map<string, WorkspaceRun>();
  readonly updates: Array<{ id: string; update: Record<string, unknown> }> = [];
  conversationWorkReserved = false;
  readonly conversationWork = {
    hasConversation: () => this.conversationWorkReserved,
  };

  createWorkspaceRun(
    input: Parameters<IsolatedRunStore["createWorkspaceRun"]>[0],
  ): WorkspaceRun {
    const run: WorkspaceRun = {
      id: input.id ?? crypto.randomUUID(),
      kind: input.kind,
      projectId: input.projectId,
      conversationId: input.conversationId,
      actionId: input.actionId ?? null,
      label: input.label,
      detail: input.detail,
      status: input.status,
      attentionState: input.attentionState ?? "unseen",
      canStop: false,
      port: input.port,
      startedAt: "2030-01-01T00:00:00.000Z",
      finishedAt: null,
    };
    this.runs.set(run.id, run);
    return run;
  }

  updateWorkspaceRun(
    id: string,
    update: Parameters<IsolatedRunStore["updateWorkspaceRun"]>[1],
  ): WorkspaceRun {
    const current = this.runs.get(id);
    if (!current) throw new Error("missing run");
    this.updates.push({ id, update });
    const next = {
      ...current,
      ...update,
      finishedAt: update.status && update.status !== "running" && update.status !== "waiting"
        ? "2030-01-01T00:00:01.000Z"
        : current.finishedAt,
    };
    this.runs.set(id, next);
    return next;
  }
}

class FakeProvider implements IsolatedRunProviderRuntime {
  readonly inputs: ProviderRunInput[] = [];
  readonly callbacks: ProviderRunCallbacks[] = [];
  readonly stops: Array<{
    conversationId: string;
    identity: { runId: string; turnId: string };
    graceMs: number | undefined;
  }> = [];
  readonly pending: Deferred<ProviderRunResult>[] = [];
  settleStop = true;

  resolveModelRoute = resolveNativeModelRoute;

  harnessIdFor(input: ProviderRunInput): string {
    return input.harnessId;
  }

  run(input: ProviderRunInput, callbacks: ProviderRunCallbacks): Promise<ProviderRunResult> {
    this.inputs.push(input);
    this.callbacks.push(callbacks);
    const result = deferred<ProviderRunResult>();
    this.pending.push(result);
    return result.promise;
  }

  isRunning(conversationId: string): boolean {
    return this.inputs.some((input, index) =>
      input.conversationId === conversationId && this.pending[index] !== undefined);
  }

  async stopOwned(
    conversationId: string,
    identity: { runId: string; turnId: string },
    graceMs?: number,
  ): Promise<"settled" | "force-detached"> {
    this.stops.push({ conversationId, identity, graceMs });
    const index = this.inputs.findIndex((input) => input.conversationId === conversationId);
    if (this.settleStop && index >= 0) {
      this.pending[index]?.resolve(resultFor(this.inputs[index]!, "cancelled"));
      return "settled";
    }
    return "force-detached";
  }
}

function resultFor(
  input: ProviderRunInput,
  status: ProviderRunResult["status"] = "completed",
  text = "Answer",
): ProviderRunResult {
  return {
    ...providerRunTerminal(input, status),
    text,
    textTruncated: false,
    exitCode: status === "failed" ? 1 : 0,
    signal: null,
    cleanupConfirmed: true,
  };
}

function ids(): () => string {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
}

function fakeFileSystem(): IsolatedRunFileSystem & {
  create: ReturnType<typeof vi.fn>;
  protect: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  return {
    create: vi.fn(async () => "/tmp/inertia-isolated-test"),
    protect: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
}

function request(
  owner: object,
  overrides: Partial<Parameters<IsolatedRunController<object>["run"]>[0]> = {},
) {
  return {
    kind: "selection-ask" as const,
    projectId: "project-1",
    conversationId: "conversation-1",
    owner,
    selection: {
      modelSelection: nativeModelSelection({
        providerId: "codex",
        modelId: "gpt-test",
        reasoningEffort: "high",
      }),
    },
    request: {
      visibleContent: "What changed?",
      executionPrompt: "HIDDEN_POLICY\nSelected diff",
    },
    label: "Codex · read-only question",
    detail: "src/app.ts · 2 selected lines",
    successDetail: "src/app.ts reviewed without a resumable session",
    toolPolicy: "read-only" as const,
    interactionPolicy: "fail-closed" as const,
    onResult: ({ text }: { text: string }) => text.trim(),
    ...overrides,
  };
}

async function providerStarted(provider: FakeProvider): Promise<void> {
  for (let attempt = 0; attempt < 20 && provider.inputs.length === 0; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(provider.inputs).toHaveLength(1);
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })),
  );
});

describe("IsolatedRunController", () => {
  it("carries advertised native speed support into fresh isolated runs", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const controller = new IsolatedRunController(
      store,
      provider,
      "/private/inertia-data",
      vi.fn(),
      { id: ids(), fileSystem: fakeFileSystem() },
    );
    const selection = isolatedRunSelection({
      modelSelection: nativeModelSelection({
        providerId: "codex",
        modelId: "gpt-test",
      }),
    }, null, {
      id: "codex",
      models: [{
        id: "gpt-test",
        label: "GPT Test",
        description: "Provider-default Fast",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: [],
        defaultReasoningEffort: "",
        fastMode: {
          providerValue: "priority",
          label: "Fast",
          description: "Faster responses",
          isDefault: true,
        },
      }],
    });
    const running = controller.run(request({}, { selection }));
    await providerStarted(provider);
    expect(provider.inputs[0]).toMatchObject({
      supportedFastMode: "priority",
      modelSelection: { providerOptions: {} },
    });
    provider.pending[0]!.resolve(resultFor(
      provider.inputs[0]!,
      "completed",
      "Provider response",
    ));
    await expect(running).resolves.toMatchObject({ value: "Provider response" });
  });

  it("omits Fast when an isolated model override does not advertise it", () => {
    const fastSelection = withModelSelectionFastMode(
      nativeModelSelection({
        providerId: "codex",
        modelId: "gpt-fast",
      }),
      "priority",
    );

    expect(isolatedRunSelection({
      modelSelection: fastSelection,
    }, "gpt-standard", {
      id: "codex",
      models: [{
        id: "gpt-standard",
        label: "GPT Standard",
        description: "Standard-only model",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: [],
        defaultReasoningEffort: "",
        fastMode: null,
      }],
    })).toMatchObject({
      modelSelection: {
        modelId: "gpt-standard",
        providerOptions: {},
      },
    });
  });

  it("omits native speed controls from isolated custom backend routes", () => {
    const custom = modelSelectionSchema.parse({
      ...nativeModelSelection({
        providerId: "codex",
        modelId: "gpt-fast",
      }),
      backendProfileId: "custom:openai",
      backendProfileDisplayName: "Custom OpenAI",
    });

    expect(isolatedRunSelection({
      modelSelection: custom,
    }, null, {
      id: "codex",
      models: [{
        id: "gpt-fast",
        label: "GPT Fast",
        description: "Native catalog model",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: [],
        defaultReasoningEffort: "",
        fastMode: {
          providerValue: "priority",
          label: "Fast",
          description: "Faster responses",
          isDefault: false,
        },
      }],
    })).toEqual(expect.objectContaining({
      modelSelection: expect.objectContaining({ providerOptions: {} }),
    }));
    expect(isolatedRunSelection({
      modelSelection: custom,
    }, null, {
      id: "codex",
      models: [{
        id: "gpt-fast",
        label: "GPT Fast",
        description: "Native catalog model",
        isDefault: true,
        inputModalities: ["text"],
        reasoningOptions: [],
        defaultReasoningEffort: "",
        fastMode: {
          providerValue: "priority",
          label: "Fast",
          description: "Faster responses",
          isDefault: false,
        },
      }],
    })).not.toHaveProperty("supportedFastMode");
  });

  it("rejects another agent task while a resumed terminal owns the conversation", async () => {
    const store = new FakeStore();
    store.conversationWorkReserved = true;
    const provider = new FakeProvider();
    const controller = new IsolatedRunController(
      store,
      provider,
      "/private/inertia-data",
      vi.fn(),
      { id: ids(), fileSystem: fakeFileSystem() },
    );

    await expect(controller.run(request({}))).rejects.toThrow(
      "End the resumed provider terminal",
    );
    expect(provider.inputs).toEqual([]);
    expect(store.runs.size).toBe(0);
  });

  it("uses fresh read-only identities, keeps hidden payload out of WorkspaceRun, and cleans once", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const fileSystem = fakeFileSystem();
    const controller = new IsolatedRunController(
      store,
      provider,
      "/private/inertia-data",
      vi.fn(),
      { id: ids(), fileSystem },
    );
    const owner = {};
    const transcript: string[] = [];
    const running = controller.run(request(owner, {
      onStarted: ({ assertActive }) => {
        assertActive();
        transcript.push("What changed?");
      },
      onResult: ({ text }, { assertActive }) => {
        assertActive();
        transcript.push(text);
        return text.trim();
      },
    }));
    await providerStarted(provider);

    const input = provider.inputs[0]!;
    expect(input).toMatchObject({
      providerId: "codex",
      conversationId: "conversation-1:isolated:00000000-0000-4000-8000-000000000001",
      runId: "00000000-0000-4000-8000-000000000002",
      turnId: "00000000-0000-4000-8000-000000000003",
      cwd: "/tmp/inertia-isolated-test",
      prompt: "HIDDEN_POLICY\nSelected diff",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "plan",
      access: "supervised",
    });
    expect(input).not.toHaveProperty("sessionId");
    expect(JSON.stringify([...store.runs.values()])).not.toContain("HIDDEN_POLICY");
    expect(transcript).toEqual(["What changed?"]);

    provider.callbacks[0]?.onText?.({
      providerId: "codex",
      conversationId: input.conversationId!,
      runId: input.runId!,
      turnId: input.turnId!,
      type: "text",
      text: "Answer",
    });
    provider.pending[0]?.resolve(resultFor(input));
    await expect(running).resolves.toMatchObject({
      text: "Answer",
      value: "Answer",
      harnessId: "codex-app-server",
    });

    expect(store.updates).toEqual([{
      id: "00000000-0000-4000-8000-000000000001",
      update: {
        status: "succeeded",
        detail: "src/app.ts reviewed without a resumable session",
      },
    }]);
    expect(fileSystem.create).toHaveBeenCalledWith(
      join("/private/inertia-data", "isolated-selection-ask-"),
    );
    expect(fileSystem.protect).toHaveBeenCalledOnce();
    expect(fileSystem.remove).toHaveBeenCalledOnce();
    expect(controller.has("conversation-1")).toBe(false);
    expect(transcript).toEqual(["What changed?", "Answer"]);
  });

  it("retains an isolated run whose completed result lacks cleanup proof", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    provider.settleStop = false;
    const fileSystem = fakeFileSystem();
    const onResult = vi.fn(() => "unsafe");
    const controller = new IsolatedRunController(
      store,
      provider,
      "/private/inertia-data",
      vi.fn(),
      { id: ids(), fileSystem },
    );
    const running = controller.run(request({}, { onResult }));
    await providerStarted(provider);
    const input = provider.inputs[0]!;

    provider.pending[0]?.resolve({
      ...resultFor(input),
      cleanupConfirmed: false,
    });

    await expect(running).rejects.toThrow(
      "Provider process cleanup could not be confirmed.",
    );
    expect(onResult).not.toHaveBeenCalled();
    expect(store.updates).toEqual([]);
    expect(fileSystem.remove).not.toHaveBeenCalled();
    expect(controller.has("conversation-1")).toBe(true);
    await expect(controller.run(request({}))).rejects.toThrow(
      "already running for this thread",
    );
    await expect(controller.dispose()).rejects.toThrow(
      "Isolated provider cleanup remains unconfirmed.",
    );
  });

  it("preserves an explicit custom backend route instead of falling back to the native harness backend", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const fileSystem = fakeFileSystem();
    const customSelection = {
      ...nativeModelSelection({
        providerId: "claude",
        modelId: "k3",
        reasoningEffort: "high",
      }),
      backendProfileId: "custom:kimi-test",
      backendProfileDisplayName: "Kimi test",
      backendConfigurationRevision: 7,
    };
    provider.resolveModelRoute = vi.fn((selection: ModelSelection) => {
      const backendProfile: ModelBackendProfile = {
        id: selection.backendProfileId,
        displayName: selection.backendProfileDisplayName,
        protocol: "anthropic-messages",
        authenticationMode: "api-key",
        source: "custom",
        enabled: true,
        configurationRevision: selection.backendConfigurationRevision,
        endpointIdentity: "a".repeat(64),
      };
      const compatibility: HarnessBackendCompatibility = {
        harnessId: "claude-agent-sdk",
        backendProfileId: backendProfile.id,
        backendProtocol: backendProfile.protocol,
        state: "verified",
        provenance: "probe",
        allowsModelSwitchWithinSession: true,
        reasonCode: "anthropic-probe-verified",
        reason: "The isolated test route is verified.",
      };
      return {
        providerId: "claude" as const,
        harnessId: "claude-agent-sdk" as const,
        backendProfile,
        compatibility,
        continuationIdentity: continuationIdentityForSelection(
          selection,
          backendProfile.endpointIdentity,
          !compatibility.allowsModelSwitchWithinSession,
        ),
      };
    });
    const controller = new IsolatedRunController(
      store,
      provider,
      "/private/inertia-data",
      vi.fn(),
      { id: ids(), fileSystem },
    );
    const running = controller.run(request({}, {
      selection: { modelSelection: customSelection },
    }));
    await providerStarted(provider);

    const input = provider.inputs[0]!;
    expect(input).toMatchObject({
      providerId: "claude",
      harnessId: "claude-agent-sdk",
      model: "k3",
      reasoningEffort: "high",
      modelSelection: {
        backendProfileId: "custom:kimi-test",
        backendConfigurationRevision: 7,
      },
      backendProfile: {
        id: "custom:kimi-test",
        displayName: "Kimi test",
      },
    });
    provider.pending[0]?.resolve(resultFor(input));
    await expect(running).resolves.toMatchObject({
      harnessId: "claude-agent-sdk",
      backendProfileId: "custom:kimi-test",
      model: "k3",
      modelSelection: {
        backendProfileId: "custom:kimi-test",
        backendConfigurationRevision: 7,
      },
    });
  });

  it("fails approval and input requests closed with a distinct unsupported state", async () => {
    for (const interaction of ["onApproval", "onInput"] as const) {
      const store = new FakeStore();
      const provider = new FakeProvider();
      const fileSystem = fakeFileSystem();
      const controller = new IsolatedRunController(
        store,
        provider,
        "/data",
        vi.fn(),
        { id: ids(), fileSystem, stopGraceMs: 1 },
      );
      const running = controller.run(request({}));
      await providerStarted(provider);
      const input = provider.inputs[0]!;
      if (interaction === "onApproval") {
        provider.callbacks[0]?.onApproval?.({
          providerId: "codex",
          conversationId: input.conversationId!,
          runId: input.runId!,
          turnId: input.turnId!,
          type: "approval",
          request: {
            requestId: "approval-1",
            kind: "command",
            title: "Write",
            permissionRoots: [],
            availableDecisions: ["deny", "cancel"],
          },
        });
      } else {
        provider.callbacks[0]?.onInput?.({
          providerId: "codex",
          conversationId: input.conversationId!,
          runId: input.runId!,
          turnId: input.turnId!,
          type: "input",
          request: {
            requestId: "input-1",
            questions: [],
            autoResolutionMs: null,
          },
        });
      }
      await expect(running).rejects.toMatchObject({
        reason: "unsupported-interaction",
      });
      expect(provider.stops).toHaveLength(1);
      expect(store.updates[0]?.update).toMatchObject({ status: "failed" });
      expect(fileSystem.remove).toHaveBeenCalledOnce();
    }
  });

  it("times out a never-resolving provider and returns after the bounded owned stop", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const controller = new IsolatedRunController(
      store,
      provider,
      "/data",
      vi.fn(),
      { id: ids(), fileSystem: fakeFileSystem(), defaultTimeoutMs: 5, stopGraceMs: 1 },
    );
    const running = controller.run(request({}));
    await expect(running).rejects.toMatchObject({ reason: "timeout" });
    expect(provider.stops).toHaveLength(1);
    expect(store.updates[0]?.update).toMatchObject({
      status: "failed",
      detail: expect.stringMatching(/timed out/u),
    });
  });

  it("applies the timeout to setup before a provider process exists", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const fileSystem = fakeFileSystem();
    fileSystem.create.mockReturnValue(new Promise<string>(() => undefined));
    const controller = new IsolatedRunController(
      store,
      provider,
      "/data",
      vi.fn(),
      { id: ids(), fileSystem, defaultTimeoutMs: 5, stopGraceMs: 1 },
    );

    await expect(controller.run(request({}))).rejects.toMatchObject({ reason: "timeout" });
    expect(provider.inputs).toEqual([]);
    expect(provider.stops).toEqual([]);
    expect(store.updates).toHaveLength(1);
  });

  it("settles disconnect/cancel races once and removes only the socket owner's task", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const fileSystem = fakeFileSystem();
    const controller = new IsolatedRunController(
      store,
      provider,
      "/data",
      vi.fn(),
      { id: ids(), fileSystem, stopGraceMs: 1 },
    );
    const owner = {};
    const otherOwner = {};
    const running = controller.run(request(owner));
    await providerStarted(provider);

    expect(controller.stopOwned(otherOwner)).toBe(0);
    expect(controller.stopOwned(owner)).toBe(1);
    expect(controller.stopConversation("conversation-1")).toBe(false);
    await expect(running).rejects.toMatchObject({ reason: "disconnected" });
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]?.update).toMatchObject({ status: "cancelled" });
    expect(provider.stops).toHaveLength(1);
    expect(fileSystem.remove).toHaveBeenCalledOnce();
  });

  it("lets disconnect win during asynchronous result validation before persistence", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const fileSystem = fakeFileSystem();
    const controller = new IsolatedRunController(
      store,
      provider,
      "/data",
      vi.fn(),
      { id: ids(), fileSystem, stopGraceMs: 1 },
    );
    const owner = {};
    const validationStarted = deferred<void>();
    const releaseValidation = deferred<void>();
    let persisted = false;
    const running = controller.run(request(owner, {
      onResult: async (_output, { assertActive }) => {
        validationStarted.resolve();
        await releaseValidation.promise;
        assertActive();
        persisted = true;
      },
    }));
    await providerStarted(provider);
    provider.pending[0]?.resolve(resultFor(provider.inputs[0]!));
    await validationStarted.promise;
    expect(controller.stopOwned(owner)).toBe(1);
    releaseValidation.resolve();

    await expect(running).rejects.toMatchObject({ reason: "disconnected" });
    expect(persisted).toBe(false);
    expect(store.updates).toHaveLength(1);
    expect(fileSystem.remove).toHaveBeenCalledOnce();
  });

  it("distinguishes provider failure, provider cancellation, result rejection, and output limits", async () => {
    const scenarios = [
      { status: "failed" as const, expected: "provider-failed" },
      { status: "cancelled" as const, expected: "provider-cancelled" },
    ];
    for (const scenario of scenarios) {
      const provider = new FakeProvider();
      const controller = new IsolatedRunController(
        new FakeStore(),
        provider,
        "/data",
        vi.fn(),
        { id: ids(), fileSystem: fakeFileSystem() },
      );
      const running = controller.run(request({}));
      await providerStarted(provider);
      provider.pending[0]?.resolve(resultFor(provider.inputs[0]!, scenario.status));
      await expect(running).rejects.toMatchObject({ reason: scenario.expected });
    }

    const rejectingProvider = new FakeProvider();
    const rejecting = new IsolatedRunController(
      new FakeStore(),
      rejectingProvider,
      "/data",
      vi.fn(),
      { id: ids(), fileSystem: fakeFileSystem() },
    );
    const rejected = rejecting.run(request({}, {
      onResult: () => { throw new Error("Structured output was invalid."); },
    }));
    await providerStarted(rejectingProvider);
    rejectingProvider.pending[0]?.resolve(resultFor(rejectingProvider.inputs[0]!));
    await expect(rejected).rejects.toMatchObject({
      reason: "result-rejected",
      message: "Structured output was invalid.",
    });
    expect(rejectingProvider.stops).toEqual([]);

    const oversizedProvider = new FakeProvider();
    const oversized = new IsolatedRunController(
      new FakeStore(),
      oversizedProvider,
      "/data",
      vi.fn(),
      { id: ids(), fileSystem: fakeFileSystem() },
    );
    const exceeded = oversized.run(request({}, { outputLimitChars: 4 }));
    await providerStarted(oversizedProvider);
    const input = oversizedProvider.inputs[0]!;
    oversizedProvider.callbacks[0]?.onText?.({
      providerId: "codex",
      conversationId: input.conversationId!,
      runId: input.runId!,
      turnId: input.turnId!,
      type: "text",
      text: "12345",
    });
    await expect(exceeded).rejects.toMatchObject({ reason: "output-limit" });
  });

  it("settles runtime shutdown deterministically and persists interrupted runs after restart", async () => {
    const store = new FakeStore();
    const provider = new FakeProvider();
    const controller = new IsolatedRunController(
      store,
      provider,
      "/data",
      vi.fn(),
      { id: ids(), fileSystem: fakeFileSystem(), stopGraceMs: 1 },
    );
    const running = controller.run(request({}));
    await providerStarted(provider);
    await controller.dispose("runtime-shutdown");
    await expect(running).rejects.toMatchObject({ reason: "runtime-shutdown" });
    expect(store.updates[0]?.update).toMatchObject({ status: "cancelled" });

    const root = await mkdtemp(join(tmpdir(), "inertia-isolated-restart-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "inertia.sqlite");
    const first = new RuntimeStore(databasePath, root);
    const project = first.createProject("Restart project", root);
    const conversation = first.createConversation(project.id, "Restart", {
      providerId: "codex",
    });
    const persisted = first.createWorkspaceRun({
      kind: "agent",
      projectId: project.id,
      conversationId: conversation.id,
      label: "Codex · read-only diff summary",
      detail: "isolated session",
      status: "running",
      port: null,
    });
    first.close();

    const reopened = new RuntimeStore(databasePath, root);
    expect(reopened.workspaceRun(persisted.id)).toMatchObject({
      status: "failed",
      detail: expect.stringMatching(/interrupted/iu),
    });
    reopened.close();
  });
});
