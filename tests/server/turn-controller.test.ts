import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentInputRequest,
  AgentPlan,
  ProviderInfo,
  ServerEvent,
} from "../../src/shared/contracts";
import { RuntimeStore } from "../../src/server/database";
import type {
  ProviderEvent,
  ProviderRunCallbacks,
  ProviderRunInput,
  ProviderRunResult,
} from "../../src/server/provider/contracts";
import {
  TurnController,
  type TurnControllerHooks,
  type TurnProviderRuntime,
  type TurnTimerScheduler,
} from "../../src/server/runtime/turns/turn-controller";
import { recoverInterruptedTurns } from "../../src/server/runtime/turns/turn-recovery";
import { resolveNativeModelRoute } from "./model-route-fixture";

const directories: string[] = [];

class FakeScheduler implements TurnTimerScheduler {
  private nextId = 0;
  readonly callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void): number {
    const id = ++this.nextId;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  runAll(): void {
    for (const [id, callback] of [...this.callbacks]) {
      this.callbacks.delete(id);
      callback();
    }
  }
}

class FakeProvider implements TurnProviderRuntime {
  callbacks: ProviderRunCallbacks | null = null;
  input: ProviderRunInput | null = null;
  cancelCount = 0;
  disposed = false;
  approvalSupported = true;
  inputSupported = true;
  private resolveResult: ((result: ProviderRunResult) => void) | null = null;
  private rejectResult: ((error: unknown) => void) | null = null;

  resolveModelRoute = resolveNativeModelRoute;

  harnessIdFor(input: ProviderRunInput): string {
    return input.harnessId;
  }

  run(input: ProviderRunInput, callbacks: ProviderRunCallbacks): Promise<ProviderRunResult> {
    this.input = input;
    this.callbacks = callbacks;
    return new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
  }

  emit(event: ProviderEvent): void {
    this.callbacks?.onEvent?.(event);
  }

  resolve(result: Partial<ProviderRunResult> = {}): void {
    if (!this.input) throw new Error("Provider has not started.");
    this.resolveResult?.({
      providerId: this.input.providerId,
      conversationId: this.input.conversationId ?? this.input.threadId,
      status: "completed",
      text: "",
      textTruncated: false,
      exitCode: 0,
      signal: null,
      ...result,
    });
  }

  reject(error: unknown): void {
    this.rejectResult?.(error);
  }

  cancel(): boolean {
    this.cancelCount += 1;
    return true;
  }

  isRunning(): boolean {
    return this.callbacks !== null;
  }

  respondToApproval(
    _conversationId: string,
    _requestId: string,
    _decision: AgentApprovalDecision,
  ): boolean {
    return this.approvalSupported;
  }

  respondToInput(): boolean {
    return this.inputSupported;
  }

  async disposeAll(): Promise<void> {
    this.disposed = true;
  }
}

function providerInfo(): ProviderInfo {
  const field = {
    freshness: "fresh" as const,
    provenance: "provider" as const,
    updatedAt: "2030-01-01T00:00:00.000Z",
    lastAttemptedAt: "2030-01-01T00:00:00.000Z",
    refreshing: false,
  };
  return {
    id: "codex",
    label: "Codex",
    command: "fake-codex",
    available: true,
    version: "test",
    executable: "fake-codex",
    installState: "installed",
    authState: "authenticated",
    canRun: true,
    statusMessage: null,
    models: [{
      id: "gpt-test",
      label: "GPT Test",
      description: "Fake model",
      isDefault: true,
      inputModalities: ["text", "image"],
      reasoningOptions: [{ value: "high", label: "High", description: "" }],
      defaultReasoningEffort: "high",
    }],
    rateLimits: [],
    metadataState: { models: field, rateLimits: field },
  };
}

interface TestRuntime {
  directory: string;
  workspace: string;
  store: RuntimeStore;
  provider: FakeProvider;
  scheduler: FakeScheduler;
  controller: TurnController;
  conversationId: string;
  events: ServerEvent[];
  settled: string[];
  gitArtifacts: string[];
  metadataRefreshes: string[];
}

async function testRuntime(hookOverrides: Partial<TurnControllerHooks> = {}): Promise<TestRuntime> {
  const directory = await mkdtemp(join(tmpdir(), "inertia-turn-controller-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  directories.push(directory);
  const store = new RuntimeStore(
    join(directory, "inertia.sqlite"),
    workspace,
    { recoverInterruptedRuns: false },
  );
  const project = store.createProject("Turn project", workspace);
  const conversation = store.createConversation(project.id, "Turn conversation", {
    providerId: "codex",
    model: "gpt-test",
    reasoningEffort: "high",
    interactionMode: "build",
    accessMode: "supervised",
  });
  const provider = new FakeProvider();
  const scheduler = new FakeScheduler();
  const events: ServerEvent[] = [];
  const settled: string[] = [];
  const gitArtifacts: string[] = [];
  const metadataRefreshes: string[] = [];
  const pendingApprovals = new Map<string, AgentApprovalRequest>();
  const pendingInputs = new Map<string, AgentInputRequest>();
  const plans = new Map<string, AgentPlan>();
  let sequence = 0;
  let clockMs = Date.parse("2030-01-01T00:00:00.000Z");
  const controller = new TurnController(
    store,
    provider,
    pendingApprovals,
    pendingInputs,
    plans,
    {
      broadcast: (event) => events.push(event),
      broadcastSnapshot: () => undefined,
      providerInfo: () => [providerInfo()],
      captureStructuredContext: ({ content }) => ({ visibleRequest: content }),
      onStructuredContextCaptured: ({ turn }) => {
        settled.push(`context:${turn.id}`);
      },
      captureGitArtifacts: ({ turn }) => {
        gitArtifacts.push(turn.id);
      },
      refreshProviderMetadata: ({ turnId }) => {
        metadataRefreshes.push(turnId);
      },
      onTurnSettled: (turn) => {
        settled.push(`${turn.status}:${turn.id}`);
      },
      ...hookOverrides,
    },
    {
      scheduler,
      clock: () => new Date(clockMs++),
      id: () => `controller-id-${++sequence}`,
      turnTimeoutMs: 1_000,
    },
  );
  return {
    directory,
    workspace,
    store,
    provider,
    scheduler,
    controller,
    conversationId: conversation.id,
    events,
    settled,
    gitArtifacts,
    metadataRefreshes,
  };
}

function identity(runtime: TestRuntime) {
  const input = runtime.provider.input;
  if (!input?.runId || !input.turnId) throw new Error("Turn is not started.");
  return {
    providerId: input.providerId,
    conversationId: runtime.conversationId,
    runId: input.runId,
    turnId: input.turnId,
  } as const;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("TurnController authoritative lifecycle", () => {
  it("gates provider start and terminal settlement on exact Git capture without opening a stale-turn window", async () => {
    let resolveBefore!: () => void;
    let resolveAfter!: () => void;
    const runtime = await testRuntime({
      captureGitBefore: () => new Promise<void>((resolve) => {
        resolveBefore = resolve;
      }),
      captureGitArtifacts: () => new Promise<void>((resolve) => {
        resolveAfter = resolve;
      }),
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Capture this exact turn.",
    });
    expect(runtime.controller.start(queued.turn.id)).toBe(true);
    expect(runtime.provider.input).toBeNull();

    resolveBefore();
    await flushPromises();
    expect(runtime.provider.input?.turnId).toBe(queued.turn.id);
    runtime.provider.resolve({ status: "completed", text: "Captured." });
    await flushPromises();

    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("running");
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(true);
    expect(() => runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "This must not overtake post-capture.",
    })).toThrow("already has an active turn");

    resolveAfter();
    await flushPromises();
    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("completed");
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
    runtime.store.close();
  });

  it("repairs a rejected async finalization without leaving the controller wedged", async () => {
    const runtime = await testRuntime({
      captureGitArtifacts: async () => undefined,
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Exercise guarded finalization.",
    });
    runtime.controller.start(queued.turn.id);
    vi.spyOn(runtime.store, "settleAgentTurn")
      .mockImplementationOnce(() => {
        throw new Error("simulated finalize failure");
      });
    runtime.provider.resolve({ status: "completed", text: "Provider completed." });
    await flushPromises();
    await flushPromises();

    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status: "failed",
      terminalReason: "stream-persistence-failed",
    });
    expect(runtime.controller.isActive(runtime.conversationId)).toBe(false);
    runtime.store.close();
  });

  it("persists visible content separately while the provider receives complete structured execution content", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Why is this change safe?",
      context: {
        diffSelections: [{
          path: "src/example.ts",
          hunkHeader: "@@ -1 +1 @@",
          content: "+const enabled = true;",
          selectedLineCount: 1,
        }],
        terminalContexts: [{
          terminalId: "terminal-1",
          terminalLabel: "Tests",
          lineStart: 10,
          lineEnd: 10,
          content: "1 test passed",
        }],
      },
      internalInstructions: [{
        label: "test-control",
        text: "INTERNAL_SECRET_POLICY: answer read-only.",
      }],
    });

    expect(queued.message.content).toBe("Why is this change safe?");
    const snapshotJson = JSON.stringify(runtime.store.snapshot());
    expect(snapshotJson).toContain("Why is this change safe?");
    expect(snapshotJson).not.toContain("+const enabled = true;");
    expect(snapshotJson).not.toContain("1 test passed");
    expect(snapshotJson).not.toContain("INTERNAL_SECRET_POLICY");
    expect(runtime.store.turnExecutionManifest(queued.turn.id)).toMatchObject({
      contextReferenceCount: 2,
      uniqueContextBlobCount: 2,
      internalInstructionCount: 1,
    });
    expect(JSON.stringify(runtime.store.turnExecutionManifest(queued.turn.id)))
      .not.toContain("INTERNAL_SECRET_POLICY");

    expect(runtime.controller.start(queued.turn.id)).toBe(true);
    expect(runtime.provider.input?.prompt).toContain("Why is this change safe?");
    expect(runtime.provider.input?.prompt).toContain("+const enabled = true;");
    expect(runtime.provider.input?.prompt).toContain("1 test passed");
    expect(runtime.provider.input?.prompt).toContain("INTERNAL_SECRET_POLICY");
    runtime.provider.resolve();
    await flushPromises();
    runtime.store.close();
  });

  it("rejects a post-assembly oversize request before a message, turn, or provider spawn", async () => {
    const runtime = await testRuntime();
    const before = runtime.store.snapshot();
    const content = "x".repeat(60 * 1024);

    expect(() => runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Do not queue this.",
      context: {
        diffSelections: Array.from({ length: 4 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          hunkHeader: `@@ -${index + 1} +${index + 1} @@`,
          content: `${index}${content}`,
          selectedLineCount: 1,
        })),
      },
    })).toThrow(/Assembled execution payload exceeds/u);
    expect(runtime.provider.input).toBeNull();
    expect(runtime.store.snapshot().messages).toEqual(before.messages);
    expect(runtime.store.snapshot().agentTurns).toEqual(before.agentTurns);
    runtime.store.close();
  });

  it("retains and validates the sanitized execution manifest across restart", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Persist this request context.",
      context: {
        diffSelections: [{
          path: "src/persist.ts",
          hunkHeader: "@@ -2 +2 @@",
          content: "shared content",
          selectedLineCount: 1,
        }],
        terminalContexts: [{
          terminalId: "persist-terminal",
          terminalLabel: "Persist",
          lineStart: 2,
          lineEnd: 2,
          content: "shared content",
        }],
      },
    });
    const expected = runtime.store.turnExecutionManifest(queued.turn.id);
    expect(expected).toMatchObject({
      contextReferenceCount: 2,
      uniqueContextBlobCount: 1,
    });
    const databasePath = join(runtime.directory, "inertia.sqlite");
    runtime.store.close();
    const inspection = new Database(databasePath, { readonly: true });
    expect((inspection.prepare(
      "SELECT COUNT(*) AS count FROM turn_execution_context_blobs",
    ).get() as { count: number }).count).toBe(1);
    expect((inspection.prepare(
      "SELECT COUNT(*) AS count FROM turn_execution_context_refs WHERE turn_id = ?",
    ).get(queued.turn.id) as { count: number }).count).toBe(2);
    inspection.close();

    const reopened = new RuntimeStore(
      databasePath,
      runtime.workspace,
      { recoverInterruptedRuns: false },
    );
    expect(reopened.turnExecutionManifest(queued.turn.id)).toEqual(expected);
    expect(JSON.stringify(reopened.snapshot())).not.toContain("shared content");
    reopened.close();
  });

  it("atomically queues the visible request, captures immutable config, and owns all completion associations", async () => {
    const runtime = await testRuntime();
    runtime.store.updateConversation(runtime.conversationId, {
      providerSessionId: "session-before",
    });
    runtime.store.upsertUsage({
      conversationId: runtime.conversationId,
      usedTokens: 12,
      totalProcessedTokens: 20,
      totalProcessedScope: "thread",
      maxTokens: 1_000,
      inputTokens: 10,
      cachedInputTokens: 1,
      cacheWriteInputTokens: 0,
      outputTokens: 2,
      reasoningOutputTokens: 1,
      compactsAutomatically: false,
    });
    const checkpoint = runtime.store.addCheckpoint({
      conversationId: runtime.conversationId,
      ref: "refs/inertia/checkpoints/controller",
      label: "Before controller turn",
      turnIndex: 1,
      filesChanged: 1,
      insertions: 2,
      deletions: 0,
    });
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Implement the lifecycle.",
      checkpointId: checkpoint.id,
    });
    expect(queued.turn).toMatchObject({
      status: "queued",
      userMessageId: queued.message.id,
      providerSessionBefore: "session-before",
      harnessId: "codex-app-server",
      model: "gpt-test",
      reasoningEffort: "high",
      usageAtStart: expect.objectContaining({
        usedTokens: 12,
        totalProcessedTokens: 20,
      }),
    });
    expect(runtime.store.checkpoint(checkpoint.id).turnId).toBe(queued.turn.id);
    expect(runtime.store.associateCheckpointWithTurn(
      checkpoint.id,
      runtime.conversationId,
      queued.turn.runId,
      queued.turn.id,
    ).turnId).toBe(queued.turn.id);
    expect(runtime.store.snapshot().messages).toContainEqual(
      expect.objectContaining({
        id: queued.message.id,
        turnId: queued.turn.id,
        role: "user",
      }),
    );

    expect(runtime.controller.start(queued.turn.id)).toBe(true);
    runtime.store.updateConversation(runtime.conversationId, {
      model: "later-default",
      reasoningEffort: "low",
      accessMode: "full",
    });
    const base = identity(runtime);
    runtime.provider.emit({ ...base, type: "session", sessionId: "session-after" });
    runtime.provider.emit({
      ...base,
      type: "usage",
      usage: {
        usedTokens: 30,
        totalProcessedTokens: 50,
        totalProcessedScope: "run",
        maxTokens: 1_000,
        inputTokens: 20,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 0,
        outputTokens: 8,
        reasoningOutputTokens: 3,
        compactsAutomatically: false,
      },
    });
    runtime.provider.emit({ ...base, type: "text", text: "Lifecycle complete." });
    runtime.provider.emit({ ...base, type: "reasoning-summary", text: "Verified." });
    runtime.provider.resolve({
      status: "completed",
      sessionId: "session-after",
      text: "Lifecycle complete.",
    });
    await flushPromises();

    const turn = runtime.store.agentTurn(queued.turn.id);
    expect(turn).toMatchObject({
      status: "completed",
      terminalReason: "provider-completed",
      providerSessionBefore: "session-before",
      providerSessionAfter: "session-after",
      checkpointId: checkpoint.id,
      model: "gpt-test",
      reasoningEffort: "high",
      accessMode: "supervised",
      terminalAssistantMessageId: expect.any(String),
      usageAtCompletion: expect.objectContaining({
        usedTokens: 30,
        totalProcessedTokens: 50,
      }),
    });
    expect(runtime.store.snapshot().messages).toContainEqual(
      expect.objectContaining({
        id: turn.terminalAssistantMessageId,
        turnId: turn.id,
        role: "assistant",
        content: "Lifecycle complete.",
      }),
    );
    expect(runtime.store.conversation(runtime.conversationId)).toMatchObject({
      status: "completed",
      providerSessionId: "session-after",
    });
    expect(runtime.store.workspaceRun(turn.runId).status).toBe("succeeded");
    expect(runtime.gitArtifacts).toEqual([turn.id]);
    expect(runtime.metadataRefreshes).toEqual([turn.id]);
    expect(runtime.settled).toContain(`context:${turn.id}`);
    expect(runtime.settled).toContain(`completed:${turn.id}`);
    runtime.store.close();
  });

  it("resumes the same native session across an officially supported model switch", async () => {
    const runtime = await testRuntime();
    const first = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Establish the provider session.",
    });
    runtime.controller.start(first.turn.id);
    const firstIdentity = identity(runtime);
    runtime.provider.emit({
      ...firstIdentity,
      type: "session",
      sessionId: "codex-session",
    });
    runtime.provider.resolve({
      status: "completed",
      sessionId: "codex-session",
      text: "Established.",
    });
    await flushPromises();

    runtime.store.updateConversation(runtime.conversationId, {
      model: "gpt-next",
    });
    const second = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Continue with the supported model switch.",
    });
    expect(second.turn.providerSessionBefore).toBe("codex-session");
    runtime.controller.start(second.turn.id);
    expect(runtime.provider.input).toMatchObject({
      sessionId: "codex-session",
      model: "gpt-next",
    });
    runtime.provider.resolve({ status: "completed", text: "Continued." });
    await flushPromises();
    runtime.store.close();
  });

  it("rejects an incompatible model switch before persisting a new message or turn", async () => {
    const runtime = await testRuntime();
    runtime.provider.resolveModelRoute = (selection) => {
      const route = resolveNativeModelRoute(selection);
      return {
        ...route,
        compatibility: {
          ...route.compatibility,
          allowsModelSwitchWithinSession: false,
        },
        continuationIdentity: {
          ...route.continuationIdentity,
          modelIdentity: selection.modelId,
        },
      };
    };
    const first = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Establish the fixed-model session.",
    });
    runtime.controller.start(first.turn.id);
    const firstIdentity = identity(runtime);
    runtime.provider.emit({
      ...firstIdentity,
      type: "session",
      sessionId: "fixed-model-session",
    });
    runtime.provider.resolve({
      status: "completed",
      sessionId: "fixed-model-session",
      text: "Established.",
    });
    await flushPromises();

    runtime.store.updateConversation(runtime.conversationId, {
      model: "gpt-other",
    });
    const before = runtime.store.snapshot();
    expect(() => runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Do not cross the model boundary.",
    })).toThrow("cannot change models inside an existing session");
    const after = runtime.store.snapshot();
    expect(after.messages).toEqual(before.messages);
    expect(after.agentTurns).toEqual(before.agentTurns);
    expect(runtime.provider.input?.model).toBe("gpt-test");
    runtime.store.close();
  });

  it("rejects a replaced backend endpoint before persisting a new turn", async () => {
    const runtime = await testRuntime();
    let endpointIdentity = "endpoint:first";
    runtime.provider.resolveModelRoute = (selection) => {
      const route = resolveNativeModelRoute(selection);
      return {
        ...route,
        continuationIdentity: {
          ...route.continuationIdentity,
          endpointIdentity,
        },
      };
    };
    const first = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Establish the endpoint-bound session.",
    });
    runtime.controller.start(first.turn.id);
    const firstIdentity = identity(runtime);
    runtime.provider.emit({
      ...firstIdentity,
      type: "session",
      sessionId: "endpoint-session",
    });
    runtime.provider.resolve({
      status: "completed",
      sessionId: "endpoint-session",
      text: "Established.",
    });
    await flushPromises();

    endpointIdentity = "endpoint:replacement";
    const before = runtime.store.snapshot();
    expect(() => runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Do not cross the endpoint boundary.",
    })).toThrow("different endpoint");
    const after = runtime.store.snapshot();
    expect(after.messages).toEqual(before.messages);
    expect(after.agentTurns).toEqual(before.agentTurns);
    runtime.store.close();
  });

  it("uses the latest authoritative turn instead of stale conversation identity", async () => {
    const runtime = await testRuntime();
    runtime.provider.resolveModelRoute = (selection) => {
      const route = resolveNativeModelRoute(selection);
      return {
        ...route,
        continuationIdentity: {
          ...route.continuationIdentity,
          endpointIdentity: "endpoint:authoritative",
        },
      };
    };
    const first = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Establish the authoritative endpoint.",
    });
    runtime.controller.start(first.turn.id);
    const firstIdentity = identity(runtime);
    runtime.provider.emit({
      ...firstIdentity,
      type: "session",
      sessionId: "authoritative-session",
    });
    runtime.provider.resolve({
      status: "completed",
      sessionId: "authoritative-session",
      text: "Established.",
    });
    await flushPromises();

    runtime.store.updateConversation(runtime.conversationId, {
      continuationIdentity: {
        ...first.turn.continuationIdentity,
        endpointIdentity: "endpoint:stale-shell-copy",
      },
    });
    const second = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Continue on the authoritative route.",
    });
    expect(second.turn.providerSessionBefore).toBe("authoritative-session");
    runtime.controller.start(second.turn.id);
    expect(runtime.provider.input).toMatchObject({
      sessionId: "authoritative-session",
      continuationIdentity: {
        endpointIdentity: "endpoint:authoritative",
      },
    });
    runtime.provider.resolve({ status: "completed", text: "Continued." });
    await flushPromises();
    runtime.store.close();
  });

  it("projects approval/input waiting states and resumes only after every request resolves", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Ask before proceeding.",
    });
    runtime.controller.start(queued.turn.id);
    const base = identity(runtime);
    runtime.provider.emit({
      ...base,
      type: "approval",
      request: {
        requestId: "approval-1",
        kind: "command",
        title: "Run tests",
        permissionRoots: [],
        availableDecisions: ["approve", "cancel"],
      },
    });
    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("waiting-for-approval");
    expect(runtime.store.conversation(runtime.conversationId)).toMatchObject({
      status: "needs-input",
      attentionKind: "approval",
    });
    expect(runtime.controller.respondToApproval(
      runtime.conversationId,
      "approval-1",
      "approve",
    )).toBe(true);

    runtime.provider.emit({
      ...base,
      type: "input",
      request: {
        requestId: "input-1",
        questions: [{
          id: "question-1",
          header: "Choice",
          question: "Which option?",
          isOther: false,
          isSecret: false,
          allowMultiple: false,
          options: [{ id: "one", label: "One", description: "" }],
        }],
        autoResolutionMs: null,
      },
    });
    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("waiting-for-input");
    runtime.provider.emit({ ...base, type: "input-resolved", requestId: "input-1" });
    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("waiting-for-approval");
    runtime.provider.emit({
      ...base,
      type: "approval-resolved",
      requestId: "approval-1",
      decision: "approve",
    });
    expect(runtime.store.agentTurn(queued.turn.id).status).toBe("running");
    expect(runtime.store.conversation(runtime.conversationId)).toMatchObject({
      status: "running",
      attentionKind: null,
    });
    runtime.provider.resolve();
    await flushPromises();
    runtime.store.close();
  });

  it("retains prior-turn plans when a later authoritative turn starts", async () => {
    const runtime = await testRuntime();
    const first = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Plan the first turn.",
    });
    runtime.controller.start(first.turn.id);
    const firstIdentity = identity(runtime);
    runtime.provider.emit({
      ...firstIdentity,
      type: "plan",
      explanation: "Updated first plan.",
      steps: [{ step: "First", status: "completed" }],
    });
    runtime.provider.resolve();
    await flushPromises();

    const second = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Plan the second turn.",
    });
    runtime.controller.start(second.turn.id);
    expect(runtime.store.snapshot().plans).toContainEqual(expect.objectContaining({
      runId: first.turn.runId,
      turnId: first.turn.id,
      explanation: "Updated first plan.",
    }));

    const secondIdentity = identity(runtime);
    runtime.provider.emit({
      ...secondIdentity,
      type: "plan",
      explanation: "Second plan.",
      steps: [{ step: "Second", status: "inProgress" }],
    });
    expect(runtime.store.snapshot().plans).toEqual([
      expect.objectContaining({
        runId: first.turn.runId,
        turnId: first.turn.id,
        explanation: "Updated first plan.",
      }),
      expect.objectContaining({
        runId: second.turn.runId,
        turnId: second.turn.id,
        explanation: "Second plan.",
      }),
    ]);
    runtime.provider.resolve();
    await flushPromises();
    runtime.store.close();
  });

  it("lets only one terminal race win and ignores stale and late callbacks", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Race completion and cancellation.",
    });
    runtime.controller.start(queued.turn.id);
    const base = identity(runtime);
    expect(runtime.controller.handleProviderEvent({
      ...base,
      runId: "stale-run",
      type: "text",
      text: "stale",
    })).toBe(false);
    expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
    const cancelled = runtime.store.agentTurn(queued.turn.id);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      terminalReason: "user-cancelled",
    });
    expect(runtime.controller.cancel(runtime.conversationId)).toBe(false);
    runtime.provider.emit({ ...base, type: "text", text: "late" });
    runtime.provider.resolve({ status: "completed", text: "late completion" });
    await flushPromises();
    expect(runtime.store.agentTurn(queued.turn.id)).toEqual(cancelled);
    expect(runtime.store.settleAgentTurn(queued.turn.id, {
      status: "failed",
      terminalReason: "late-process-exit",
    })).toEqual({ settled: false, turn: cancelled });
    expect(runtime.events.filter(({ type }) =>
      type === "agent.completed" || type === "agent.failed")).toHaveLength(1);
    expect(runtime.settled.filter((entry) => entry.startsWith("cancelled:"))).toHaveLength(1);
    runtime.store.close();
  });

  it("rejects approval and input events that arrive after their turn was cancelled", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Cancel before provider interaction arrives.",
    });
    runtime.controller.start(queued.turn.id);
    const base = identity(runtime);
    expect(runtime.controller.cancel(runtime.conversationId)).toBe(true);
    const cancelled = runtime.store.agentTurn(queued.turn.id);

    expect(runtime.controller.handleProviderEvent({
      ...base,
      type: "approval",
      request: {
        requestId: "late-approval",
        kind: "command",
        title: "Late approval",
        permissionRoots: [],
        availableDecisions: ["approve", "cancel"],
      },
    })).toBe(false);
    expect(runtime.controller.handleProviderEvent({
      ...base,
      type: "input",
      request: {
        requestId: "late-input",
        questions: [{
          id: "late-question",
          header: "Late question",
          question: "This must not reopen the turn.",
          isOther: false,
          isSecret: false,
          allowMultiple: false,
          options: [{ id: "continue", label: "Continue", description: "" }],
        }],
        autoResolutionMs: null,
      },
    })).toBe(false);

    expect(runtime.store.agentTurn(queued.turn.id)).toEqual(cancelled);
    expect(runtime.store.conversation(runtime.conversationId)).toMatchObject({
      status: "idle",
      attentionKind: null,
    });
    expect(runtime.events.filter(({ type }) =>
      type === "agent.approval.requested" || type === "agent.input.requested"))
      .toEqual([]);
    runtime.store.close();
  });

  it.each([
    ["provider error", "failed", "provider-error"],
    ["provider process exit", "failed", "provider-process-exit"],
    ["provider process crash", "failed", "provider-process-crash"],
    ["approval cancel", "cancelled", "approval-cancelled"],
    ["unsupported interaction", "failed", "unsupported-interaction"],
    ["runtime shutdown", "interrupted", "runtime-shutdown"],
    ["runtime crash", "interrupted", "runtime-crash"],
    ["timeout", "failed", "turn-timeout"],
    ["owned renderer disconnect", "cancelled", "renderer-disconnected"],
  ] as const)("settles %s exactly once", async (scenario, status, reason) => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: `Terminal scenario: ${scenario}`,
      rendererOwnerId: scenario === "owned renderer disconnect" ? "renderer-1" : null,
    });
    runtime.controller.start(queued.turn.id);
    const base = identity(runtime);

    if (scenario === "provider error") {
      runtime.provider.resolve({ status: "failed", exitCode: null, error: "provider error" });
    } else if (scenario === "provider process exit") {
      runtime.provider.resolve({ status: "failed", exitCode: 9, error: "exited" });
    } else if (scenario === "provider process crash") {
      runtime.provider.reject(new Error("crashed"));
    } else if (scenario === "approval cancel") {
      runtime.provider.emit({
        ...base,
        type: "approval",
        request: {
          requestId: "approval-cancel",
          kind: "command",
          title: "Cancel",
          permissionRoots: [],
          availableDecisions: ["cancel"],
        },
      });
      runtime.provider.emit({
        ...base,
        type: "approval-resolved",
        requestId: "approval-cancel",
        decision: "cancelled",
      });
    } else if (scenario === "unsupported interaction") {
      runtime.controller.unsupportedInteraction(runtime.conversationId, "unsupported");
    } else if (scenario === "runtime shutdown") {
      await runtime.controller.dispose("runtime-shutdown");
    } else if (scenario === "runtime crash") {
      await runtime.controller.dispose("runtime-crash");
    } else if (scenario === "timeout") {
      runtime.scheduler.runAll();
    } else {
      expect(runtime.controller.rendererDisconnected("another-renderer")).toBe(0);
      expect(runtime.controller.rendererDisconnected("renderer-1")).toBe(1);
    }
    await flushPromises();

    expect(runtime.store.agentTurn(queued.turn.id)).toMatchObject({
      status,
      terminalReason: reason,
      completedAt: expect.any(String),
    });
    runtime.provider.emit({ ...base, type: "text", text: "late" });
    expect(runtime.store.agentTurn(queued.turn.id).terminalReason).toBe(reason);
    expect(runtime.settled.filter((entry) => entry.endsWith(`:${queued.turn.id}`)))
      .toEqual(expect.arrayContaining([`${status}:${queued.turn.id}`]));
    runtime.store.close();
  });

  it("rolls back the user message if queued-turn persistence fails", async () => {
    const runtime = await testRuntime();
    const conversation = runtime.store.conversation(runtime.conversationId);
    const first = runtime.store.beginAgentTurn({
      id: "atomic-turn-1",
      conversationId: conversation.id,
      runId: "duplicate-run",
      content: "Owned request",
      providerId: "codex",
      harnessId: "fake",
      backendProfileId: "fake",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    });
    const before = runtime.store.snapshot().messages;
    expect(() => runtime.store.beginAgentTurn({
      id: "atomic-turn-2",
      conversationId: conversation.id,
      runId: "duplicate-run",
      content: "Must roll back",
      providerId: "codex",
      harnessId: "fake",
      backendProfileId: "fake",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "supervised",
      configurationRevision: 0,
      association: "authoritative",
    })).toThrow();
    expect(runtime.store.snapshot().messages).toEqual(before);
    expect(runtime.store.agentTurn(first.turn.id).userMessageId).toBe(first.message.id);
    runtime.store.close();
  });

  it("recovers a queued or running authoritative turn as interrupted on restart", async () => {
    const runtime = await testRuntime();
    const queued = runtime.controller.queue({
      conversationId: runtime.conversationId,
      content: "Recover this running turn.",
    });
    runtime.controller.start(queued.turn.id);
    const projectId = runtime.store.conversation(runtime.conversationId).projectId;
    const queuedConversation = runtime.store.createConversation(projectId, "Queued recovery");
    const neverStarted = runtime.controller.queue({
      conversationId: queuedConversation.id,
      content: "Recover this queued turn.",
    });
    const databasePath = join(runtime.directory, "inertia.sqlite");
    runtime.store.close();

    const reopened = new RuntimeStore(
      databasePath,
      runtime.workspace,
      { recoverInterruptedRuns: false },
    );
    const recovery = recoverInterruptedTurns(reopened);
    expect(recovery.recoveredTurns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: queued.turn.id,
        status: "interrupted",
        terminalReason: "runtime-restart",
      }),
      expect.objectContaining({
        id: neverStarted.turn.id,
        status: "interrupted",
        terminalReason: "runtime-restart",
      }),
    ]));
    expect(reopened.conversation(runtime.conversationId)).toMatchObject({
      status: "failed",
      attentionKind: null,
    });
    expect(reopened.snapshot().activities).toContainEqual(expect.objectContaining({
      turnId: queued.turn.id,
      runId: queued.turn.runId,
      kind: "error",
    }));
    reopened.close();
  });
});
