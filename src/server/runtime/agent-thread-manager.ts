import { z } from "zod";

import type {
  AgentApprovalRequest,
  AgentInputRequest,
  AgentTurn,
  Conversation,
  ProviderInfo,
  RuntimeMutationEvent,
} from "../../shared/contracts";
import {
  providerIdForHarness,
  type ModelSelection,
} from "../../shared/model-routing";
import type { RuntimeStore } from "../database";
import {
  AGENT_THREAD_MAX_DEPTH,
  agentThreadClientRequestKey,
  type AgentThreadMutationTool,
  type AgentThreadOperation,
} from "../persistence/agent-thread-management-repository";
import type {
  ProviderHostToolBridge,
  ProviderHostToolCall,
  ProviderHostToolResult,
} from "../provider/contracts";
import type { ProviderTerminalResumeRegistry } from "../provider/terminal-resume";
import type { ProviderManager } from "../providers";
import type { BackendProfileController } from "./backends/backend-profile-controller";
import type { ConversationCreationService } from "./conversation-creation-service";
import type {
  ConversationContextRequestCoordinator,
} from "./conversation-context-request-coordinator";
import type { ConversationAttachmentStore } from "../../node/conversation-attachment-store";
import {
  AGENT_CONTEXT_TOOL_DEFINITION,
  AGENT_CONTEXT_TOOL_NAME,
  AgentContextTool,
  imagesAccepted,
  type AgentContextWatcherPolicy,
} from "./agent-context-tool";
import { hostToolDigest as digest } from "./host-tool-digest";
import { routeSchema } from "./agent-thread-schemas";
import {
  AGENT_THREAD_TOOL_DEFINITIONS, archiveSchema, createSchema, inspectSchema, listSchema, MAX_LATEST_RESULT_BYTES,
} from "./agent-thread-tool-definitions";
import { MODEL_LIST_TOOL_NAME, listAcceptedModelRoutes, resolveRouteSelection } from "./agent-model-routes";
import { invalidHostToolArguments } from "./host-tool-argument-errors";
import type { TurnController } from "./turns/turn-controller";
import {
  AGENT_BROWSER_TOOL_NAMES,
  AgentBrowserHostTools,
} from "./agent-browser-host-tools";
import { CAD_TOOL_NAMES, type CadHostTools } from "./cad-host-tools";
import type {
  RuntimeAgentBrowserBroker,
} from "./agent-browser-broker-client";
import {
  type HarnessCapabilityManifest,
  type HarnessCapabilityRegistry,
  type HarnessCapabilityTurnOffer,
} from "./harness-capabilities";
import {
  BROWSER_ACCESS_DISABLED,
  CAD_ACCESS_DISABLED,
  createInertiaHarnessCapabilities,
  inertiaCapabilityOfferForProject,
} from "./inertia-harness-capabilities";
import { CachedThreadToolRegistrations } from "./thread-tool-registrations";
import { HTML_RENDER_TOOL_NAME } from "../../shared/html-render";
import { HtmlRenderHostTool } from "./html-render-host-tool";
import { SEND_TO_USER_TOOL_NAME } from "../../shared/send-to-user";
import { SendToUserHostTool } from "./send-to-user-host-tool";
import { WORKSPACE_TOOL_NAMES, WorkspaceHostTools, type WorkspaceHostToolDependencies } from "./workspace-host-tools";
import { SECRET_REQUEST_TOOL_NAME, SECRET_VALUE_EXPOSURE_MESSAGE } from "../../node/agent-secrets";
import type { AgentSecretHostToolSource } from "./agent-secrets/agent-secret-service";
import { recordQueuedManagedTurn, stopManagedTurnForAgent } from "./managed-turn-ownership";
import {
  AGENT_THREAD_WAIT_TOOL_NAME,
  managedConversationStatus,
  waitForManagedConversation,
} from "./agent-thread-wait";
import { ManagedMutationQueue } from "./managed-mutation-queue";
import { readForkHistoryTool } from "./fork-history-tool";
import type { DelegationTaskService } from "./delegation/task-service";
import {
  assertInteractionWithinParent, CANCEL_TASK_TOOL, DELEGATE_TASK_TOOL, delegateApprovalSuffix,
  delegateCreateInput, delegatedTaskTitle, delegateTaskSchema, delegateWake, delegationToolFailure, followUpApprovalSuffix,
  TASK_STATUS_TOOL, TASK_WAIT_TOOL, taskCancelSchema, taskReadSchema, taskWaitSchema,
  type DelegateTaskInput,
} from "./delegation/task-tools";
import { DelegatedWaitAbortedError, delegatedWaitTimeout } from "./delegation/task-wait";
import {
  RESTART_IDLE, agentSenderHiddenInstruction, assertAccessWithinParent, assertManagedDispatchCeiling,
  dispatchManagedSend, managedSendApprovalDetail, preflightManagedSend, sendSchema,
  type ManagedFollowUpLink, type ManagedMessageQueue, type SendMode,
} from "./managed-send-modes";
import {
  MANAGED_QUEUE_TOOL_NAME, executeManagedQueueMutation, executeManagedQueueRead, isManagedQueueReadAction,
  managedQueueApprovalDetail, managedQueueInputChars, managedQueueSchema, shouldAutoApproveManagedMutation,
} from "./managed-queue-tools";
import {
  EXTENDED_FULL_ACCESS_AUTO_APPROVED_TOOLS, executeExtendedManagedTool, extendedManagedInputChars,
  extendedManagedOperationTool, isExtendedManagedReadTool, isExtendedManagedTool, preflightExtendedManagedTool,
} from "./managed-extended-tools";
import {
  ANSWER_QUESTION_TOOL_NAME,
  answerApprovalDetail,
  answerQuestionSchema,
  findPendingQuestion,
  sendQuestionAnswer,
  type ManagedQuestionDependencies,
} from "./managed-child-questions";
import type { TurnCapabilityOffer } from "./turns/turn-controller-types";
import {
  boundedUntrustedAgentText,
  neutralizeUntrustedAgentText,
} from "./untrusted-agent-text";

const MAX_ACTIVE_CHILDREN = 3;
const MAX_CANCELLED_DELEGATE_WAITS = 64;
const STORED_CONTENT_TOOLS = new Set([
  HTML_RENDER_TOOL_NAME, SEND_TO_USER_TOOL_NAME, SECRET_REQUEST_TOOL_NAME, "inertia_create_conversation", "inertia_send_message",
  MANAGED_QUEUE_TOOL_NAME, ANSWER_QUESTION_TOOL_NAME, DELEGATE_TASK_TOOL, CANCEL_TASK_TOOL,
  ...EXTENDED_FULL_ACCESS_AUTO_APPROVED_TOOLS,
]);
const LATEST_RESULT_RUNNING_NEXT = "Still running; wait for it with inertia_wait_for_conversation, then call inertia_get_latest_result again.";
const TERMINAL_TURN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

interface AgentThreadSource {
  conversation: Conversation;
  turn: AgentTurn;
}

interface ApprovalDetail {
  title: string;
  detail: string;
  permissionRoots: Array<{ path: string; access: "write" }>;
}

export interface AgentThreadManagerDependencies {
  store: RuntimeStore;
  providers: ProviderManager;
  backendProfileController: BackendProfileController;
  creation: ConversationCreationService;
  turns: TurnController;
  providerTerminalResumes: Pick<
    ProviderTerminalResumeRegistry,
    "acquire" | "isActive" | "release"
  >;
  contextRequests: ConversationContextRequestCoordinator;
  /** Provider questions awaiting an answer, shared with the turn controller. */
  pendingInputs?: ReadonlyMap<string, AgentInputRequest>;
  /** Provider approvals awaiting the user, read only to refuse answering one. */
  pendingApprovals?: ReadonlyMap<string, AgentApprovalRequest>;
  /** Resolved per call: the queue runtime starts after this manager. */
  messageQueue?(): ManagedMessageQueue | undefined;
  isCompacting?(conversationId: string): boolean;
  conversationAttachments?: Pick<ConversationAttachmentStore, "preview">;
  watcherPolicy?: AgentContextWatcherPolicy;
  agentBrowser?: RuntimeAgentBrowserBroker;
  delegation?: DelegationTaskService;
  turnGitArtifacts?: WorkspaceHostToolDependencies["turnGitArtifacts"];
  workspaceRuns?: WorkspaceHostToolDependencies["workspaceRuns"];
  cadTools?: CadHostTools;
  agentSecrets?: {
    containsSecret(value: unknown): boolean;
    invoke(source: AgentSecretHostToolSource, call: ProviderHostToolCall): Promise<ProviderHostToolResult>;
  };
  providerInfo(): readonly ProviderInfo[];
  broadcastSnapshot(): void;
  broadcastConversationShell(conversationId: string): void;
  broadcast(event: RuntimeMutationEvent): void;
  now?(): string;
}

function json(value: unknown): ProviderHostToolResult {
  return { success: true, text: JSON.stringify(value) };
}

function failure(code: string, message: string): ProviderHostToolResult {
  return { success: false, text: JSON.stringify({ error: { code, message } }) };
}

function caller(source: AgentThreadSource): { conversationId: string; turnId: string } {
  return { conversationId: source.conversation.id, turnId: source.turn.id };
}

function replayOperation(operation: AgentThreadOperation, toolName: AgentThreadMutationTool,
  requestFingerprint: string): ProviderHostToolResult {
  if (operation.toolName !== toolName || operation.requestFingerprint !== requestFingerprint) {
    return failure("idempotency_conflict", "This provider tool-call identity was reused with different input.");
  }
  if (operation.status === "completed" && operation.resultJson) return { success: true, text: operation.resultJson };
  return failure("operation_not_replayable", `The original operation is ${operation.status}; Inertia will not repeat it.`);
}

// Titles and branch names can be authored by another agent run: a parent's
// create call, a title regenerated from a model-sent message, or a branch a
// child created. Neutralize them like any other cross-agent text.
function safeConversation(conversation: Conversation, managed: boolean): unknown {
  return {
    conversationId: conversation.id,
    title: neutralizeUntrustedAgentText(conversation.title),
    providerId: conversation.providerId,
    route: {
      harnessId: conversation.modelSelection.harnessId,
      backendProfileId: conversation.modelSelection.backendProfileId,
      modelId: conversation.modelSelection.modelId,
      reasoningEffort: conversation.modelSelection.reasoningEffort,
    },
    interactionMode: conversation.interactionMode,
    accessMode: conversation.accessMode,
    workspace: conversation.worktreePath ? "attached-worktree" : "project",
    branch: conversation.branch === null
      ? null
      : neutralizeUntrustedAgentText(conversation.branch),
    status: conversation.status,
    archived: conversation.archivedAt !== null,
    managedByCaller: managed,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

export class AgentThreadManager {
  private readonly now: () => string;
  private readonly mutations = new ManagedMutationQueue();
  /**
   * Delegations whose wait was cancelled after the child chat was created, by source turn and request. An entry
   * lives only while the agent has never seen that task's handle: a status, wait or cancel call names it and
   * removes it.
   */
  private readonly cancelledDelegateWaits = new Map<string, { taskId: string; created: string }>();
  private readonly agentBrowser: AgentBrowserHostTools | undefined;
  private readonly capabilities: HarnessCapabilityRegistry;
  private readonly htmlRenders: HtmlRenderHostTool;
  private readonly sentToUser: SendToUserHostTool;
  private readonly workspaceTools: WorkspaceHostTools;
  private readonly contextTool: AgentContextTool;

  constructor(private readonly dependencies: AgentThreadManagerDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.agentBrowser = dependencies.agentBrowser
      ? new AgentBrowserHostTools(dependencies.agentBrowser)
      : undefined;
    this.htmlRenders = new HtmlRenderHostTool(dependencies);
    this.sentToUser = new SendToUserHostTool(dependencies);
    this.workspaceTools = new WorkspaceHostTools(dependencies);
    this.contextTool = new AgentContextTool({
      ...dependencies,
      now: this.now,
      assertSource: (source) => this.assertSource(source),
    });
    this.capabilities = createInertiaHarnessCapabilities({
      orchestrationTools: AGENT_THREAD_TOOL_DEFINITIONS,
      browserEnabled: this.agentBrowser !== undefined,
      secretsEnabled: dependencies.agentSecrets !== undefined,
      cadEnabled: dependencies.cadTools !== undefined,
      invoke: async (context, call) => await this.invoke(context, call),
      threadRegistrations: new CachedThreadToolRegistrations(dependencies.store.codexThreadToolPacks),
    });
  }

  /**
   * Snapshots the packs this conversation's project offers its next turn.
   * The turn controller hands the instructions to the once-per-session
   * delivery and passes the same offer back to `bridgeFor` when the provider
   * starts.
   */
  capabilityOfferForTurn(
    conversation: Pick<Conversation, "projectId">,
  ): TurnCapabilityOffer {
    const offer = this.currentOffer(conversation);
    return { instructions: this.capabilities.instructions(offer), offer };
  }

  capabilityManifest(): HarnessCapabilityManifest {
    return this.capabilities.manifest();
  }

  /**
   * The exact-turn bridge for a snapshotted offer. Without one, the project's
   * current settings decide.
   */
  bridgeFor(
    source: AgentThreadSource,
    offer: HarnessCapabilityTurnOffer = this.currentOffer(source.conversation),
  ): ProviderHostToolBridge {
    return this.capabilities.bridgeFor(source, offer);
  }

  private currentOffer(conversation: Pick<Conversation, "projectId">): HarnessCapabilityTurnOffer {
    return inertiaCapabilityOfferForProject(
      this.dependencies.store.project(conversation.projectId).preferences,
    );
  }

  contextOnlyBridgeFor(source: AgentThreadSource): ProviderHostToolBridge {
    return {
      definitions: [AGENT_CONTEXT_TOOL_DEFINITION],
      retiredToolNames: new Set<string>(),
      invoke: async (call) => call.tool === AGENT_CONTEXT_TOOL_NAME
        ? await this.invoke(source, call)
        : failure("unknown_tool", "That Inertia host tool is not available."),
    };
  }

  async onSourceTurnSettled(turn: AgentTurn): Promise<void> {
    this.dependencies.contextRequests.cancelForTurn(turn.conversationId, turn.id);
    for (const key of this.cancelledDelegateWaits.keys()) {
      if (key.startsWith(`${turn.id}:`)) this.cancelledDelegateWaits.delete(key);
    }
    if (turn.status === "completed" || this.limitHeld(turn)) return;
    const targets = this.dependencies.store.agentThreadManagement
      .runsDispatchedByTurn(turn.conversationId, turn.id);
    for (const target of targets) {
      this.dependencies.turns.cancelOwned(target.conversationId, target);
    }
  }

  private limitHeld(turn: AgentTurn): boolean {
    const resets = this.dependencies.store.limitResets;
    if (turn.status !== "failed" || !resets.usageLimited(turn.id)) return false;
    const plan = resets.get(turn.conversationId);
    return plan?.failedTurnId !== turn.id || !["cancelled", "blocked", "missed"].includes(plan.state);
  }

  private automaticWakes(): boolean {
    return this.dependencies.store.appSettings().delegationAutomaticWakes;
  }

  private assertSource(source: AgentThreadSource): Conversation {
    const turn = this.dependencies.store.assertAgentTurnIdentity(
      source.conversation.id,
      source.turn.runId,
      source.turn.id,
    );
    if (TERMINAL_TURN_STATUSES.has(turn.status)) {
      throw new Error("The originating Inertia turn is no longer active.");
    }
    const conversation = this.dependencies.store.conversation(
      source.conversation.id,
    );
    if (conversation.projectId !== source.conversation.projectId) {
      throw new Error("The originating project authority changed.");
    }
    return conversation;
  }

  private async invoke(
    source: AgentThreadSource,
    call: ProviderHostToolCall,
  ): Promise<ProviderHostToolResult> {
    const startedAt = performance.now();
    try {
      const current = this.assertSource(source);
      if (call.signal.aborted) return failure("call_cancelled", "The host tool call was cancelled.");
      if (STORED_CONTENT_TOOLS.has(call.tool) && this.dependencies.agentSecrets?.containsSecret(call.arguments)) {
        return failure("secret_value_not_allowed", SECRET_VALUE_EXPOSURE_MESSAGE);
      }
      if (call.tool === HTML_RENDER_TOOL_NAME) return this.htmlRenders.invoke({ conversation: current, turn: source.turn }, call);
      if (call.tool === SEND_TO_USER_TOOL_NAME) return this.sentToUser.invoke({ conversation: current, turn: source.turn }, call);
      if (WORKSPACE_TOOL_NAMES.has(call.tool)) return await this.workspaceTools.invoke({ conversation: current, turn: source.turn }, call);
      if (call.tool === SECRET_REQUEST_TOOL_NAME && this.dependencies.agentSecrets) {
        return await this.dependencies.agentSecrets.invoke({ conversation: current, turn: source.turn }, call);
      }
      if (this.dependencies.cadTools && CAD_TOOL_NAMES.has(call.tool)) {
        // As with Browser access, this covers the setting turned off mid-turn.
        if (this.dependencies.store.project(current.projectId).preferences?.cadAccess !== true) {
          return failure(CAD_ACCESS_DISABLED.code, CAD_ACCESS_DISABLED.message);
        }
        return await this.dependencies.cadTools.invoke(
          call,
          imagesAccepted(source.turn, this.dependencies.providerInfo()),
          this.dependencies.store.conversationPath(current.id),
        );
      }
      if (this.agentBrowser && AGENT_BROWSER_TOOL_NAMES.has(call.tool)) {
        // The turn's offer already withholds these tools when Browser access
        // was off at turn start; this covers a setting changed mid-turn.
        if (this.dependencies.store.project(current.projectId).preferences?.browserAccess === false) {
          return failure(BROWSER_ACCESS_DISABLED.code, BROWSER_ACCESS_DISABLED.message);
        }
        return await this.agentBrowser.invoke(current, call, {
          conversationId: current.id,
          runId: source.turn.runId,
          turnId: source.turn.id,
        }, imagesAccepted(source.turn, this.dependencies.providerInfo()));
      }
      if (isExtendedManagedTool(call.tool)) {
        const extendedTool = call.tool;
        const deps = { ...this.dependencies, now: this.now, assertSource: () => this.assertSource(source),
          managedTarget: (c: Conversation, id: string) => this.managedTarget(c, id),
          resolveSelection: (c: Conversation, route: z.infer<typeof routeSchema> | undefined) => this.resolveSelection(c, route),
          assertRouteReady: (selection: ModelSelection) => this.assertRouteReady(selection),
          activeManagedChildren: (id: string) => this.activeManagedChildren(id) };
        if (isExtendedManagedReadTool(extendedTool)) return await executeExtendedManagedTool(deps, source, extendedTool, call.arguments, "", call.signal);
        const approval = await preflightExtendedManagedTool(deps, extendedTool, call.arguments);
        return await this.mutate(source, call, extendedManagedOperationTool(extendedTool),
          (operationId, signal) => executeExtendedManagedTool(deps, source, extendedTool, call.arguments, operationId, signal),
          undefined, approval,
          { fingerprintToolName: extendedTool, inputChars: extendedManagedInputChars(extendedTool, call.arguments),
            autoApproveToolName: extendedTool, skipPreflight: true });
      }
      switch (call.tool) {
        case "inertia_fork_history":
          return readForkHistoryTool(this.dependencies.store, current, call.arguments);
        case "inertia_list_conversations":
          return this.list(current, call.arguments);
        case "inertia_inspect_conversation":
          return this.inspect(current, call.arguments);
        case "inertia_get_conversation_status":
          return this.status(current, call.arguments);
        case AGENT_THREAD_WAIT_TOOL_NAME:
          return await waitForManagedConversation({
            ...this.dependencies,
            assertSource: () => this.assertSource(source),
            managedTarget: (caller, conversationId) => this.managedTarget(caller, conversationId),
            hasArmedDelegationWake: (conversationId) => this.dependencies.store.appSettings().delegationAutomaticWakes
              && this.dependencies.store.orchestration.delegation.reads.tasks("child_conversation_id = ? AND wake_armed = 1 AND status = 'running'", conversationId).length > 0,
          }, call.arguments, call.signal);
        case "inertia_get_latest_result":
          return this.latestResult(current, call.arguments);
        case MODEL_LIST_TOOL_NAME:
          return await listAcceptedModelRoutes(this.dependencies.backendProfileController, this.dependencies.providerInfo(),
            current, call.arguments, call.signal);
        case AGENT_CONTEXT_TOOL_NAME:
          return await this.contextTool.invoke(source, call);
        case "inertia_create_conversation":
          return await this.mutate(source, call, call.tool, (operationId, signal) =>
            this.create(source, call.arguments, operationId, signal));
        case "inertia_send_message": {
          const input = sendSchema.parse(call.arguments);
          const target = this.managedTarget(current, input.conversationId);
          assertManagedDispatchCeiling(current, target);
          // A restart stops exactly the turn running now, never a later one.
          // The identity is kept here rather than on the operation, so a
          // parent that fails before approval cannot cancel that turn.
          const restart = input.mode === "restart"
            ? this.dependencies.turns.activeIdentity(target.id)
            : null;
          if (input.mode === "restart" && !restart) throw new Error(RESTART_IDLE);
          return await this.mutate(source, call, call.tool, (operationId, signal) =>
            this.send(source, call.arguments, operationId, signal, restart));
        }
        case MANAGED_QUEUE_TOOL_NAME: {
          const input = managedQueueSchema.parse(call.arguments);
          const target = this.managedTarget(current, input.conversationId);
          if (isManagedQueueReadAction(input)) return executeManagedQueueRead(this.dependencies, target, input);
          assertManagedDispatchCeiling(current, target);
          return await this.mutate(source, call, "inertia_send_message",
            (operationId, signal) => {
              const liveCaller = this.assertSource(source);
              const liveTarget = this.managedTarget(liveCaller, input.conversationId);
              assertManagedDispatchCeiling(liveCaller, liveTarget);
              return executeManagedQueueMutation({ ...this.dependencies, now: this.now },
                liveCaller, liveTarget, input, operationId, signal);
            },
            undefined, managedQueueApprovalDetail(this.dependencies.store, target, input),
            { fingerprintToolName: MANAGED_QUEUE_TOOL_NAME, inputChars: managedQueueInputChars(input),
              autoApproveToolName: MANAGED_QUEUE_TOOL_NAME, skipPreflight: true });
        }
        case ANSWER_QUESTION_TOOL_NAME: {
          const input = answerQuestionSchema.parse(call.arguments);
          const target = this.managedTarget(current, input.conversationId);
          const request = findPendingQuestion(this.questionDependencies(), target, call.arguments);
          // The card shows the exact question that was found, so a question
          // withdrawn meanwhile cannot leave a reserved operation unasked.
          const approval = {
            title: "Answer a managed chat's question",
            detail: answerApprovalDetail(target.id, request.questions, input.answers),
            permissionRoots: [{ path: this.dependencies.store.conversationPath(target.id), access: "write" as const }],
          };
          return await this.mutate(source, call, ANSWER_QUESTION_TOOL_NAME, (operationId, signal) =>
            this.answer(source, call.arguments, operationId, signal, request), {
              childConversationId: target.id,
              targetTurnId: request.turnId,
              targetRunId: request.runId,
            }, approval);
        }
        case "inertia_stop_conversation": {
          const input = inspectSchema.parse(call.arguments);
          const target = this.managedTarget(current, input.conversationId);
          const identity = this.dependencies.turns.activeIdentity(target.id);
          if (!identity) throw new Error("The managed chat does not have an exact active turn to stop.");
          return await this.mutate(source, call, call.tool, (operationId, signal) =>
            this.stop(source, call.arguments, signal, identity, operationId), {
              childConversationId: target.id,
              targetTurnId: identity.turnId,
              targetRunId: identity.runId,
            });
        }
        case "inertia_archive_conversation":
          return await this.mutate(source, call, call.tool, (_operationId, signal) =>
            this.archive(source, call.arguments, signal));
        case DELEGATE_TASK_TOOL:
          return await this.delegate(source, call, startedAt);
        case TASK_STATUS_TOOL: {
          const { taskId } = taskReadSchema.parse(call.arguments);
          this.forgetCancelledDelegateWait(taskId);
          return json(await this.tasks().status(caller(source), taskId));
        }
        case TASK_WAIT_TOOL: {
          const input = taskWaitSchema.parse(call.arguments);
          this.forgetCancelledDelegateWait(input.taskId);
          return json(await this.tasks().wait(caller(source), input.taskId,
            delegatedWaitTimeout(input.timeoutMs, source.turn.providerId, performance.now() - startedAt), call.signal));
        }
        case CANCEL_TASK_TOOL: {
          const { taskId } = taskCancelSchema.parse(call.arguments);
          this.forgetCancelledDelegateWait(taskId);
          const replay = this.keyedReplay(source, call, call.tool);
          if (replay) return replay;
          const { identity, task } = this.tasks().prepareCancel(current.id, taskId);
          return await this.mutate(source, call, call.tool, async (operationId, signal) => {
            this.assertSource(source);
            if (signal.aborted) throw new Error("The parent turn ended before cancel.");
            return json(await this.tasks().cancel({ task: this.tasks().owned(current.id, taskId), identity }, operationId));
          }, identity ? { childConversationId: task.childConversationId, targetTurnId: identity.turnId,
            targetRunId: identity.runId } : undefined);
        }
        default:
          return failure("unknown_tool", "That Inertia host tool is not available.");
      }
    } catch (error) {
      if (error instanceof DelegatedWaitAbortedError) return failure("call_cancelled", error.message);
      const delegated = delegationToolFailure(error);
      if (delegated) return delegated;
      if (error instanceof z.ZodError) {
        const definition = AGENT_THREAD_TOOL_DEFINITIONS.find(({ name }) => name === call.tool);
        return failure("invalid_arguments", invalidHostToolArguments(call.tool, definition?.inputSchema, call.arguments, error));
      }
      return failure(
        "host_tool_failed",
        error instanceof Error ? error.message.slice(0, 1_000) : "The Inertia host tool failed.",
      );
    }
  }

  private list(source: Conversation, args: unknown): ProviderHostToolResult {
    const input = listSchema.parse(args ?? {});
    const limit = input.limit ?? 10;
    const candidates = this.dependencies.store.projectConversations(source.projectId)
      .filter((conversation) => input.includeArchived || conversation.archivedAt === null)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt, "en"))
      .slice(0, limit + 1);
    const rows = candidates
      .slice(0, limit)
      .map((conversation) => safeConversation(
        conversation,
        this.dependencies.store.agentThreadManagement
          .managedBy(source.id, conversation.id) !== null,
      ));
    return json({ conversations: rows, truncated: candidates.length > limit });
  }

  private sameProject(source: Conversation, conversationId: string): Conversation {
    const target = this.dependencies.store.conversation(conversationId);
    if (target.projectId !== source.projectId) {
      throw new Error("That chat is outside this turn's current-project authority.");
    }
    return target;
  }

  private managedTarget(source: Conversation, conversationId: string): Conversation {
    const target = this.sameProject(source, conversationId);
    if (!this.dependencies.store.agentThreadManagement.managedBy(source.id, target.id)) {
      throw new Error("conversationId: not a chat this chat created; only chats created with inertia_create_conversation can be managed here.");
    }
    return target;
  }

  private inspect(source: Conversation, args: unknown): ProviderHostToolResult {
    const input = inspectSchema.parse(args);
    const target = this.sameProject(source, input.conversationId);
    const managed = this.dependencies.store.agentThreadManagement.managedBy(
      source.id,
      target.id,
    );
    return json({
      conversation: safeConversation(target, managed !== null),
      provenance: managed ? {
        sourceConversationId: managed.sourceConversationId,
        sourceTurnId: managed.sourceTurnId,
        sourceHarnessId: managed.sourceHarnessId,
        depth: managed.depth,
        createdAt: managed.createdAt,
      } : null,
    });
  }

  private status(source: Conversation, args: unknown): ProviderHostToolResult {
    const input = inspectSchema.parse(args);
    const target = this.managedTarget(source, input.conversationId);
    const latest = this.dependencies.store.latestAgentTurnForConversation(target.id);
    const observed = this.dependencies.store.observedChildren;
    return json({
      ...managedConversationStatus(this.dependencies, target),
      task: this.dependencies.delegation?.latestTaskFor(source.id, target.id) ?? null,
      nativeChildren: latest ? { live: observed.liveNativeChildren(target.id, latest.id).count,
        total: observed.traces({ conversationId: target.id, turnId: latest.id }).traces.length } : { live: 0, total: 0 },
    });
  }

  private latestResult(source: Conversation, args: unknown): ProviderHostToolResult {
    const input = inspectSchema.parse(args);
    const target = this.managedTarget(source, input.conversationId);
    const latest = this.dependencies.store.latestAgentTurnForConversation(target.id);
    if (!latest?.terminalAssistantMessageId) {
      const running = this.dependencies.turns.isActive(target.id)
        || (latest !== null && !TERMINAL_TURN_STATUSES.has(latest.status));
      const next = running
        ? LATEST_RESULT_RUNNING_NEXT
        : latest
          ? `The latest turn ended (${latest.status}) without a reply; read inertia_get_conversation_status for its terminal reason.`
          : undefined;
      return json({
        conversationId: target.id,
        result: null,
        persisted: true,
        ...(next ? { next } : {}),
      });
    }
    const message = this.dependencies.store.message(
      latest.terminalAssistantMessageId,
    );
    if (message.role !== "assistant") {
      throw new Error("The persisted terminal result is not an assistant message.");
    }
    // Another model wrote this text, so neutralize instruction-shaped content
    // before handing it to this one. Neutralizing first keeps the byte cap.
    const content = boundedUntrustedAgentText(
      message.content,
      MAX_LATEST_RESULT_BYTES,
    );
    return json({
      conversationId: target.id,
      turnId: latest.id,
      status: latest.status,
      result: content.text,
      truncated: content.truncated,
      neutralized: content.neutralized,
      persisted: true,
      source: "visible-assistant-message",
    });
  }

  private async mutate(
    source: AgentThreadSource,
    call: ProviderHostToolCall,
    toolName: AgentThreadMutationTool,
    execute: (
      operationId: string,
      signal: AbortSignal,
    ) => Promise<ProviderHostToolResult>,
    target?: { childConversationId: string; targetTurnId: string; targetRunId: string },
    approval?: ApprovalDetail,
    options?: {
      fingerprintToolName?: string;
      inputChars?: number;
      autoApproveToolName?: string;
      skipPreflight?: boolean;
    },
  ): Promise<ProviderHostToolResult> {
    const requestFingerprint = digest({ toolName: options?.fingerprintToolName ?? toolName, arguments: call.arguments });
    const clientRequestKey = this.clientRequestKey(source, toolName, call.arguments);
    const replay = this.keyedReplay(source, call, toolName);
    if (replay) return replay;
    if (!options?.skipPreflight) await this.preflightMutation(source, toolName, call.arguments);
    if (call.signal.aborted) {
      return failure("call_cancelled", "The parent turn ended before approval.");
    }
    const inputChars = options?.inputChars ?? (toolName === "inertia_create_conversation"
      ? createSchema.parse(call.arguments).prompt.length
      : toolName === "inertia_send_message"
        ? sendSchema.parse(call.arguments).content.length
        : toolName === ANSWER_QUESTION_TOOL_NAME
          ? answerQuestionSchema.parse(call.arguments).answers.reduce((sum, answer) => sum + (answer.text?.length ?? 0), 0)
          : toolName === DELEGATE_TASK_TOOL ? delegateTaskSchema.parse(call.arguments).task.length : 0);
    const reserved = this.dependencies.store.agentThreadManagement.reserve({
      sourceConversationId: source.conversation.id,
      sourceTurnId: source.turn.id,
      sourceRunId: source.turn.runId,
      toolCallId: call.toolCallId,
      toolName,
      requestFingerprint,
      inputChars,
      now: this.now(),
      ...(clientRequestKey === undefined ? {} : { clientRequestKey }),
    });
    if (reserved.kind === "limit") return failure("budget_exceeded", reserved.reason);
    if (reserved.kind !== "reserved") return replayOperation(reserved.operation, toolName, requestFingerprint);
    if (target) this.dependencies.store.agentThreadManagement.transition(
      reserved.operation.id, ["approval-pending"], "approval-pending", target, this.now(),
    );
    const liveSource = this.dependencies.store.conversation(source.conversation.id);
    const autoApproveTool = options?.autoApproveToolName ?? toolName;
    if (!shouldAutoApproveManagedMutation(liveSource.accessMode, autoApproveTool)
      && !(liveSource.accessMode === "full" && EXTENDED_FULL_ACCESS_AUTO_APPROVED_TOOLS.has(autoApproveTool))) {
      const detail = approval ?? this.approvalDetail(source, toolName, call.arguments);
      const decision = await call.requestApproval({
        title: detail.title, detail: detail.detail,
        reason: "A model requested a top-level Inertia chat lifecycle action.",
        permissionRoots: detail.permissionRoots,
      });
      if (decision !== "approve") {
        this.dependencies.store.agentThreadManagement.transition(reserved.operation.id, ["approval-pending"], "denied", {
          failureMessage: decision === "cancel" ? "Cancelled by the user."
            : decision === "timeout" ? "The approval timed out." : "Denied by the user.",
        }, this.now());
        return decision === "timeout"
          ? failure("approval_timed_out", `The user did not answer the approval in time. Ask the user to try again, then call ${toolName} again.`)
          : failure("user_denied", "The user did not approve this chat action.");
      }
    }
    this.dependencies.store.agentThreadManagement.transition(reserved.operation.id, ["approval-pending"], "approved", {}, this.now());
    if (call.signal.aborted) {
      this.dependencies.store.agentThreadManagement.transition(
        reserved.operation.id,
        ["approved"],
        "interrupted",
        { failureMessage: "The parent turn ended after approval." },
        this.now(),
      );
      return failure("call_cancelled", "The parent turn ended after approval.");
    }
    try {
      const result = await this.mutations.run(
        source.conversation.id,
        async () => {
          if (call.signal.aborted) {
            throw new Error("The parent turn ended before the approved action began.");
          }
          return await execute(reserved.operation.id, call.signal);
        },
      );
      const terminal = this.dependencies.store.agentThreadManagement.operation(
        reserved.operation.id,
      );
      if (terminal && terminal.status !== "completed") {
        this.dependencies.store.agentThreadManagement.transition(
          reserved.operation.id,
          [terminal.status],
          result.success ? "completed" : "failed",
          {
            resultJson: result.text,
            failureMessage: result.success ? null : "The chat action failed.",
          },
          this.now(),
        );
      }
      return result;
    } catch (error) {
      const operation = this.dependencies.store.agentThreadManagement.operation(
        reserved.operation.id,
      );
      if (operation && !["completed", "failed", "denied", "interrupted"].includes(operation.status)) {
        this.dependencies.store.agentThreadManagement.transition(
          operation.id,
          [operation.status],
          call.signal.aborted ? "interrupted" : "failed",
          { failureMessage: error instanceof Error ? error.message.slice(0, 1_000) : "The chat action failed." },
          this.now(),
        );
      }
      throw error;
    }
  }

  private clientRequestKey(source: AgentThreadSource, toolName: AgentThreadMutationTool, args: unknown): string | undefined {
    const clientRequestId = toolName === DELEGATE_TASK_TOOL ? delegateTaskSchema.parse(args).clientRequestId
      : toolName === CANCEL_TASK_TOOL ? taskCancelSchema.parse(args).clientRequestId : undefined;
    return clientRequestId === undefined ? undefined : agentThreadClientRequestKey({
      sourceConversationId: source.conversation.id, toolName, clientRequestId,
      providerBackingId: this.dependencies.store.agentThreadManagement.providerBackingNamespace(source.conversation.id, source.turn.runId),
    });
  }

  private keyedReplay(source: AgentThreadSource, call: ProviderHostToolCall, toolName: AgentThreadMutationTool):
    ProviderHostToolResult | null {
    const clientRequestKey = this.clientRequestKey(source, toolName, call.arguments);
    const keyed = clientRequestKey === undefined ? null
      : this.dependencies.store.agentThreadManagement.operationByClientRequestKey(source.conversation.id, clientRequestKey);
    return keyed ? replayOperation(keyed, toolName, digest({ toolName, arguments: call.arguments })) : null;
  }

  private async preflightMutation(
    source: AgentThreadSource,
    toolName: AgentThreadMutationTool,
    args: unknown,
  ): Promise<void> {
    const current = this.assertSource(source);
    if (toolName === DELEGATE_TASK_TOOL) {
      const input = delegateTaskSchema.parse(args);
      const created = delegateCreateInput(input, current);
      assertInteractionWithinParent(created.interactionMode, current.interactionMode);
      return await this.preflightMutation(source, "inertia_create_conversation", created);
    }
    if (toolName === CANCEL_TASK_TOOL) {
      this.tasks().prepareCancel(current.id, taskCancelSchema.parse(args).taskId);
      return;
    }
    if (toolName === "inertia_create_conversation") {
      const input = createSchema.parse(args);
      const parent = this.dependencies.store.agentThreadManagement
        .managed(current.id);
      if ((parent?.depth ?? 0) + 1 > AGENT_THREAD_MAX_DEPTH) {
        throw new Error("Managed chats cannot create another chat at this depth.");
      }
      const activeChildren = this.activeManagedChildren(current.id);
      if (activeChildren >= MAX_ACTIVE_CHILDREN) {
        throw new Error("This parent already has three managed chats running.");
      }
      assertAccessWithinParent(input.accessMode ?? current.accessMode, current.accessMode);
      const workspace = input.workspace ?? { kind: "project" as const };
      if (workspace.kind === "reuse-current" && this.dependencies.store.project(current.projectId).workspaceKind === "scratch") {
        throw new Error("A chat without a project cannot share its folder with another chat.");
      }
      if (workspace.kind === "reuse-current" && !current.worktreePath) {
        throw new Error("The parent chat does not own an attached worktree to reuse.");
      }
      if (
        workspace.kind === "reuse-current"
        && workspace.sourceBranch
        && workspace.sourceBranch !== current.branch
      ) {
        throw new Error("The requested branch no longer matches the parent chat.");
      }
      await this.assertRouteReady(this.resolveSelection(current, input.route));
      return;
    }
    if (toolName === ANSWER_QUESTION_TOOL_NAME) {
      const input = answerQuestionSchema.parse(args);
      findPendingQuestion(this.questionDependencies(), this.managedTarget(current, input.conversationId), args);
      return;
    }
    if (toolName === "inertia_send_message") {
      const input = sendSchema.parse(args);
      const target = this.managedTarget(current, input.conversationId);
      assertManagedDispatchCeiling(current, target);
      preflightManagedSend(this.dependencies, target, input.mode ?? "auto");
      await this.assertRouteReady(this.dependencies.backendProfileController.validateSelection(target.modelSelection));
      return;
    }
    const input = toolName === "inertia_archive_conversation"
      ? archiveSchema.parse(args)
      : inspectSchema.parse(args);
    const target = this.managedTarget(current, input.conversationId);
    if (
      toolName === "inertia_stop_conversation"
      && !this.dependencies.turns.isActive(target.id)
    ) {
      throw new Error("The managed chat does not have an exact active turn to stop.");
    }
    if (
      toolName === "inertia_archive_conversation"
      && this.dependencies.turns.isActive(target.id)
    ) {
      throw new Error("Stop the chat with inertia_stop_conversation before archiving or unarchiving it.");
    }
  }

  private approvalDetail(
    source: AgentThreadSource,
    toolName: AgentThreadMutationTool,
    args: unknown,
  ): ApprovalDetail {
    const current = this.dependencies.store.conversation(source.conversation.id);
    if (toolName === DELEGATE_TASK_TOOL) {
      const input = delegateTaskSchema.parse(args);
      const created = this.approvalDetail(source, "inertia_create_conversation", delegateCreateInput(input, current));
      return { ...created, title: `Delegate “${delegatedTaskTitle(input)}”`, detail: `${created.detail}${delegateApprovalSuffix(input, this.automaticWakes(), source.turn.providerId)}` };
    }
    if (toolName === CANCEL_TASK_TOOL) {
      const input = taskCancelSchema.parse(args);
      const task = this.tasks().owned(current.id, input.taskId);
      return {
        title: `Cancel delegated task “${task.title}”`,
        detail: `Target ${task.childConversationId}${input.reason ? ` · ${input.reason.slice(0, 180)}` : ""}`,
        permissionRoots: [{ path: this.dependencies.store.conversationPath(task.childConversationId), access: "write" }],
      };
    }
    if (toolName === "inertia_create_conversation") {
      const input = createSchema.parse(args);
      const selection = this.resolveSelection(current, input.route);
      const workspace = input.workspace ?? { kind: "project" as const };
      const title = `Create and start “${input.title}”`;
      const detail = `${providerIdForHarness(selection.harnessId) ?? selection.harnessId} · ${selection.modelId} · ${input.interactionMode ?? current.interactionMode} · ${input.accessMode ?? current.accessMode} · ${workspace.kind}`;
      if (this.dependencies.store.project(current.projectId).workspaceKind === "scratch") {
        return { title, detail: `${detail} · in its own new folder`, permissionRoots: [] };
      }
      const sourcePath = workspace.kind === "reuse-current"
        ? this.dependencies.store.conversationPath(current.id)
        : this.dependencies.store.projectPath(current.projectId);
      return {
        title,
        detail,
        permissionRoots: [{ path: sourcePath, access: "write" }],
      };
    }
    if (toolName === "inertia_send_message") {
      const input = sendSchema.parse(args);
      const target = this.managedTarget(current, input.conversationId);
      const suffix = this.sendStartsFollowUp(current, target, input.mode ?? "auto") ? followUpApprovalSuffix(this.automaticWakes()) : "";
      return managedSendApprovalDetail(this.dependencies.store, target, input, suffix);
    }
    const input = toolName === "inertia_archive_conversation"
      ? archiveSchema.parse(args)
      : inspectSchema.parse(args);
    return {
      title: toolName === "inertia_stop_conversation"
        ? "Stop a managed chat"
        : "archived" in input && input.archived
          ? "Archive a managed chat"
          : "Unarchive a managed chat",
      detail: `Target ${input.conversationId}`,
      permissionRoots: toolName === "inertia_stop_conversation"
        ? [{
            path: this.dependencies.store.conversationPath(input.conversationId),
            access: "write",
          }]
        : [],
    };
  }

  private resolveSelection(
    source: Conversation,
    input: z.infer<typeof routeSchema> | undefined,
  ): ModelSelection {
    return resolveRouteSelection(this.dependencies.backendProfileController, source, input);
  }

  private async assertRouteReady(selection: ModelSelection): Promise<void> {
    const route = this.dependencies.providers.resolveModelRoute(selection);
    const provider = this.dependencies.providerInfo().find(
      ({ id }) => id === route.providerId,
    );
    const readiness = await this.dependencies.backendProfileController
      .readiness(selection, provider);
    if (readiness && !readiness.ready) {
      throw new Error(readiness.message ?? "The selected backend is unavailable.");
    }
    if (!readiness && !provider?.canRun) {
      throw new Error(provider?.statusMessage ?? "The selected provider is unavailable.");
    }
  }

  private async delegate(source: AgentThreadSource, call: ProviderHostToolCall, startedAt: number):
    Promise<ProviderHostToolResult> {
    const input = delegateTaskSchema.parse(call.arguments);
    this.tasks();
    // A client that cancels a wait (OpenCode at its MCP timeout) never delivers the task handle, so the agent sees a
    // failure and may send the same request again. Without its own `clientRequestId`, an identical retry in the same
    // turn reuses the chat the cancelled call created instead of creating a second one.
    const retryKey = input.mode === "wait" && input.clientRequestId === undefined
      ? `${source.turn.id}:${digest({ toolName: DELEGATE_TASK_TOOL, arguments: call.arguments })}` : null;
    const reused = retryKey === null ? undefined : this.cancelledDelegateWaits.get(retryKey)?.created;
    const created = reused !== undefined ? { success: true, text: reused } : await this.mutate(source, call,
      DELEGATE_TASK_TOOL, (operationId, signal) =>
        this.create(source, delegateCreateInput(input, this.assertSource(source)), operationId, signal, input));
    if (!created.success) return created;
    const { taskId } = JSON.parse(created.text) as { taskId: string };
    if (input.mode !== "wait") return json(this.tasks().view(taskId));
    try {
      // The approval and the chat's creation count against the call's own budget.
      const view = await this.tasks().wait(caller(source), taskId,
        delegatedWaitTimeout(input.timeoutMs, source.turn.providerId, performance.now() - startedAt), call.signal);
      if (retryKey !== null) this.cancelledDelegateWaits.delete(retryKey);
      return json(view);
    } catch (error) {
      if (retryKey !== null && error instanceof DelegatedWaitAbortedError) {
        if (this.cancelledDelegateWaits.size >= MAX_CANCELLED_DELEGATE_WAITS) {
          this.cancelledDelegateWaits.delete(this.cancelledDelegateWaits.keys().next().value!);
        }
        this.cancelledDelegateWaits.set(retryKey, { taskId, created: created.text });
      }
      throw error;
    }
  }

  private forgetCancelledDelegateWait(taskId: string): void {
    for (const [key, entry] of this.cancelledDelegateWaits) {
      if (entry.taskId === taskId) this.cancelledDelegateWaits.delete(key);
    }
  }

  private tasks(): DelegationTaskService {
    if (!this.dependencies.delegation) throw new Error("Delegated tasks are unavailable in this runtime.");
    return this.dependencies.delegation;
  }

  /**
   * Whether the send would start a follow-up task of a settled delegation. A queued send is the child's queue at
   * work and a steer only joins the running turn, so neither does; a restart starts its new turn after the stop.
   */
  private sendStartsFollowUp(source: Conversation, target: Conversation, mode: SendMode): boolean {
    if (this.dependencies.delegation === undefined || mode === "queue" || mode === "steer") return false;
    if (mode === "auto" && this.dependencies.turns.isActive(target.id)) return false;
    return this.dependencies.store.orchestration.delegation.followUpTarget(source.id, target.id)?.kind === "follow-up";
  }

  private async linkFollowUp(source: AgentThreadSource, childConversationId: string, operationId: string,
    childTurn: { id: string; runId: string }, via: "send" | "steer"): Promise<string | null> {
    try {
      return await this.dependencies.delegation?.followUp({ parentConversationId: source.conversation.id, childConversationId,
        operationId, sourceTurnId: source.turn.id, sourceRunId: source.turn.runId, childTurn, via }) ?? null;
    } catch (error) {
      console.warn("A managed chat message could not be linked to its delegated task.",
        error instanceof Error ? error.message.slice(0, 1_000) : "unknown error");
      return null;
    }
  }

  private async create(
    source: AgentThreadSource,
    args: unknown,
    operationId: string,
    signal: AbortSignal,
    delegated?: DelegateTaskInput,
  ): Promise<ProviderHostToolResult> {
    const input = createSchema.parse(args);
    const current = this.assertSource(source);
    const parent = this.dependencies.store.agentThreadManagement.managed(current.id);
    if ((parent?.depth ?? 0) + 1 > AGENT_THREAD_MAX_DEPTH) {
      throw new Error("Managed chats cannot create another chat at this depth.");
    }
    const activeChildren = this.activeManagedChildren(current.id);
    if (activeChildren >= MAX_ACTIVE_CHILDREN) {
      throw new Error("This parent already has three managed chats running.");
    }
    const selection = this.resolveSelection(current, input.route);
    await this.assertRouteReady(selection);
    const accessMode = input.accessMode ?? current.accessMode;
    assertAccessWithinParent(accessMode, current.accessMode);
    if (delegated) assertInteractionWithinParent(input.interactionMode ?? current.interactionMode, current.interactionMode);
    const workspace = input.workspace ?? { kind: "project" as const };
    if (
      workspace.kind === "reuse-current"
      && workspace.sourceBranch
      && workspace.sourceBranch !== current.branch
    ) {
      throw new Error("The requested branch no longer matches the parent chat.");
    }
    if (workspace.kind === "reuse-current" && !current.worktreePath) {
      throw new Error("The parent chat does not own an attached worktree to reuse.");
    }
    if (signal.aborted) throw new Error("The parent turn ended before chat creation.");
    this.dependencies.store.agentThreadManagement.transition(
      operationId,
      ["approved"],
      "creating",
      {},
      this.now(),
    );
    const route = this.dependencies.providers.resolveModelRoute(selection);
    const child = await this.dependencies.creation.create({
      projectId: current.projectId,
      title: input.title,
      providerId: route.providerId,
      modelSelection: {
        ...selection,
        capabilities: selection.capabilities.map((capability) => ({
          ...capability,
        })),
      },
      interactionMode: input.interactionMode ?? current.interactionMode,
      accessMode,
      activate: false,
      useWorktree: workspace.kind === "isolated",
      branch: workspace.sourceBranch,
      worktreePath: workspace.kind === "reuse-current"
        ? current.worktreePath
        : undefined,
    }, `agent-thread:${operationId}`);
    this.dependencies.store.agentThreadManagement.attachManaged({
      childConversationId: child.id,
      sourceConversationId: current.id,
      sourceTurnId: source.turn.id,
      sourceRunId: source.turn.runId,
      sourceHarnessId: source.turn.harnessId,
      now: this.now(),
    }, operationId);
    if (signal.aborted) {
      throw new Error(
        "The parent turn ended after chat creation; the child remains visible but was not dispatched.",
      );
    }
    const senderInstructions = agentSenderHiddenInstruction(input.prompt, current);
    const queued = this.dependencies.turns.queue({
      conversationId: child.id,
      content: input.prompt,
      activateConversation: false,
      ...(senderInstructions.length > 0 ? { internalInstructions: senderInstructions } : {}),
    });
    recordQueuedManagedTurn(this.dependencies.store, this.dependencies.turns, operationId, queued.turn, this.now());
    const taskId = delegated ? await this.tasks().create({ operationId, kind: "original", originalTaskId: null,
      parentConversationId: current.id, sourceTurnId: source.turn.id, sourceRunId: source.turn.runId, childConversationId: child.id,
      firstChildTurnId: queued.turn.id, firstChildRunId: queued.turn.runId, title: input.title, role: delegated.role ?? null,
      route: { providerId: child.providerId, harnessId: child.modelSelection.harnessId, modelId: child.modelSelection.modelId,
        reasoningEffort: child.modelSelection.reasoningEffort || null },
      accessMode: child.accessMode, interactionMode: child.interactionMode, workspace: workspace.kind,
      completionWake: delegateWake(delegated) }).then(({ taskId: created }) => created, (error: unknown) => {
      this.dependencies.turns.failBeforeStart(child.id, "The delegated task could not be recorded.");
      throw error;
    }) : null;
    if (!this.dependencies.turns.start(queued.turn.id)) {
      this.dependencies.turns.failBeforeStart(
        child.id,
        "The managed chat could not start.",
      );
      throw new Error("The managed chat was created, but its first turn could not start.");
    }
    this.dependencies.broadcastSnapshot();
    if (taskId) return json(this.tasks().view(taskId));
    const result = {
      conversationId: child.id,
      turnId: queued.turn.id,
      status: "starting",
      title: child.title,
      route: {
        providerId: child.providerId,
        harnessId: child.modelSelection.harnessId,
        backendProfileId: child.modelSelection.backendProfileId,
        modelId: child.modelSelection.modelId,
        reasoningEffort: child.modelSelection.reasoningEffort,
      },
      interactionMode: child.interactionMode,
      accessMode: child.accessMode,
      branch: child.branch,
      workspace: child.worktreePath ? "attached-worktree" : "project",
      provenance: { sourceConversationId: current.id, sourceTurnId: source.turn.id },
    };
    return json(result);
  }

  private async send(
    source: AgentThreadSource,
    args: unknown,
    operationId: string,
    signal: AbortSignal,
    restart: { turnId: string; runId: string } | null,
  ): Promise<ProviderHostToolResult> {
    const input = sendSchema.parse(args);
    const mode = input.mode ?? "auto";
    const checkedCaller = this.assertSource(source);
    const checkedTarget = this.managedTarget(checkedCaller, input.conversationId);
    assertManagedDispatchCeiling(checkedCaller, checkedTarget);
    if (signal.aborted) throw new Error("The parent turn ended before dispatch.");
    await this.assertRouteReady(
      this.dependencies.backendProfileController.validateSelection(
        checkedTarget.modelSelection,
      ),
    );
    if (signal.aborted) throw new Error("The parent turn ended before dispatch.");
    const current = this.assertSource(source);
    const target = this.managedTarget(current, input.conversationId);
    assertManagedDispatchCeiling(current, target);
    const link: ManagedFollowUpLink = async (childTurn, via) =>
      await this.linkFollowUp(source, target.id, operationId, childTurn, via);
    return await dispatchManagedSend(
      { ...this.dependencies, now: this.now },
      current,
      target,
      input.content,
      mode,
      operationId,
      signal,
      restart,
      link,
    );
  }

  private questionDependencies(): ManagedQuestionDependencies {
    return { ...this.dependencies, now: this.now };
  }

  private async answer(
    source: AgentThreadSource,
    args: unknown,
    operationId: string,
    signal: AbortSignal,
    approved: AgentInputRequest,
  ): Promise<ProviderHostToolResult> {
    const input = answerQuestionSchema.parse(args);
    const target = this.managedTarget(this.assertSource(source), input.conversationId);
    if (signal.aborted) throw new Error("The parent turn ended before the answer was sent.");
    return sendQuestionAnswer(this.questionDependencies(), target, args, operationId, approved);
  }

  private async stop(
    source: AgentThreadSource,
    args: unknown,
    signal: AbortSignal,
    identity: { turnId: string; runId: string },
    operationId: string,
  ): Promise<ProviderHostToolResult> {
    const input = inspectSchema.parse(args);
    const current = this.assertSource(source);
    const target = this.managedTarget(current, input.conversationId);
    if (signal.aborted) throw new Error("The parent turn ended before stop.");
    const outcome = await stopManagedTurnForAgent(this.dependencies.store, this.dependencies.turns, target.id, identity, operationId);
    this.dependencies.broadcastSnapshot();
    return json(outcome === "stopped" ? { conversationId: target.id, stopped: true }
      : { conversationId: target.id, stopped: false, next: "The approved turn had already ended, so nothing was stopped." });
  }

  private async archive(
    source: AgentThreadSource,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ProviderHostToolResult> {
    const input = archiveSchema.parse(args);
    const current = this.assertSource(source);
    const target = this.managedTarget(current, input.conversationId);
    if (signal.aborted) throw new Error("The parent turn ended before archive.");
    if (
      this.dependencies.turns.isActive(target.id)
      || this.dependencies.providerTerminalResumes.isActive(target.id)
    ) {
      throw new Error("Stop the chat with inertia_stop_conversation before archiving or unarchiving it.");
    }
    this.dependencies.store.archiveConversation(target.id, input.archived);
    this.dependencies.broadcastConversationShell(target.id);
    this.dependencies.broadcastSnapshot();
    return json({ conversationId: target.id, archived: input.archived });
  }

  private activeManagedChildren(sourceConversationId: string): number {
    const active = new Set(this.dependencies.turns.activeConversationIds());
    for (const conversationId of this.dependencies.store.conversationIds()) {
      if (this.dependencies.providerTerminalResumes.isActive(conversationId)) {
        active.add(conversationId);
      }
    }
    return [...active].filter((conversationId) =>
      this.dependencies.store.agentThreadManagement
        .managedBy(sourceConversationId, conversationId) !== null).length;
  }

}
