import { randomUUID } from "node:crypto";

import {
  isAgentTurnTerminalStatus,
  type AgentActivity,
  type AgentApprovalDecision,
  type AgentApprovalRequest,
  type AgentInputRequest,
  type AgentPlan,
  type AgentTurn,
  type AgentTurnStatus,
  type AgentTurnTerminalStatus,
  type AgentTurnUsageSnapshot,
  type ChatAttachment,
  type ChatMessage,
  type Conversation,
  type ContinuationIdentity,
  type HarnessBackendCompatibility,
  type KnownHarnessId,
  type ModelBackendProfile,
  type ModelSelection,
  type ProviderInfo,
  type ProviderId,
  type RuntimeMutationEvent,
  type ThreadUsageSnapshot,
  type TurnRequestContext,
} from "../../../shared/contracts";
import {
  modelSelectionSchema,
} from "../../../shared/model-routing";
import { resolveContinuationDecision } from "../../../shared/continuation-policy";
import { RuntimeStore } from "../../database";
import {
  agentActivityKind,
  agentActivityStatus,
} from "../../runtime-snapshots";
import type {
  ProviderActivityEvent,
  ProviderEvent,
  ProviderMetadataEvent,
  ProviderRunCallbacks,
  ProviderRunInput,
  ProviderRunResult,
} from "../../provider/contracts";
import {
  assembleTurnRequest,
  type HiddenProviderInstruction,
  type SanitizedTurnExecutionManifest,
} from "./request-context";
import {
  TurnStreamCoalescer,
  type DeltaTimerScheduler,
  type StreamDeltaFlush,
} from "./turn-stream-coalescer";

const MAX_ASSISTANT_TEXT = 4 * 1024 * 1024;
const MAX_REASONING_TEXT = 512 * 1024;
const DEFAULT_TURN_TIMEOUT_MS = 6 * 60 * 60 * 1_000;

export interface TurnTimerScheduler extends DeltaTimerScheduler {}

export interface TurnProviderRuntime {
  resolveModelRoute(selection: ModelSelection): {
    providerId: ProviderId;
    harnessId: KnownHarnessId;
    backendProfile: ModelBackendProfile;
    compatibility: HarnessBackendCompatibility;
    continuationIdentity: ContinuationIdentity;
  };
  harnessIdFor(input: ProviderRunInput): string;
  run(input: ProviderRunInput, callbacks: ProviderRunCallbacks): Promise<ProviderRunResult>;
  cancel(conversationId: string): boolean;
  isRunning(conversationId: string): boolean;
  respondToApproval(
    conversationId: string,
    requestId: string,
    decision: AgentApprovalDecision,
    identity: { runId: string; turnId: string },
  ): boolean;
  respondToInput(
    conversationId: string,
    requestId: string,
    answers: Record<string, string[]>,
    identity: { runId: string; turnId: string },
  ): boolean;
  disposeAll(): Promise<void>;
}

export interface TurnStructuredContextCapture {
  conversation: Conversation;
  content: string;
  attachments: readonly ChatAttachment[];
  executionManifest: SanitizedTurnExecutionManifest;
}

export interface TurnStructuredContextRecord {
  turn: AgentTurn;
  context: unknown;
}

export interface TurnGitArtifactHookInput {
  turn: AgentTurn;
  checkpointId: string | null;
  terminalAssistantMessageId: string | null;
}

export interface TurnMetadataRefreshHookInput {
  providerId: ProviderId;
  conversationId: string;
  turnId: string;
  runStartedAt: number;
  status: AgentTurnTerminalStatus;
}

export interface TurnControllerHooks {
  broadcast(event: RuntimeMutationEvent): void;
  broadcastSnapshot(): void;
  providerInfo(): readonly ProviderInfo[];
  applyProviderMetadata?(event: ProviderMetadataEvent): void;
  captureStructuredContext?(input: TurnStructuredContextCapture): unknown;
  onStructuredContextCaptured?(record: TurnStructuredContextRecord): void | Promise<void>;
  onStreamingPersisted?(input: {
    turnId: string;
    kind: "assistant" | "reasoning";
    recordId: string;
  }): void;
  captureGitBefore?(input: TurnGitArtifactHookInput): void | Promise<void>;
  captureGitArtifacts?(input: TurnGitArtifactHookInput): void | Promise<void>;
  refreshProviderMetadata?(input: TurnMetadataRefreshHookInput): void | Promise<void>;
  onTurnSettled?(turn: AgentTurn): void | Promise<void>;
}

export interface QueueTurnRequest {
  conversationId: string;
  content: string;
  attachments?: readonly ChatAttachment[];
  imagePaths?: readonly string[];
  context?: TurnRequestContext;
  /** Server-constructed only. Renderer command schemas never accept this. */
  internalInstructions?: readonly HiddenProviderInstruction[];
  checkpointId?: string | null;
  rendererOwnerId?: string | null;
  onSettled?: (status: AgentTurnTerminalStatus, turnId: string) => void | Promise<void>;
}

export interface QueuedTurn {
  message: ChatMessage;
  turn: AgentTurn;
}

export type TurnTerminalCause =
  | "provider-completed"
  | "provider-error"
  | "provider-process-exit"
  | "provider-process-crash"
  | "user-cancelled"
  | "approval-cancelled"
  | "unsupported-interaction"
  | "runtime-shutdown"
  | "runtime-crash"
  | "runtime-restart"
  | "turn-timeout"
  | "renderer-disconnected"
  | "turn-start-failed"
  | "stream-persistence-failed"
  | "checkpoint-association-failed";

interface ActiveTurn {
  turn: AgentTurn;
  conversation: Conversation;
  providerInput: ProviderRunInput;
  checkpointId: string | null;
  rendererOwnerId: string | null;
  structuredContext: unknown;
  gitBeforeCapture: Promise<void> | null;
  runStartedAt: number;
  workspaceRunCreated: boolean;
  acceptingProviderEvents: boolean;
  settled: boolean;
  sessionAfter: string | null;
  lastUsage: AgentTurnUsageSnapshot | null;
  assistantText: string;
  assistantMessageId: string | null;
  assistantStream: TurnStreamCoalescer;
  reasoningText: string;
  reasoningId: string | null;
  reasoningStream: TurnStreamCoalescer;
  timeoutTimer: unknown;
  runningActivities: Map<ProviderActivityEvent["kind"], AgentActivity[]>;
  providerCommandRuns: Map<string, string>;
  approvalIds: Set<string>;
  inputIds: Set<string>;
  onSettled?: QueueTurnRequest["onSettled"];
}

function defaultScheduler(): TurnTimerScheduler {
  return {
    setTimeout: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return timer;
    },
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  };
}

function providerLabel(providerId: ProviderId): string {
  return providerId === "codex"
    ? "Codex"
    : providerId === "claude"
      ? "Claude"
      : providerId === "cursor"
        ? "Cursor"
        : "OpenCode";
}

function projectActionKind(name: string): "check" | "service" {
  return /(?:^|[:\s-])(dev|serve|server|start|watch|preview)(?:$|[:\s-])/iu.test(name)
    ? "service"
    : "check";
}

function boundaryUsage(
  usage: ThreadUsageSnapshot | undefined,
  capturedAt: string,
): AgentTurnUsageSnapshot | null {
  if (!usage) return null;
  return {
    usedTokens: usage.usedTokens,
    totalProcessedTokens: usage.totalProcessedTokens,
    totalProcessedScope: usage.totalProcessedScope,
    maxTokens: usage.maxTokens,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    outputTokens: usage.outputTokens,
    reasoningOutputTokens: usage.reasoningOutputTokens,
    compactsAutomatically: usage.compactsAutomatically,
    capturedAt,
  };
}

/**
 * Server-authoritative owner for every live agent-turn lifecycle. Provider
 * transports only emit normalized events; conversation and workspace rows are
 * projections written after the durable turn transition.
 */
export class TurnController {
  private readonly activeByConversation = new Map<string, ActiveTurn>();
  private readonly activeByTurn = new Map<string, ActiveTurn>();
  private readonly scheduler: TurnTimerScheduler;
  private readonly clock: () => Date;
  private readonly id: () => string;
  private readonly turnTimeoutMs: number;
  private readonly settlementTasks = new Set<Promise<unknown>>();
  private closing = false;

  constructor(
    private readonly store: RuntimeStore,
    private readonly providers: TurnProviderRuntime,
    private readonly pendingApprovals: Map<string, AgentApprovalRequest>,
    private readonly pendingInputs: Map<string, AgentInputRequest>,
    private readonly agentPlans: Map<string, AgentPlan>,
    private readonly hooks: TurnControllerHooks,
    options: {
      scheduler?: TurnTimerScheduler;
      clock?: () => Date;
      id?: () => string;
      turnTimeoutMs?: number;
    } = {},
  ) {
    this.scheduler = options.scheduler ?? defaultScheduler();
    this.clock = options.clock ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.turnTimeoutMs = Math.max(1, options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
  }

  isActive(conversationId: string): boolean {
    return this.activeByConversation.has(conversationId);
  }

  activeConversationIds(): string[] {
    return [...this.activeByConversation.keys()];
  }

  queue(request: QueueTurnRequest): QueuedTurn {
    if (this.closing) throw new Error("The local runtime is shutting down.");
    if (this.activeByConversation.has(request.conversationId)) {
      throw new Error("This conversation already has an active turn.");
    }

    const conversation = this.store.conversation(request.conversationId);
    const attachments = [...(request.attachments ?? [])];
    const assembled = assembleTurnRequest({
      cwd: this.store.conversationPath(conversation.id),
      visibleContent: request.content,
      attachments,
      imagePaths: request.imagePaths,
      context: request.context,
      internalInstructions: request.internalInstructions,
    });
    const runId = this.id();
    const turnId = this.id();
    const selectedProvider = this.hooks.providerInfo().find(({ id }) => id === conversation.providerId);
    const requestedModelId = conversation.modelSelection.modelId;
    const selectedModel = requestedModelId !== "provider-default"
      ? selectedProvider?.models.find(({ id }) => id === requestedModelId)
      : selectedProvider?.models.find(({ isDefault }) => isDefault) ?? selectedProvider?.models[0];
    const modelSelection = modelSelectionSchema.parse({
      ...conversation.modelSelection,
      modelId: selectedModel?.id ?? requestedModelId,
    });
    const route = this.providers.resolveModelRoute(modelSelection);
    const latestTurn = this.store.latestAgentTurnForConversation(conversation.id);
    const continuation = resolveContinuationDecision({
      previousIdentity: latestTurn?.continuationIdentity
        ?? conversation.continuationIdentity
        ?? null,
      nextIdentity: route.continuationIdentity,
      previousModelId: latestTurn?.modelSelection.modelId
        ?? (conversation.continuationIdentity ? conversation.modelSelection.modelId : null),
      nextModelId: modelSelection.modelId,
      hasProviderSession: conversation.providerSessionId !== null,
      hasTurns: latestTurn !== null,
      allowsModelSwitchWithinSession:
        route.compatibility.allowsModelSwitchWithinSession,
    });
    if (continuation.action === "new-conversation-required") {
      throw new Error(continuation.reason);
    }
    const canResume = continuation.action === "resume-session";
    const providerInput: ProviderRunInput = {
      providerId: route.providerId,
      harnessId: route.harnessId,
      backendProfile: route.backendProfile,
      backendCompatibility: route.compatibility,
      modelSelection,
      continuationIdentity: route.continuationIdentity,
      conversationId: conversation.id,
      runId,
      turnId,
      cwd: this.store.conversationPath(conversation.id),
      prompt: assembled.executionPrompt,
      model: modelSelection.modelId === "provider-default"
        ? undefined
        : modelSelection.modelId,
      reasoningEffort: modelSelection.reasoningEffort || undefined,
      interactionMode: conversation.interactionMode,
      access: conversation.accessMode,
      sessionId: canResume ? conversation.providerSessionId! : undefined,
      imagePaths: assembled.imagePaths,
    };
    const harnessId = this.providers.harnessIdFor(providerInput);
    if (harnessId !== route.harnessId) {
      throw new Error("The resolved model route changed before the turn could start.");
    }
    const requestedAt = this.now();
    const context = this.hooks.captureStructuredContext?.({
      conversation,
      content: assembled.visibleContent,
      attachments,
      executionManifest: assembled.persistence.manifest,
    });
    const currentUsage = this.store.usageForConversation(conversation.id);
    const queued = this.store.beginAgentTurn({
      id: turnId,
      conversationId: conversation.id,
      runId,
      content: assembled.visibleContent,
      attachments,
      executionContext: assembled.persistence,
      providerId: route.providerId,
      modelSelection,
      continuationIdentity: route.continuationIdentity,
      harnessId,
      backendProfileId: modelSelection.backendProfileId,
      model: modelSelection.modelId,
      modelAlias: modelSelection.alias,
      reasoningEffort: modelSelection.reasoningEffort ?? "",
      interactionMode: conversation.interactionMode,
      accessMode: conversation.accessMode,
      providerSessionBefore: canResume ? conversation.providerSessionId : null,
      requestedAt,
      usageAtStart: boundaryUsage(currentUsage ?? undefined, requestedAt),
      configurationRevision: modelSelection.backendConfigurationRevision,
      association: "authoritative",
    });
    let active: ActiveTurn;
    const assistantStream = this.createStreamCoalescer(
      () => active,
      "assistant",
    );
    const reasoningStream = this.createStreamCoalescer(
      () => active,
      "reasoning",
    );
    active = {
      turn: queued.turn,
      conversation,
      providerInput,
      checkpointId: request.checkpointId ?? null,
      rendererOwnerId: request.rendererOwnerId ?? null,
      structuredContext: context,
      gitBeforeCapture: null,
      runStartedAt: this.clock().getTime(),
      workspaceRunCreated: false,
      acceptingProviderEvents: true,
      settled: false,
      sessionAfter: canResume ? conversation.providerSessionId : null,
      lastUsage: null,
      assistantText: "",
      assistantMessageId: null,
      assistantStream,
      reasoningText: "",
      reasoningId: null,
      reasoningStream,
      timeoutTimer: null,
      runningActivities: new Map(),
      providerCommandRuns: new Map(),
      approvalIds: new Set(),
      inputIds: new Set(),
      onSettled: request.onSettled,
    };
    this.activeByConversation.set(conversation.id, active);
    this.activeByTurn.set(queued.turn.id, active);
    this.agentPlans.delete(conversation.id);

    try {
      if (active.checkpointId) {
        this.store.associateCheckpointWithTurn(
          active.checkpointId,
          conversation.id,
          runId,
          turnId,
        );
      }
    } catch (error) {
      this.settle(active, "failed", "checkpoint-association-failed", this.publicError(error));
      throw error;
    }

    if (context !== undefined) {
      this.track(this.hooks.onStructuredContextCaptured?.({ turn: queued.turn, context }));
    }
    return queued;
  }

  start(turnId: string): boolean {
    const active = this.activeByTurn.get(turnId);
    if (!active || active.settled || this.closing) return false;
    const now = this.now();
    active.turn = this.store.updateAgentTurnLifecycle(turnId, {
      status: "starting",
      startedAt: now,
      updatedAt: now,
    });
    this.store.createWorkspaceRun({
      id: active.turn.runId,
      kind: "agent",
      projectId: active.conversation.projectId,
      conversationId: active.conversation.id,
      label: active.conversation.model
        ? `${providerLabel(active.turn.providerId)} · ${active.conversation.model}`
        : providerLabel(active.turn.providerId),
      detail: active.conversation.title,
      status: "running",
      port: null,
    });
    active.workspaceRunCreated = true;
    this.projectConversation(active, "running");
    this.hooks.broadcast({
      type: "agent.started",
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
    });
    this.hooks.broadcastSnapshot();
    active.timeoutTimer = this.scheduler.setTimeout(() => {
      if (active.settled) return;
      this.providers.cancel(active.conversation.id);
      this.settle(active, "failed", "turn-timeout", "The agent turn timed out.");
    }, this.turnTimeoutMs);

    let preCapture: void | Promise<void>;
    try {
      preCapture = this.hooks.captureGitBefore?.({
        turn: active.turn,
        checkpointId: active.checkpointId,
        terminalAssistantMessageId: null,
      });
    } catch {
      preCapture = undefined;
    }
    if (preCapture && typeof (preCapture as Promise<void>).then === "function") {
      active.gitBeforeCapture = Promise.resolve(preCapture).catch(() => undefined);
      this.track(active.gitBeforeCapture
        .then(() => {
          this.startProvider(active);
        }));
      return true;
    }
    return this.startProvider(active);
  }

  private startProvider(active: ActiveTurn): boolean {
    if (active.settled || this.closing) return false;
    let result: Promise<ProviderRunResult>;
    try {
      result = this.providers.run(active.providerInput, {
        onEvent: (event) => {
          this.handleProviderEvent(event);
        },
      });
      if (this.store.agentTurn(active.turn.id).status === "starting") {
        if (this.transition(active, "running")) this.hooks.broadcastSnapshot();
      }
    } catch (error) {
      this.settle(active, "failed", "turn-start-failed", this.publicError(error));
      return false;
    }

    void result.then(
      (providerResult) => this.handleProviderResult(active, providerResult),
      (error: unknown) => {
        this.settle(active, "failed", "provider-process-crash", this.publicError(error));
      },
    );
    return true;
  }

  cancel(conversationId: string, cause: TurnTerminalCause = "user-cancelled"): boolean {
    const active = this.activeByConversation.get(conversationId);
    if (!active || active.settled) return false;
    this.providers.cancel(conversationId);
    return this.settle(active, "cancelled", cause, "Stopped");
  }

  respondToApproval(
    conversationId: string,
    requestId: string,
    decision: AgentApprovalDecision,
  ): boolean {
    const pending = this.pendingApprovals.get(requestId);
    const active = this.activeByConversation.get(conversationId);
    if (
      !pending
      || !active
      || active.settled
      || pending.conversationId !== conversationId
      || pending.runId !== active.turn.runId
      || pending.turnId !== active.turn.id
      || !pending.availableDecisions.includes(decision)
    ) return false;
    const responded = this.providers.respondToApproval(
      conversationId,
      requestId,
      decision,
      { runId: active.turn.runId, turnId: active.turn.id },
    );
    if (!responded) {
      this.settle(
        active,
        "failed",
        "unsupported-interaction",
        "The selected provider cannot answer this approval request.",
      );
    } else if (decision === "cancel") {
      this.providers.cancel(conversationId);
      this.settle(active, "cancelled", "approval-cancelled", "The approval was cancelled.");
    }
    return responded;
  }

  respondToInput(
    conversationId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ): boolean {
    const pending = this.pendingInputs.get(requestId);
    const active = this.activeByConversation.get(conversationId);
    if (
      !pending
      || !active
      || active.settled
      || pending.conversationId !== conversationId
      || pending.runId !== active.turn.runId
      || pending.turnId !== active.turn.id
    ) return false;
    const responded = this.providers.respondToInput(
      conversationId,
      requestId,
      answers,
      { runId: active.turn.runId, turnId: active.turn.id },
    );
    if (!responded) {
      this.settle(
        active,
        "failed",
        "unsupported-interaction",
        "The selected provider cannot answer this input request.",
      );
    }
    return responded;
  }

  rendererDisconnected(ownerId: string): number {
    let settled = 0;
    for (const active of [...this.activeByConversation.values()]) {
      if (active.rendererOwnerId !== ownerId) continue;
      this.providers.cancel(active.conversation.id);
      if (this.settle(
        active,
        "cancelled",
        "renderer-disconnected",
        "The renderer that owned this isolated turn disconnected.",
      )) settled += 1;
    }
    return settled;
  }

  unsupportedInteraction(conversationId: string, message: string): boolean {
    const active = this.activeByConversation.get(conversationId);
    if (!active || active.settled) return false;
    this.providers.cancel(conversationId);
    return this.settle(active, "failed", "unsupported-interaction", message);
  }

  /** Runtime shutdown and owned process-crash paths use the same settlement. */
  async dispose(cause: "runtime-shutdown" | "runtime-crash" = "runtime-shutdown"): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const active of [...this.activeByConversation.values()]) {
      this.providers.cancel(active.conversation.id);
      this.settle(
        active,
        "interrupted",
        cause,
        cause === "runtime-shutdown"
          ? "The local runtime shut down before this turn completed."
          : "The local runtime crashed before this turn completed.",
      );
    }
    await this.providers.disposeAll();
    await Promise.allSettled([...this.settlementTasks]);
  }

  /**
   * Public for focused transport and stale-callback tests. Production provider
   * events enter through the callback installed by start().
   */
  handleProviderEvent(event: ProviderEvent): boolean {
    const active = this.activeByConversation.get(event.conversationId);
    if (!active || !this.accepts(active, event)) return false;
    try {
      switch (event.type) {
        case "text":
          this.appendAssistantText(active, event.text);
          break;
        case "reasoning-summary":
          this.appendReasoning(active, event.text);
          break;
        case "usage": {
          const usage = this.store.upsertUsage({
            conversationId: active.conversation.id,
            turnId: active.turn.id,
            ...event.usage,
          });
          active.lastUsage = boundaryUsage(usage, this.now());
          this.hooks.broadcast({ type: "agent.usage", usage });
          break;
        }
        case "session":
          active.sessionAfter = event.sessionId;
          this.store.updateConversation(active.conversation.id, {
            providerSessionId: event.sessionId,
            continuationIdentity: active.turn.continuationIdentity,
          });
          break;
        case "activity": {
          const activity = this.recordProviderActivity(active, event);
          this.hooks.broadcast({ type: "agent.activity", activity });
          this.hooks.broadcastSnapshot();
          break;
        }
        case "status":
          if (
            (event.status === "starting" && this.transition(active, "starting"))
            || (event.status === "running" && this.transition(active, "running"))
          ) {
            this.hooks.broadcastSnapshot();
          }
          break;
        case "approval":
          this.openApproval(active, event.request);
          break;
        case "approval-resolved":
          this.resolveApproval(active, event.requestId, event.decision);
          break;
        case "input":
          this.openInput(active, event.request);
          break;
        case "input-resolved":
          this.resolveInput(active, event.requestId);
          break;
        case "plan": {
          const plan: AgentPlan = {
            conversationId: active.conversation.id,
            runId: active.turn.runId,
            turnId: active.turn.id,
            explanation: event.explanation,
            steps: event.steps,
          };
          this.agentPlans.set(active.conversation.id, plan);
          this.store.upsertAgentPlan(plan);
          this.hooks.broadcast({ type: "agent.plan.updated", plan });
          break;
        }
        case "metadata":
          try {
            this.hooks.applyProviderMetadata?.(event);
          } catch {
            // Metadata projection failures do not change the turn outcome.
          }
          this.hooks.broadcastSnapshot();
          break;
      }
      return true;
    } catch (error) {
      this.providers.cancel(active.conversation.id);
      this.settle(active, "failed", "stream-persistence-failed", this.publicError(error));
      return false;
    }
  }

  private accepts(
    active: ActiveTurn,
    event: Pick<ProviderEvent, "providerId" | "conversationId" | "runId" | "turnId">,
  ): boolean {
    if (
      !active.acceptingProviderEvents
      || active.settled
      || event.providerId !== active.turn.providerId
      || event.conversationId !== active.conversation.id
      || event.runId !== active.turn.runId
      || event.turnId !== active.turn.id
    ) return false;
    try {
      const authoritative = this.store.assertAgentTurnIdentity(
        active.conversation.id,
        active.turn.runId,
        active.turn.id,
      );
      return !isAgentTurnTerminalStatus(authoritative.status);
    } catch {
      return false;
    }
  }

  private handleProviderResult(active: ActiveTurn, result: ProviderRunResult): void {
    if (active.settled) return;
    if (result.sessionId) {
      active.sessionAfter = result.sessionId;
      this.store.updateConversation(active.conversation.id, {
        providerSessionId: result.sessionId,
        continuationIdentity: active.turn.continuationIdentity,
      });
    }
    this.reconcileAssistantResult(active, result);
    if (result.status === "completed") {
      this.settle(active, "completed", "provider-completed");
    } else if (result.status === "cancelled") {
      this.settle(active, "cancelled", "user-cancelled", "Stopped");
    } else {
      const cause = result.exitCode !== null || result.signal !== null
        ? "provider-process-exit"
        : "provider-error";
      this.settle(
        active,
        "failed",
        cause,
        result.error ?? "The provider could not complete the request.",
      );
    }
  }

  private transition(active: ActiveTurn, status: Exclude<AgentTurnStatus, AgentTurnTerminalStatus>): boolean {
    if (active.settled) return false;
    const current = this.store.agentTurn(active.turn.id);
    if (isAgentTurnTerminalStatus(current.status) || current.status === status) return false;
    if (status === "starting" && current.status !== "queued") return false;
    if (
      status === "running"
      && (current.status === "waiting-for-approval" || current.status === "waiting-for-input")
      && (active.approvalIds.size > 0 || active.inputIds.size > 0)
    ) return false;
    active.turn = this.store.updateAgentTurnLifecycle(active.turn.id, {
      status,
      updatedAt: this.now(),
    });
    return true;
  }

  private appendAssistantText(active: ActiveTurn, text: string): void {
    const accepted = text.slice(0, Math.max(0, MAX_ASSISTANT_TEXT - active.assistantText.length));
    if (!accepted) return;
    active.assistantText += accepted;
    active.assistantStream.append(accepted);
  }

  private appendReasoning(active: ActiveTurn, text: string): void {
    const accepted = text.slice(0, Math.max(0, MAX_REASONING_TEXT - active.reasoningText.length));
    if (!accepted) return;
    active.reasoningText += accepted;
    active.reasoningStream.append(accepted);
  }

  private reconcileAssistantResult(active: ActiveTurn, result: ProviderRunResult): void {
    if (!result.text || result.text === active.assistantText) return;
    const finalText = result.text.slice(0, MAX_ASSISTANT_TEXT);
    if (finalText.startsWith(active.assistantText)) {
      this.appendAssistantText(active, finalText.slice(active.assistantText.length));
      return;
    }
    if (result.textTruncated && active.assistantText.startsWith(finalText)) return;
    active.assistantText = finalText;
    active.assistantStream.replacePending(finalText);
  }

  private createStreamCoalescer(
    active: () => ActiveTurn,
    kind: "assistant" | "reasoning",
  ): TurnStreamCoalescer {
    return new TurnStreamCoalescer({
      scheduler: this.scheduler,
      onFlush: (flush) => this.persistStreamFlush(active(), kind, flush),
      onTimerError: (error) => {
        const current = active();
        if (current.settled) return;
        this.providers.cancel(current.conversation.id);
        this.settle(
          current,
          "failed",
          "stream-persistence-failed",
          this.publicError(error),
        );
      },
    });
  }

  private persistStreamFlush(
    active: ActiveTurn,
    kind: "assistant" | "reasoning",
    flush: StreamDeltaFlush,
  ): void {
    let recordId: string;
    if (kind === "assistant") {
      if (active.assistantMessageId) {
        this.store.updateMessageContent(active.assistantMessageId, active.assistantText);
      } else {
        active.assistantMessageId = this.store.createMessage(
          active.conversation.id,
          active.assistantText,
          "assistant",
          [],
          active.turn.id,
          this.now(),
        ).id;
      }
      recordId = active.assistantMessageId;
    } else {
      if (!active.reasoningId) {
        active.reasoningId = this.store.createReasoning(
          active.conversation.id,
          active.turn.runId,
          active.turn.id,
        ).id;
      }
      this.store.updateReasoning(active.reasoningId, { content: active.reasoningText });
      recordId = active.reasoningId;
    }

    try {
      this.hooks.onStreamingPersisted?.({
        turnId: active.turn.id,
        kind,
        recordId,
      });
    } catch {
      // Optional downstream hooks cannot invalidate durable stream storage.
    }

    // A terminal correction is persisted authoritatively. The terminal
    // snapshot replaces renderer state; appending it as a delta would corrupt
    // the transient view.
    if (flush.replacement) return;
    this.hooks.broadcast({
      type: kind === "assistant" ? "agent.text" : "agent.reasoning",
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      text: flush.delta,
    });
  }

  private flushStreaming(active: ActiveTurn): void {
    active.assistantStream.flush();
    active.reasoningStream.flush();
  }

  private recordProviderActivity(
    active: ActiveTurn,
    event: ProviderActivityEvent,
  ): AgentActivity {
    const status = agentActivityStatus(event);
    const candidates = active.runningActivities.get(event.kind) ?? [];
    if (event.phase !== "started" && event.phase !== "info") {
      let matchIndex = candidates.findIndex((activity) => activity.title === event.label);
      if (matchIndex < 0 && (candidates.length === 1 || event.label === "Tool")) matchIndex = 0;
      if (matchIndex >= 0) {
        const [match] = candidates.splice(matchIndex, 1);
        if (candidates.length === 0) active.runningActivities.delete(event.kind);
        else active.runningActivities.set(event.kind, candidates);
        const activity = this.store.updateActivity(match.id, {
          title: event.label,
          status,
        });
        this.syncProviderCommandRun(active, activity, event.phase);
        return activity;
      }
    }
    const activity = this.store.addActivity({
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      kind: agentActivityKind(event),
      title: event.label,
      detail: null,
      status,
    });
    this.syncProviderCommandRun(active, activity, event.phase);
    if (event.phase === "started") {
      candidates.push(activity);
      active.runningActivities.set(event.kind, candidates);
    }
    return activity;
  }

  private syncProviderCommandRun(
    active: ActiveTurn,
    activity: AgentActivity,
    phase?: ProviderActivityEvent["phase"],
  ): void {
    if (activity.kind !== "command" || phase === "info") return;
    const status = activity.status === "running"
      ? "running"
      : activity.status === "failed"
        ? "failed"
        : "succeeded";
    const label = activity.title === "Command" ? "Agent command" : activity.title;
    const existingId = active.providerCommandRuns.get(activity.id);
    if (existingId) {
      this.store.updateWorkspaceRun(existingId, { label, status });
      if (status !== "running") active.providerCommandRuns.delete(activity.id);
      return;
    }
    const workspaceRun = this.store.createWorkspaceRun({
      kind: projectActionKind(activity.title),
      projectId: active.conversation.projectId,
      conversationId: active.conversation.id,
      label,
      detail: `${providerLabel(active.turn.providerId)} · ${active.conversation.title}`,
      status: "running",
      port: null,
    });
    if (status === "running") active.providerCommandRuns.set(activity.id, workspaceRun.id);
    else this.store.updateWorkspaceRun(workspaceRun.id, { status });
  }

  private openApproval(
    active: ActiveTurn,
    request: Extract<ProviderEvent, { type: "approval" }>["request"],
  ): void {
    this.flushStreaming(active);
    const pending: AgentApprovalRequest = {
      id: request.requestId,
      providerId: active.turn.providerId,
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      kind: request.kind,
      title: request.title,
      detail: request.detail ?? null,
      command: request.command ?? null,
      cwd: request.cwd ?? null,
      reason: request.reason ?? null,
      networkScope: request.networkScope ?? null,
      permissionRoots: request.permissionRoots,
      availableDecisions: request.availableDecisions,
    };
    active.approvalIds.add(pending.id);
    this.pendingApprovals.set(pending.id, pending);
    this.transition(active, "waiting-for-approval");
    this.projectWaiting(active, "approval", pending.title);
    this.hooks.broadcast({ type: "agent.approval.requested", request: pending });
    this.hooks.broadcastSnapshot();
  }

  private resolveApproval(
    active: ActiveTurn,
    requestId: string,
    decision: AgentApprovalDecision | "cancelled",
  ): void {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending || pending.turnId !== active.turn.id || pending.runId !== active.turn.runId) return;
    this.pendingApprovals.delete(requestId);
    active.approvalIds.delete(requestId);
    this.hooks.broadcast({
      type: "agent.approval.resolved",
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      requestId,
      decision,
    });
    if (decision === "cancel" || decision === "cancelled") {
      this.providers.cancel(active.conversation.id);
      this.settle(active, "cancelled", "approval-cancelled", "The approval was cancelled.");
      return;
    }
    this.refreshWaitingState(active);
  }

  private openInput(
    active: ActiveTurn,
    request: Extract<ProviderEvent, { type: "input" }>["request"],
  ): void {
    this.flushStreaming(active);
    const pending: AgentInputRequest = {
      id: request.requestId,
      providerId: active.turn.providerId,
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      questions: request.questions,
      autoResolutionMs: request.autoResolutionMs,
    };
    active.inputIds.add(pending.id);
    this.pendingInputs.set(pending.id, pending);
    this.transition(active, "waiting-for-input");
    this.projectWaiting(
      active,
      "input",
      pending.questions[0]?.question ?? "Waiting for an answer",
    );
    this.hooks.broadcast({ type: "agent.input.requested", request: pending });
    this.hooks.broadcastSnapshot();
  }

  private resolveInput(active: ActiveTurn, requestId: string): void {
    const pending = this.pendingInputs.get(requestId);
    if (!pending || pending.turnId !== active.turn.id || pending.runId !== active.turn.runId) return;
    this.pendingInputs.delete(requestId);
    active.inputIds.delete(requestId);
    this.hooks.broadcast({
      type: "agent.input.resolved",
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      requestId,
    });
    this.refreshWaitingState(active);
  }

  private refreshWaitingState(active: ActiveTurn): void {
    if (active.settled) return;
    const approval = [...active.approvalIds]
      .map((id) => this.pendingApprovals.get(id))
      .find(Boolean);
    if (approval) {
      this.transition(active, "waiting-for-approval");
      this.projectWaiting(active, "approval", approval.title);
    } else {
      const input = [...active.inputIds]
        .map((id) => this.pendingInputs.get(id))
        .find(Boolean);
      if (input) {
        this.transition(active, "waiting-for-input");
        this.projectWaiting(
          active,
          "input",
          input.questions[0]?.question ?? "Waiting for an answer",
        );
      } else {
        this.transition(active, "running");
        this.projectConversation(active, "running");
      }
    }
    this.hooks.broadcastSnapshot();
  }

  private projectWaiting(
    active: ActiveTurn,
    attentionKind: "approval" | "input",
    detail: string,
  ): void {
    this.store.updateConversation(active.conversation.id, {
      status: "needs-input",
      attentionKind,
    });
    if (active.workspaceRunCreated) {
      this.store.updateWorkspaceRun(active.turn.runId, {
        status: "waiting",
        detail,
      });
    }
  }

  private projectConversation(active: ActiveTurn, status: Conversation["status"]): void {
    this.store.updateConversation(active.conversation.id, {
      status,
      attentionKind: null,
    });
    if (active.workspaceRunCreated && (status === "running" || status === "idle")) {
      this.store.updateWorkspaceRun(active.turn.runId, {
        status: status === "running" ? "running" : "cancelled",
        detail: active.conversation.title,
      });
    }
  }

  private settle(
    active: ActiveTurn,
    status: AgentTurnTerminalStatus,
    cause: TurnTerminalCause,
    message?: string,
  ): boolean {
    if (active.settled) return false;
    active.settled = true;
    active.acceptingProviderEvents = false;
    if (active.timeoutTimer !== null) this.scheduler.clearTimeout(active.timeoutTimer);

    let persistenceError: string | null = null;
    const notePersistenceError = (error: unknown): void => {
      const detail = this.publicError(error);
      persistenceError = persistenceError ? `${persistenceError}; ${detail}` : detail;
    };
    try {
      active.assistantStream.flush();
    } catch (error) {
      notePersistenceError(error);
    }
    try {
      active.reasoningStream.flush();
    } catch (error) {
      notePersistenceError(error);
    }
    try {
      this.settleRunningActivities(
        active,
        status === "failed" || status === "interrupted" ? "failed" : "completed",
      );
    } catch (error) {
      notePersistenceError(error);
    }
    if (active.reasoningId) {
      try {
        this.store.updateReasoning(active.reasoningId, {
          content: active.reasoningText,
          status: status === "failed" || status === "interrupted" ? "failed" : "completed",
        });
      } catch (error) {
        notePersistenceError(error);
      }
    }

    const terminalReason = persistenceError
      ? `${cause}: ${persistenceError}`.slice(0, 4_000)
      : cause;
    let artifactCapture: void | Promise<void>;
    try {
      const captureAfter = () => this.hooks.captureGitArtifacts?.({
          turn: active.turn,
          checkpointId: active.checkpointId,
          terminalAssistantMessageId: active.assistantMessageId,
        });
      artifactCapture = active.gitBeforeCapture
        ? active.gitBeforeCapture.then(captureAfter)
        : captureAfter();
    } catch {
      artifactCapture = undefined;
    }
    if (
      artifactCapture
      && typeof (artifactCapture as Promise<void>).then === "function"
    ) {
      this.track(Promise.resolve(artifactCapture)
        .catch(() => undefined)
        .then(() => {
          this.finalizeSettlementGuarded(active, status, terminalReason, message);
        }));
      return true;
    }
    return this.finalizeSettlementGuarded(active, status, terminalReason, message);
  }

  private finalizeSettlementGuarded(
    active: ActiveTurn,
    status: AgentTurnTerminalStatus,
    terminalReason: string,
    message?: string,
  ): boolean {
    try {
      return this.finalizeSettlement(active, status, terminalReason, message);
    } catch {
      try {
        const latest = this.store.agentTurn(active.turn.id);
        active.turn = isAgentTurnTerminalStatus(latest.status)
          ? latest
          : this.store.settleAgentTurn(active.turn.id, {
              status: "failed",
              terminalAssistantMessageId: active.assistantMessageId,
              providerSessionAfter: active.sessionAfter,
              terminalReason: "stream-persistence-failed",
              checkpointId: active.checkpointId,
              usageAtCompletion: active.lastUsage,
              completedAt: this.now(),
              updatedAt: this.now(),
            }).turn;
      } catch {
        // Runtime recovery repairs any lifecycle row that could not be settled.
      }
      this.cleanup(active);
      try {
        this.store.updateConversation(active.conversation.id, {
          status: "failed",
          attentionKind: null,
        });
        if (active.workspaceRunCreated) {
          this.store.updateWorkspaceRun(active.turn.runId, {
            status: "failed",
            detail: "The turn could not be finalized cleanly.",
          });
        }
      } catch {
        // Workspace activity is a repairable projection.
      }
      try {
        this.hooks.broadcast({
          type: "agent.failed",
          conversationId: active.conversation.id,
          runId: active.turn.runId,
          turnId: active.turn.id,
          message: "The turn could not be finalized cleanly.",
        });
        this.hooks.broadcastSnapshot();
      } catch {
        // A renderer connection must not keep the controller wedged.
      }
      return false;
    }
  }

  private finalizeSettlement(
    active: ActiveTurn,
    status: AgentTurnTerminalStatus,
    terminalReason: string,
    message?: string,
  ): boolean {
    const settlement = this.store.settleAgentTurn(active.turn.id, {
      status,
      terminalAssistantMessageId: active.assistantMessageId,
      providerSessionAfter: active.sessionAfter,
      terminalReason,
      checkpointId: active.checkpointId,
      usageAtCompletion: active.lastUsage,
      completedAt: this.now(),
      updatedAt: this.now(),
    });
    active.turn = settlement.turn;
    this.cleanup(active);
    if (!settlement.settled) return false;

    const projectedStatus: Conversation["status"] = status === "completed"
      ? "completed"
      : status === "cancelled"
        ? "idle"
        : "failed";
    try {
      if (active.sessionAfter && active.sessionAfter !== active.conversation.providerSessionId) {
        this.store.updateConversation(active.conversation.id, {
          providerSessionId: active.sessionAfter,
          continuationIdentity: active.turn.continuationIdentity,
        });
      }
      this.store.updateConversation(active.conversation.id, {
        status: projectedStatus,
        attentionKind: null,
      });
      if (active.workspaceRunCreated) {
        this.store.updateWorkspaceRun(active.turn.runId, {
          status: status === "completed"
            ? "succeeded"
            : status === "cancelled"
              ? "cancelled"
              : "failed",
          detail: message ?? active.conversation.title,
        });
      }
    } catch {
      // Projections are repairable; the guarded agent_turns row is lifecycle truth.
    }
    if (status === "failed" || status === "interrupted") {
      const failureMessage = message ?? (
        status === "interrupted"
          ? "The agent turn was interrupted."
          : "The provider could not complete the request."
      );
      try {
        const activity = this.store.addActivity({
          conversationId: active.conversation.id,
          runId: active.turn.runId,
          turnId: active.turn.id,
          kind: "error",
          title: failureMessage,
          detail: null,
          status: "failed",
        });
        this.hooks.broadcast({ type: "agent.activity", activity });
      } catch {
        // A failed error projection cannot replace the authoritative outcome.
      }
      this.hooks.broadcast({
        type: "agent.failed",
        conversationId: active.conversation.id,
        runId: active.turn.runId,
        turnId: active.turn.id,
        message: failureMessage,
      });
    } else {
      this.hooks.broadcast({
        type: "agent.completed",
        conversationId: active.conversation.id,
        runId: active.turn.runId,
        turnId: active.turn.id,
      });
    }
    this.hooks.broadcastSnapshot();

    this.track(this.hooks.refreshProviderMetadata?.({
      providerId: active.turn.providerId,
      conversationId: active.conversation.id,
      turnId: active.turn.id,
      runStartedAt: active.runStartedAt,
      status,
    }));
    this.track(this.hooks.onTurnSettled?.(active.turn));
    this.track(active.onSettled?.(status, active.turn.id));
    return true;
  }

  private settleRunningActivities(
    active: ActiveTurn,
    status: AgentActivity["status"],
  ): void {
    for (const activities of active.runningActivities.values()) {
      for (const pending of activities) {
        const activity = this.store.updateActivity(pending.id, { status });
        this.syncProviderCommandRun(active, activity);
        this.hooks.broadcast({ type: "agent.activity", activity });
      }
    }
    active.runningActivities.clear();
  }

  private cleanup(active: ActiveTurn): void {
    active.assistantStream.dispose();
    active.reasoningStream.dispose();
    for (const requestId of active.approvalIds) this.pendingApprovals.delete(requestId);
    for (const requestId of active.inputIds) this.pendingInputs.delete(requestId);
    active.approvalIds.clear();
    active.inputIds.clear();
    this.activeByConversation.delete(active.conversation.id);
    this.activeByTurn.delete(active.turn.id);
  }

  private track(value: void | Promise<void> | undefined): void {
    if (!value) return;
    const task = Promise.resolve(value)
      .catch(() => undefined)
      .finally(() => {
        this.settlementTasks.delete(task);
        this.hooks.broadcastSnapshot();
      });
    this.settlementTasks.add(task);
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private publicError(error: unknown): string {
    return error instanceof Error && error.message ? error.message : "The agent turn failed.";
  }
}
