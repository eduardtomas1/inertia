import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import type {
  AccessMode,
  AgentTurn,
  Conversation,
  ProviderInfo,
  RuntimeMutationEvent,
} from "../../shared/contracts";
import {
  legacyProviderIdForHarness,
  type ModelSelection,
} from "../../shared/model-routing";
import {
  modelSelectionForBackendProfile,
} from "../../shared/backend-profile-settings";
import type { RuntimeStore } from "../database";
import {
  AGENT_THREAD_MAX_DEPTH,
  type AgentThreadMutationTool,
} from "../persistence/agent-thread-management-repository";
import type {
  ProviderHostToolBridge,
  ProviderHostToolCall,
  ProviderHostToolDefinition,
  ProviderHostToolResult,
} from "../provider/contracts";
import type { ProviderTerminalResumeRegistry } from "../provider/terminal-resume";
import type { ProviderManager } from "../providers";
import type { BackendProfileController } from "./backends/backend-profile-controller";
import type { ConversationCreationService } from "./conversation-creation-service";
import {
  createConversationContextPacketFromAuthorizedAgent,
} from "./conversation-context-service";
import type {
  ConversationContextRequestCoordinator,
} from "./conversation-context-request-coordinator";
import type { TurnController } from "./turns/turn-controller";
import {
  AGENT_BROWSER_TOOL_NAMES,
  AgentBrowserHostTools,
} from "./agent-browser-host-tools";
import type {
  RuntimeAgentBrowserBroker,
} from "./agent-browser-broker-client";
import {
  type HarnessCapabilityManifest,
  type HarnessCapabilityRegistry,
} from "./harness-capabilities";
import { createInertiaHarnessCapabilities } from "./inertia-harness-capabilities";
import type { HiddenProviderInstruction } from "./turns/request-context";

const MAX_LIST_LIMIT = 25;
const MAX_PROMPT_CHARS = 32_768;
const MAX_LATEST_RESULT_BYTES = 8_000;
const MAX_ACTIVE_CHILDREN = 3;
const TERMINAL_TURN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const idSchema = z.string().uuid();
const safeSingleLineSchema = (maximum: number) => z.string()
  .trim()
  .min(1)
  .max(maximum)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const safeMultilineSchema = (maximum: number) => z.string()
  .trim()
  .min(1)
  .max(maximum)
  .refine((value) => !value.includes("\0"));
const routeSchema = z.object({
  providerId: z.enum(["codex", "claude", "cursor", "kimi", "opencode"])
    .optional(),
  backendProfileId: safeSingleLineSchema(200).optional(),
  modelId: safeSingleLineSchema(300).optional(),
  reasoningEffort: safeSingleLineSchema(100).nullable().optional(),
}).strict();
const workspaceSchema = z.object({
  kind: z.enum(["project", "reuse-current", "isolated"]),
  sourceBranch: safeSingleLineSchema(255).optional(),
}).strict();
const listSchema = z.object({
  limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
  includeArchived: z.boolean().optional(),
}).strict();
const inspectSchema = z.object({ conversationId: idSchema }).strict();
const createSchema = z.object({
  title: safeSingleLineSchema(120),
  prompt: safeMultilineSchema(MAX_PROMPT_CHARS),
  route: routeSchema.optional(),
  interactionMode: z.enum(["build", "plan"]).optional(),
  accessMode: z.enum(["supervised", "auto-edit", "full"]).optional(),
  workspace: workspaceSchema.optional(),
}).strict();
const sendSchema = z.object({
  conversationId: idSchema,
  content: safeMultilineSchema(MAX_PROMPT_CHARS),
}).strict();
const archiveSchema = z.object({
  conversationId: idSchema,
  archived: z.boolean().default(true),
}).strict();
const requestContextSchema = z.object({
  sourceConversationId: idSchema.optional(),
}).strict();

const TOOL_DEFINITIONS: readonly ProviderHostToolDefinition[] = [
  {
    name: "inertia_list_conversations",
    description: "List a bounded set of top-level Inertia chats in this chat's current project. Returns safe configuration and lifecycle summaries only; it never returns transcripts, paths, provider sessions, or credentials.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: MAX_LIST_LIMIT },
        includeArchived: { type: "boolean" },
      },
    },
    inputValidator: listSchema,
    readOnly: true,
  },
  {
    name: "inertia_inspect_conversation",
    description: "Inspect safe configuration, lifecycle, and durable management provenance for one top-level Inertia chat in the current project. Does not return transcript content or provider session identity.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { conversationId: { type: "string", format: "uuid" } },
      required: ["conversationId"],
    },
    inputValidator: inspectSchema,
    readOnly: true,
  },
  {
    name: "inertia_request_context",
    description: "Ask the user to share bounded context from another Inertia chat. The optional sourceConversationId can only preselect one existing chat; it never reveals content. Inertia opens a chooser where the user selects the exact visible messages and confirms cross-workspace sharing. The result contains only that bounded, defense-in-depth-redacted selection and its provenance. Do not supply message IDs.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sourceConversationId: { type: "string", format: "uuid" },
      },
    },
    inputValidator: requestContextSchema,
    readOnly: false,
  },
  {
    name: "inertia_create_conversation",
    description: "After explicit user approval, create a real independent top-level Inertia chat in the current project and dispatch its first prompt. Route, reasoning, mode, access, branch, and workspace choices are validated by Inertia; access cannot exceed this parent chat. No project id or filesystem path can be supplied.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 120,
          pattern: "^[^\\u0000-\\u001f\\u007f]+$",
        },
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: MAX_PROMPT_CHARS,
          pattern: "^[^\\u0000]*$",
        },
        route: {
          type: "object",
          additionalProperties: false,
          properties: {
            providerId: {
              enum: ["codex", "claude", "cursor", "kimi", "opencode"],
            },
            backendProfileId: { type: "string", minLength: 1, maxLength: 200 },
            modelId: { type: "string", minLength: 1, maxLength: 300 },
            reasoningEffort: { type: ["string", "null"], maxLength: 100 },
          },
        },
        interactionMode: { enum: ["build", "plan"] },
        accessMode: { enum: ["supervised", "auto-edit", "full"] },
        workspace: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { enum: ["project", "reuse-current", "isolated"] },
            sourceBranch: { type: "string", minLength: 1, maxLength: 255 },
          },
          required: ["kind"],
        },
      },
      required: ["title", "prompt"],
    },
    inputValidator: createSchema,
    readOnly: false,
  },
  {
    name: "inertia_send_message",
    description: "After explicit user approval, dispatch a new message or active-turn follow-up to a top-level chat created by this parent chat. The target must remain in the same project and under this parent's durable management authority.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        conversationId: { type: "string", format: "uuid" },
    content: {
      type: "string",
      minLength: 1,
      maxLength: MAX_PROMPT_CHARS,
      pattern: "^[^\\u0000]*$",
    },
      },
      required: ["conversationId", "content"],
    },
    inputValidator: sendSchema,
    readOnly: false,
  },
  {
    name: "inertia_get_conversation_status",
    description: "Read the current persisted lifecycle status of a chat created by this parent chat. This read-only tool does not expose transcript or tool details.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { conversationId: { type: "string", format: "uuid" } },
      required: ["conversationId"],
    },
    inputValidator: inspectSchema,
    readOnly: true,
  },
  {
    name: "inertia_get_latest_result",
    description: "Read only the latest persisted, visible assistant result for a chat created by this parent chat. Output is truncated and excludes live streams, reasoning, tools, activities, and provider session data.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { conversationId: { type: "string", format: "uuid" } },
      required: ["conversationId"],
    },
    inputValidator: inspectSchema,
    readOnly: true,
  },
  {
    name: "inertia_stop_conversation",
    description: "After explicit user approval, stop the exact active turn of a chat created by this parent chat. It cannot stop unrelated chats or a process no longer owned by this runtime.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { conversationId: { type: "string", format: "uuid" } },
      required: ["conversationId"],
    },
    inputValidator: inspectSchema,
    readOnly: false,
  },
  {
    name: "inertia_archive_conversation",
    description: "After explicit user approval, archive or unarchive an idle chat created by this parent chat. Active chats cannot be archived.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        conversationId: { type: "string", format: "uuid" },
        archived: { type: "boolean", default: true },
      },
      required: ["conversationId"],
    },
    inputValidator: archiveSchema,
    readOnly: false,
  },
] as const;

interface AgentThreadSource {
  conversation: Conversation;
  turn: AgentTurn;
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
  agentBrowser?: RuntimeAgentBrowserBroker;
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

function truncateUtf8(value: string, maximumBytes: number): {
  text: string;
  truncated: boolean;
} {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return { text: value, truncated: false };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = maximumBytes;
  while (end > 0) {
    try {
      return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
    } catch {
      end -= 1;
    }
  }
  return { text: "", truncated: true };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function accessRank(mode: AccessMode): number {
  return mode === "supervised" ? 0 : mode === "auto-edit" ? 1 : 2;
}

function safeConversation(conversation: Conversation, managed: boolean): unknown {
  return {
    conversationId: conversation.id,
    title: conversation.title,
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
    branch: conversation.branch,
    status: conversation.status,
    archived: conversation.archivedAt !== null,
    managedByCaller: managed,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}

export class AgentThreadManager {
  private readonly now: () => string;
  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly agentBrowser: AgentBrowserHostTools | undefined;
  private readonly capabilities: HarnessCapabilityRegistry;

  constructor(private readonly dependencies: AgentThreadManagerDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.agentBrowser = dependencies.agentBrowser
      ? new AgentBrowserHostTools(dependencies.agentBrowser)
      : undefined;
    this.capabilities = createInertiaHarnessCapabilities({
      orchestrationTools: TOOL_DEFINITIONS,
      browserEnabled: this.agentBrowser !== undefined,
      invoke: async (context, call) => await this.invoke(context, call),
    });
  }

  capabilityInstructions(): readonly HiddenProviderInstruction[] {
    return this.capabilities.instructions();
  }

  capabilityManifest(): HarnessCapabilityManifest {
    return this.capabilities.manifest();
  }

  bridgeFor(source: AgentThreadSource): ProviderHostToolBridge {
    return this.capabilities.bridgeFor(source);
  }

  async onSourceTurnSettled(turn: AgentTurn): Promise<void> {
    this.dependencies.contextRequests.cancelForTurn(turn.conversationId, turn.id);
    if (turn.status === "completed") return;
    const active = new Set(this.dependencies.turns.activeConversationIds());
    const targets = this.dependencies.store.agentThreadManagement
      .targetsActedOnByTurn(turn.conversationId, turn.id);
    for (const conversationId of targets) {
      if (!active.has(conversationId)) continue;
      this.dependencies.turns.cancel(conversationId);
    }
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
    try {
      const current = this.assertSource(source);
      if (call.signal.aborted) return failure("call_cancelled", "The host tool call was cancelled.");
      if (this.agentBrowser && AGENT_BROWSER_TOOL_NAMES.has(call.tool)) {
        return await this.agentBrowser.invoke(current, call, {
          conversationId: current.id,
          runId: source.turn.runId,
          turnId: source.turn.id,
        });
      }
      switch (call.tool) {
        case "inertia_list_conversations":
          return this.list(current, call.arguments);
        case "inertia_inspect_conversation":
          return this.inspect(current, call.arguments);
        case "inertia_get_conversation_status":
          return this.status(current, call.arguments);
        case "inertia_get_latest_result":
          return this.latestResult(current, call.arguments);
        case "inertia_request_context":
          return await this.requestContext(source, call);
        case "inertia_create_conversation":
          return await this.mutate(source, call, call.tool, (operationId, signal) =>
            this.create(source, call.arguments, operationId, signal));
        case "inertia_send_message":
          return await this.mutate(source, call, call.tool, (operationId, signal) =>
            this.send(source, call.arguments, operationId, signal));
        case "inertia_stop_conversation":
          return await this.mutate(source, call, call.tool, (_operationId, signal) =>
            this.stop(source, call.arguments, signal));
        case "inertia_archive_conversation":
          return await this.mutate(source, call, call.tool, (_operationId, signal) =>
            this.archive(source, call.arguments, signal));
        default:
          return failure("unknown_tool", "That Inertia host tool is not available.");
      }
    } catch (error) {
      return failure(
        "host_tool_failed",
        error instanceof Error ? error.message.slice(0, 1_000) : "The Inertia host tool failed.",
      );
    }
  }

  private list(source: Conversation, args: unknown): ProviderHostToolResult {
    const input = listSchema.parse(args ?? {});
    const limit = input.limit ?? 10;
    const candidates = this.dependencies.store.shellSnapshot().conversations
      .filter((conversation) => (
        conversation.projectId === source.projectId
        && (input.includeArchived || conversation.archivedAt === null)
      ))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
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
      throw new Error("This parent chat does not own management authority for that chat.");
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
    return json({
      conversationId: target.id,
      status: target.status,
      active: this.dependencies.turns.isActive(target.id),
      archived: target.archivedAt !== null,
      latestTurn: latest ? {
        turnId: latest.id,
        status: latest.status,
        terminalReason: latest.terminalReason,
        requestedAt: latest.requestedAt,
        startedAt: latest.startedAt,
        completedAt: latest.completedAt,
      } : null,
    });
  }

  private latestResult(source: Conversation, args: unknown): ProviderHostToolResult {
    const input = inspectSchema.parse(args);
    const target = this.managedTarget(source, input.conversationId);
    const latest = this.dependencies.store.latestAgentTurnForConversation(target.id);
    if (!latest?.terminalAssistantMessageId) {
      return json({ conversationId: target.id, result: null, persisted: true });
    }
    const message = this.dependencies.store.message(
      latest.terminalAssistantMessageId,
    );
    if (message.role !== "assistant") {
      throw new Error("The persisted terminal result is not an assistant message.");
    }
    const content = truncateUtf8(message.content, MAX_LATEST_RESULT_BYTES);
    return json({
      conversationId: target.id,
      turnId: latest.id,
      status: latest.status,
      result: content.text,
      truncated: content.truncated,
      persisted: true,
      source: "visible-assistant-message",
    });
  }

  private async requestContext(
    source: AgentThreadSource,
    call: ProviderHostToolCall,
  ): Promise<ProviderHostToolResult> {
    const input = requestContextSchema.parse(call.arguments ?? {});
    const current = this.assertSource(source);
    if (input.sourceConversationId) {
      const requestedSource = this.dependencies.store.conversation(
        input.sourceConversationId,
      );
      if (requestedSource.id === current.id) {
        throw new Error("Choose another chat as the context source.");
      }
    }
    const toolCallIdHash = digest(call.toolCallId);
    const requestFingerprint = digest({
      toolName: "inertia_request_context",
      arguments: input,
    });
    const createdAt = this.now();
    const expiresAt = new Date(Date.parse(createdAt) + 5 * 60_000).toISOString();
    const reserved = this.dependencies.store.contextPackets.reserveAgentRequest({
      id: randomUUID(),
      targetConversationId: current.id,
      targetTurnId: source.turn.id,
      targetUserMessageId: source.turn.userMessageId,
      targetRunId: source.turn.runId,
      sourceHarnessId: source.turn.modelSelection.harnessId,
      requestedSourceConversationId: input.sourceConversationId ?? null,
      toolCallIdHash,
      requestFingerprint,
      now: createdAt,
      expiresAt,
    });
    if (reserved.kind === "limit") {
      return failure("budget_exceeded", "This turn already requested context four times.");
    }
    if (reserved.kind === "conflict") {
      return failure(
        "idempotency_conflict",
        "This provider tool-call identity was reused with different input.",
      );
    }
    if (reserved.kind === "replay") {
      if (reserved.request?.status === "completed" && reserved.request.resultJson) {
        return { success: true, text: reserved.request.resultJson };
      }
      return failure(
        "operation_not_replayable",
        `The original context request is ${reserved.request?.status ?? "unavailable"}; Inertia will not reopen it.`,
      );
    }
    const durable = reserved.request!;
    const outcome = await this.dependencies.contextRequests.request({
      scope: {
        contextRequestId: durable.id,
        targetConversationId: current.id,
        targetTurnId: source.turn.id,
        targetRunId: source.turn.runId,
        toolCallIdHash,
      },
      providerId: source.turn.providerId,
      requestedSourceConversationId: input.sourceConversationId ?? null,
      createdAt,
      signal: call.signal,
    });
    if (outcome.kind === "cancelled") {
      const status = outcome.reason === "expired"
        ? "expired" as const
        : outcome.reason === "cancelled"
          ? "cancelled" as const
          : "interrupted" as const;
      if (this.dependencies.store.contextPackets.agentRequest(durable.id)
        ?.status === "selection-pending") {
        this.dependencies.store.contextPackets.finishAgentRequest(
          durable.id,
          status,
          outcome.reason === "expired"
            ? "The context chooser expired before the user responded."
            : outcome.reason === "cancelled"
              ? "The user cancelled the context chooser."
              : "The originating turn ended before context selection settled.",
          this.now(),
        );
      }
      return failure(
        status === "cancelled" ? "user_cancelled" : "call_cancelled",
        status === "expired"
          ? "The context chooser expired."
          : status === "cancelled"
            ? "The user did not share chat context."
            : "The parent turn ended before context selection settled.",
      );
    }
    try {
      this.assertSource(source);
      const completed = createConversationContextPacketFromAuthorizedAgent(
        this.dependencies.store,
        {
          contextRequestId: durable.id,
          targetConversationId: current.id,
          targetTurnId: source.turn.id,
          targetRunId: source.turn.runId,
          targetUserMessageId: source.turn.userMessageId,
          toolCallIdHash,
          authorizationReceipt: outcome.authorization.receipt,
          completedAt: this.now(),
        },
        this.dependencies.contextRequests,
      );
      this.dependencies.broadcastConversationShell(current.id);
      this.dependencies.broadcast({
        type: "conversation.detail.invalidated",
        conversationId: current.id,
      });
      return { success: true, text: completed.resultJson };
    } catch (error) {
      const pending = this.dependencies.store.contextPackets.agentRequest(durable.id);
      if (pending?.status === "selection-pending") {
        this.dependencies.store.contextPackets.finishAgentRequest(
          durable.id,
          call.signal.aborted ? "interrupted" : "failed",
          error instanceof Error
            ? error.message.slice(0, 1_000)
            : "The approved context selection failed.",
          this.now(),
        );
      }
      throw error;
    }
  }

  private async mutate(
    source: AgentThreadSource,
    call: ProviderHostToolCall,
    toolName: AgentThreadMutationTool,
    execute: (
      operationId: string,
      signal: AbortSignal,
    ) => Promise<ProviderHostToolResult>,
  ): Promise<ProviderHostToolResult> {
    await this.preflightMutation(source, toolName, call.arguments);
    if (call.signal.aborted) {
      return failure("call_cancelled", "The parent turn ended before approval.");
    }
    const inputChars = toolName === "inertia_create_conversation"
      ? createSchema.parse(call.arguments).prompt.length
      : toolName === "inertia_send_message"
        ? sendSchema.parse(call.arguments).content.length
        : 0;
    const requestFingerprint = digest({ toolName, arguments: call.arguments });
    const reserved = this.dependencies.store.agentThreadManagement.reserve({
      sourceConversationId: source.conversation.id,
      sourceTurnId: source.turn.id,
      sourceRunId: source.turn.runId,
      toolCallId: call.toolCallId,
      toolName,
      requestFingerprint,
      inputChars,
      now: this.now(),
    });
    if (reserved.kind === "limit") return failure("budget_exceeded", reserved.reason);
    if (reserved.kind === "conflict") {
      return failure("idempotency_conflict", "This provider tool-call identity was reused with different input.");
    }
    if (reserved.kind === "replay") {
      if (reserved.operation.status === "completed" && reserved.operation.resultJson) {
        return { success: true, text: reserved.operation.resultJson };
      }
      return failure(
        "operation_not_replayable",
        `The original operation is ${reserved.operation.status}; Inertia will not repeat it.`,
      );
    }
    const detail = this.approvalDetail(source, toolName, call.arguments);
    const decision = await call.requestApproval({
      title: detail.title,
      detail: detail.detail,
      reason: "A model requested a top-level Inertia chat lifecycle action.",
      permissionRoots: detail.permissionRoots,
    });
    if (decision !== "approve") {
      this.dependencies.store.agentThreadManagement.transition(
        reserved.operation.id,
        ["approval-pending"],
        "denied",
        { failureMessage: decision === "cancel" ? "Cancelled by the user." : "Denied by the user." },
        this.now(),
      );
      return failure("user_denied", "The user did not approve this chat action.");
    }
    this.dependencies.store.agentThreadManagement.transition(
      reserved.operation.id,
      ["approval-pending"],
      "approved",
      {},
      this.now(),
    );
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
      const result = await this.serializeMutation(
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

  private async preflightMutation(
    source: AgentThreadSource,
    toolName: AgentThreadMutationTool,
    args: unknown,
  ): Promise<void> {
    const current = this.assertSource(source);
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
      const accessMode = input.accessMode ?? current.accessMode;
      if (accessRank(accessMode) > accessRank(current.accessMode)) {
        throw new Error("A managed chat cannot exceed its parent chat's access mode.");
      }
      const workspace = input.workspace ?? { kind: "project" as const };
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
    if (toolName === "inertia_send_message") {
      const input = sendSchema.parse(args);
      const target = this.managedTarget(current, input.conversationId);
      await this.assertRouteReady(
        this.dependencies.backendProfileController.validateSelection(
          target.modelSelection,
        ),
      );
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
      throw new Error("Stop the managed chat before changing its archive state.");
    }
  }

  private approvalDetail(
    source: AgentThreadSource,
    toolName: AgentThreadMutationTool,
    args: unknown,
  ): { title: string; detail: string; permissionRoots: Array<{ path: string; access: "write" }> } {
    const current = this.dependencies.store.conversation(source.conversation.id);
    if (toolName === "inertia_create_conversation") {
      const input = createSchema.parse(args);
      const selection = this.resolveSelection(current, input.route);
      const workspace = input.workspace ?? { kind: "project" as const };
      const sourcePath = workspace.kind === "reuse-current"
        ? this.dependencies.store.conversationPath(current.id)
        : this.dependencies.store.projectPath(current.projectId);
      return {
        title: `Create and start “${input.title}”`,
        detail: `${legacyProviderIdForHarness(selection.harnessId) ?? selection.harnessId} · ${selection.modelId} · ${input.interactionMode ?? current.interactionMode} · ${input.accessMode ?? current.accessMode} · ${workspace.kind}`,
        permissionRoots: [{ path: sourcePath, access: "write" }],
      };
    }
    if (toolName === "inertia_send_message") {
      const input = sendSchema.parse(args);
      const target = this.managedTarget(current, input.conversationId);
      return {
        title: "Send work to a managed chat",
        detail: `Target ${input.conversationId} · ${input.content.slice(0, 180)}`,
        permissionRoots: [{
          path: this.dependencies.store.conversationPath(target.id),
          access: "write",
        }],
      };
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
    if (!input) return this.dependencies.backendProfileController
      .validateSelection(source.modelSelection);
    const profileId = input.backendProfileId
      ?? source.modelSelection.backendProfileId;
    const profile = this.dependencies.backendProfileController.detail(profileId);
    const modelId = input.modelId
      ?? (profileId === source.modelSelection.backendProfileId
        ? source.modelSelection.modelId
        : profile.routing.primaryModelId);
    const reasoningEffort = input.reasoningEffort !== undefined
      ? input.reasoningEffort
      : profileId === source.modelSelection.backendProfileId
        && modelId === source.modelSelection.modelId
        ? source.modelSelection.reasoningEffort
        : null;
    const selection = this.dependencies.backendProfileController.validateSelection(
      modelSelectionForBackendProfile(profile, modelId, reasoningEffort),
    );
    const providerId = legacyProviderIdForHarness(selection.harnessId);
    if (!providerId || (input.providerId && input.providerId !== providerId)) {
      throw new Error("The requested provider does not match the verified backend route.");
    }
    return selection;
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

  private async create(
    source: AgentThreadSource,
    args: unknown,
    operationId: string,
    signal: AbortSignal,
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
    if (accessRank(accessMode) > accessRank(current.accessMode)) {
      throw new Error("A managed chat cannot exceed its parent chat's access mode.");
    }
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
    const queued = this.dependencies.turns.queue({
      conversationId: child.id,
      content: input.prompt,
      activateConversation: false,
    });
    if (!this.dependencies.turns.start(queued.turn.id)) {
      this.dependencies.turns.failBeforeStart(
        child.id,
        "The managed chat could not start.",
      );
      throw new Error("The managed chat was created, but its first turn could not start.");
    }
    this.dependencies.broadcastSnapshot();
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
  ): Promise<ProviderHostToolResult> {
    const input = sendSchema.parse(args);
    const current = this.assertSource(source);
    const target = this.managedTarget(current, input.conversationId);
    if (signal.aborted) throw new Error("The parent turn ended before dispatch.");
    await this.assertRouteReady(
      this.dependencies.backendProfileController.validateSelection(
        target.modelSelection,
      ),
    );
    if (signal.aborted) throw new Error("The parent turn ended before dispatch.");
    if (this.dependencies.turns.isActive(target.id)) {
      const lease = this.dependencies.turns.acquireFollowUpAdmission(target.id);
      if (!lease) throw new Error("The target chat cannot accept a follow-up right now.");
      this.dependencies.store.agentThreadManagement.transition(
        operationId,
        ["approved"],
        "dispatching",
        { childConversationId: target.id },
        this.now(),
      );
      try {
        const message = await this.dependencies.turns.steer(lease, {
          content: input.content,
          imagePaths: [],
        }, [], undefined, signal);
        if (!message?.turnId) throw new Error("The target provider did not accept the follow-up.");
        this.dependencies.broadcastSnapshot();
        return json({
          conversationId: target.id,
          turnId: message.turnId,
          disposition: "follow-up",
          accepted: true,
        });
      } finally {
        lease.release();
      }
    }
    if (!this.dependencies.providerTerminalResumes.acquire(target.id)) {
      throw new Error(
        "End the resumed provider terminal for the target chat before sending another message.",
      );
    }
    try {
      if (signal.aborted) throw new Error("The parent turn ended before dispatch.");
      this.dependencies.store.agentThreadManagement.transition(
        operationId,
        ["approved"],
        "dispatching",
        { childConversationId: target.id },
        this.now(),
      );
      const queued = this.dependencies.turns.queue({
        conversationId: target.id,
        content: input.content,
        activateConversation: false,
      });
      if (!this.dependencies.turns.start(queued.turn.id)) {
        this.dependencies.turns.failBeforeStart(target.id, "The managed follow-up could not start.");
        throw new Error("The target chat could not start the new turn.");
      }
      this.dependencies.broadcastSnapshot();
      return json({
        conversationId: target.id,
        turnId: queued.turn.id,
        disposition: "new-turn",
        accepted: true,
      });
    } finally {
      this.dependencies.providerTerminalResumes.release(target.id);
    }
  }

  private async stop(
    source: AgentThreadSource,
    args: unknown,
    signal: AbortSignal,
  ): Promise<ProviderHostToolResult> {
    const input = inspectSchema.parse(args);
    const current = this.assertSource(source);
    const target = this.managedTarget(current, input.conversationId);
    if (signal.aborted) throw new Error("The parent turn ended before stop.");
    if (!this.dependencies.turns.cancel(target.id)) {
      throw new Error("The managed chat does not have an exact active turn to stop.");
    }
    await this.dependencies.turns.waitForProviderCleanup([target.id]);
    if (this.dependencies.turns.isActive(target.id)) {
      throw new Error("Stop was requested, but exact provider cleanup was not confirmed.");
    }
    this.dependencies.broadcastSnapshot();
    return json({ conversationId: target.id, stopped: true });
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
      throw new Error("Stop the managed chat before changing its archive state.");
    }
    this.dependencies.store.archiveConversation(target.id, input.archived);
    this.dependencies.broadcastConversationShell(target.id);
    this.dependencies.broadcastSnapshot();
    return json({ conversationId: target.id, archived: input.archived });
  }

  private activeManagedChildren(sourceConversationId: string): number {
    const active = new Set(this.dependencies.turns.activeConversationIds());
    for (const conversation of this.dependencies.store.shellSnapshot().conversations) {
      if (this.dependencies.providerTerminalResumes.isActive(conversation.id)) {
        active.add(conversation.id);
      }
    }
    return [...active].filter((conversationId) =>
      this.dependencies.store.agentThreadManagement
        .managedBy(sourceConversationId, conversationId) !== null).length;
  }

  private async serializeMutation<T>(
    sourceConversationId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const predecessor = this.mutationTails.get(sourceConversationId)
      ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.catch(() => undefined).then(() => gate);
    this.mutationTails.set(sourceConversationId, tail);
    await predecessor.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.mutationTails.get(sourceConversationId) === tail) {
        this.mutationTails.delete(sourceConversationId);
      }
    }
  }
}
