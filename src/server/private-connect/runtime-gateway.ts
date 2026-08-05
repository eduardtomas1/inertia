import { createHash, randomUUID } from "node:crypto";
import type {
  AppSnapshot,
  Conversation,
  ConversationDetail,
} from "../../shared/contracts";
import type { AgentInputRequest } from "../../shared/contracts";
import type { RuntimePrivateConnectPromptPreparation } from "../../node/runtime-process-protocol";
import {
  PRIVATE_CONNECT_RUNTIME_LIMITS,
  privateConnectRuntimeRequestSchema,
  type PrivateConnectRuntimeAuthorization,
  type PrivateConnectRuntimeProjectionValidator,
  type PrivateConnectRuntimeRequest,
  type PrivateConnectRuntimeResponse,
  type PrivateConnectRuntimeConversation,
} from "../../shared/private-connect/runtime-contract";
import {
  PRIVATE_CONNECT_QUESTION_LIMITS,
  type PrivateConnectSafeQuestion,
} from "../../shared/private-connect/questions";
import { privateConnectRuntimeGrantAllowsConversation } from "../../shared/private-connect/runtime-grants";
import {
  privateConnectPromptSafetyIsUsable,
  UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY,
  type PrivateConnectPromptSafety,
} from "../../shared/private-connect/prompt-safety";
import {
  sanitizePrivateConnectContent,
  sanitizePrivateConnectLabel,
} from "../../shared/private-connect/sanitizer";
import { PROVIDER_INFO } from "../provider/catalog";
import { PrivateConnectTranscriptCache } from "./transcript-cache";

interface PrivateConnectGatewayDependencies {
  shell(): AppSnapshot;
  detail(conversationId: string): ConversationDetail | null;
  isConversationActive(conversationId: string): boolean;
  preparePrompt(conversation: Conversation): Promise<void>;
  queuePrompt(conversationId: string, content: string): {
    turnId: string;
  };
  respondToInput?(conversationId: string, inputRequestId: string, answers: Record<string, string[]>): boolean;
  stopRun?(conversationId: string, runId: string): { stopped: boolean; alreadyStopped: boolean };
  inputs?(): Iterable<AgentInputRequest>;
  privateConnectPromptSafety?(conversation: Conversation): PrivateConnectPromptSafety;
  transcriptCache?: PrivateConnectTranscriptCache;
  now?(): Date;
}

interface DeliveryReceipt {
  conversationId: string;
  content: string;
  response: PrivateConnectRuntimeResponse;
}

type PrivateConnectPromptRequest = Extract<PrivateConnectRuntimeRequest, { type: "prompt.send" }>;

interface PreparedPrivateConnectPrompt {
  key: string;
  subject: PrivateConnectRuntimeAuthorization;
  request: PrivateConnectPromptRequest;
  createdAt: number;
}

interface PendingPrivateConnectPromptPreparation {
  key: string;
  createdAt: number;
}

const PREPARED_PROMPT_TTL_MS = 15_000;
const PREPARED_PROMPT_LIMIT =
  PRIVATE_CONNECT_RUNTIME_LIMITS.sessions * PRIVATE_CONNECT_RUNTIME_LIMITS.inFlightRequestsPerSession;
const PROJECTION_VALIDATOR_PLACEHOLDER = "A".repeat(43) as PrivateConnectRuntimeProjectionValidator;

export class PrivateConnectRuntimeGateway {
  private readonly receipts = new Map<string, DeliveryReceipt>();
  private readonly preparedPrompts = new Map<string, PreparedPrivateConnectPrompt>();
  private readonly latestPreparationIdByRequest = new Map<string, string>();
  private readonly pendingPreparations =
    new Map<string, PendingPrivateConnectPromptPreparation>();
  private readonly transcriptCache: PrivateConnectTranscriptCache;
  private readonly now: () => Date;

  constructor(private readonly dependencies: PrivateConnectGatewayDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.transcriptCache = dependencies.transcriptCache
      ?? new PrivateConnectTranscriptCache();
  }

  forgetConversation(conversationId: string): void {
    this.transcriptCache.invalidateConversation(conversationId);
  }

  forgetMessage(conversationId: string, messageId: string): void {
    this.transcriptCache.invalidateMessage(conversationId, messageId);
  }

  reset(): void {
    this.transcriptCache.clear();
    this.receipts.clear();
    this.preparedPrompts.clear();
    this.latestPreparationIdByRequest.clear();
    this.pendingPreparations.clear();
  }

  async request(
    subject: PrivateConnectRuntimeAuthorization,
    untrustedRequest: unknown,
  ): Promise<PrivateConnectRuntimeResponse> {
    const parsed = privateConnectRuntimeRequestSchema.safeParse(untrustedRequest);
    if (!parsed.success) {
      return failedResponse(
        requestIdFrom(untrustedRequest),
        "invalid",
        "The Private Connect request was invalid.",
      );
    }
    const request = parsed.data;
    const rejection = this.requestBoundaryRejection(subject, request);
    if (rejection) return rejection;

    if (request.type === "state.get") {
      const conditional = request.ifNoneMatch !== undefined;
      const response = boundPrivateConnectProjection({
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: {
          kind: "state",
          ...(conditional
            ? { validator: PROJECTION_VALIDATOR_PLACEHOLDER }
            : {}),
          state: projectShell(
            this.dependencies.shell(),
            subject,
            this.now(),
            (conversation) => this.promptSafety(conversation),
          ),
        },
      });
      return conditionalProjectionResponse(subject, request, response);
    }
    if (request.type === "conversation.get") {
      return this.conversation(subject, request);
    }
    if (request.type === "input.respond") {
      return this.respondToInput(subject, request);
    }
    if (request.type === "run.stop") {
      return this.stopRun(subject, request);
    }
    return failedResponse(
      request.requestId,
      "invalid",
      "Private Connect prompts require an authorized prepare and commit.",
    );
  }

  private respondToInput(
    subject: PrivateConnectRuntimeAuthorization,
    request: Extract<PrivateConnectRuntimeRequest, { type: "input.respond" }>,
  ): PrivateConnectRuntimeResponse {
    const detail = this.dependencies.detail(request.conversationId);
    if (!detail || !authorizedConversation(subject, detail)) return unavailableConversationResponse(request.requestId);
    const pending = this.dependencies.respondToInput;
    if (!pending) return failedResponse(request.requestId, "unavailable", "Questions are not available while the local runtime is restarting.");
    if (!this.dependencies.shell().conversations.find(({ id }) => id === request.conversationId)?.pendingInput) {
      return failedResponse(request.requestId, "stale", "That question is no longer pending.");
    }
    if (!pending(request.conversationId, request.inputRequestId, request.answers)) {
      return failedResponse(request.requestId, "forbidden", "The question could not be answered safely.");
    }
    return boundPrivateConnectProjection({
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: {
        kind: "input.accepted",
        conversationId: request.conversationId,
        inputRequestId: request.inputRequestId,
      },
    });
  }

  private stopRun(
    subject: PrivateConnectRuntimeAuthorization,
    request: Extract<PrivateConnectRuntimeRequest, { type: "run.stop" }>,
  ): PrivateConnectRuntimeResponse {
    const detail = this.dependencies.detail(request.conversationId);
    if (!detail || !authorizedConversation(subject, detail)) return unavailableConversationResponse(request.requestId);
    const stop = this.dependencies.stopRun;
    if (!stop) return failedResponse(request.requestId, "unavailable", "Stopping is not available while the local runtime is restarting.");
    const result = stop(request.conversationId, request.runId);
    if (!result.stopped && !result.alreadyStopped) return failedResponse(request.requestId, "not-found", "That run is no longer active.");
    return boundPrivateConnectProjection({
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: {
        kind: "run.stopped",
        conversationId: request.conversationId,
        runId: request.runId,
        alreadyStopped: result.alreadyStopped,
      },
    });
  }

  private conversation(
    subject: PrivateConnectRuntimeAuthorization,
    request: Extract<PrivateConnectRuntimeRequest, { type: "conversation.get" }>,
  ): PrivateConnectRuntimeResponse {
    const detail = this.dependencies.detail(request.conversationId);
    if (!detail || !authorizedConversation(subject, detail)) {
      return failedResponse(
        request.requestId,
        "not-found",
        "That conversation is unavailable to this device.",
      );
    }
    const shell = this.dependencies.shell();
    const projectedConversation = safeConversation(
      shell.conversations.find(({ id }) => id === request.conversationId)
        ?? { ...detail.conversation, latestTurn: null, pendingApproval: false, pendingInput: false },
      this.promptSafety(detail.conversation),
    );
    const pendingInput = [...(this.dependencies.inputs?.() ?? [])].find(
      ({ conversationId }) => conversationId === request.conversationId,
    ) ?? null;
    const answerableInput = remotelyAnswerableInput(pendingInput);
    const conditional = request.ifNoneMatch !== undefined;
    const response = boundPrivateConnectProjection({
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: {
        kind: "conversation",
        ...(conditional
          ? { validator: PROJECTION_VALIDATOR_PLACEHOLDER }
          : {}),
        detail: {
          generatedAt: this.now().toISOString(),
          conversation: projectedConversation,
          messages: detail.messages
            .filter(({ role }) => role === "user" || role === "assistant")
            .slice(-PRIVATE_CONNECT_RUNTIME_LIMITS.transcriptMessages)
            .map((message) => ({
              id: message.id,
              turnId: message.turnId,
              role: message.role as "user" | "assistant",
              content: this.transcriptCache.content(
                request.conversationId,
                message.id,
                message.content,
              ),
              createdAt: message.createdAt,
            })),
          activities: detail.activities
            .slice(-PRIVATE_CONNECT_RUNTIME_LIMITS.activities)
            .map((activity) => ({
              id: activity.id,
              turnId: activity.turnId,
              kind: activity.kind,
              title: safeActivityTitle(activity.kind, activity.title),
              status: activity.status,
              createdAt: activity.createdAt,
            })),
          subagents: detail.subagents
            .slice(-PRIVATE_CONNECT_RUNTIME_LIMITS.subagents)
            .map((subagent) => ({
              id: subagent.id,
              turnId: subagent.turnId,
              providerLabel: PROVIDER_INFO[subagent.providerId].name,
              name: sanitizePrivateConnectLabel(subagent.providerName),
              status: subagent.status,
              description: null,
              progress: null,
              updatedAt: subagent.updatedAt,
            })),
          plan: safePrivateConnectPlan(detail.plans.at(-1)),
          questions: safePrivateConnectQuestions(answerableInput),
          inputRequestId: answerableInput?.id ?? null,
          waitingForLocalAction:
            projectedConversation.pendingLocalApproval
            || (pendingInput !== null && answerableInput === null)
            || shell.conversations.some(
              ({ id, pendingInput: waiting }) => id === request.conversationId && waiting,
            ),
        },
      },
    });
    return conditionalProjectionResponse(subject, request, response);
  }

  async preparePrompt(
    subject: PrivateConnectRuntimeAuthorization,
    untrustedRequest: unknown,
  ): Promise<RuntimePrivateConnectPromptPreparation | PrivateConnectRuntimeResponse> {
    const parsed = privateConnectRuntimeRequestSchema.safeParse(untrustedRequest);
    if (!parsed.success || parsed.data.type !== "prompt.send") {
      return failedResponse(
        requestIdFrom(untrustedRequest),
        "invalid",
        "The Private Connect prompt was invalid.",
      );
    }
    const request = parsed.data;
    const requestRejection = this.requestBoundaryRejection(subject, request);
    if (requestRejection) return requestRejection;
    if (!subject.scopes.includes("prompt")) {
      return failedResponse(
        request.requestId,
        "forbidden",
        "Prompting is not enabled for this device.",
      );
    }
    const detail = this.dependencies.detail(request.conversationId);
    if (!detail || !authorizedConversation(subject, detail)) {
      return unavailableConversationResponse(request.requestId);
    }
    const receipt = this.receipts.get(request.deliveryId);
    if (receipt) {
      return receipt.conversationId === request.conversationId
        && receipt.content === request.content
        ? { ...receipt.response, requestId: request.requestId }
        : failedResponse(
            request.requestId,
            "invalid",
            "That delivery identifier was already used.",
          );
    }
    const initialRejection = this.promptBoundaryRejection(
      subject,
      request,
      detail,
    );
    if (initialRejection) return initialRejection;
    this.prunePreparedPrompts();
    const key = preparedPromptKey(subject, request);
    const previousPreparationId =
      this.latestPreparationIdByRequest.get(key);
    if (previousPreparationId) {
      this.preparedPrompts.delete(previousPreparationId);
      this.latestPreparationIdByRequest.delete(key);
    }
    if (
      this.preparedPrompts.size + this.pendingPreparations.size
        >= PREPARED_PROMPT_LIMIT
    ) {
      return failedResponse(
        request.requestId,
        "busy",
        "Too many Private Connect prompts are awaiting authorization.",
      );
    }
    const preparationId = randomUUID();
    this.pendingPreparations.set(preparationId, {
      key,
      createdAt: this.now().getTime(),
    });
    this.latestPreparationIdByRequest.set(key, preparationId);
    try {
      // Desktop readiness checks can await provider state. Re-read and
      // revalidate before issuing a one-time preparation; commit revalidates
      // once more immediately before its synchronous queue operation.
      await this.dependencies.preparePrompt(detail.conversation);
      const currentDetail = this.dependencies.detail(request.conversationId);
      if (!currentDetail) {
        return unavailableConversationResponse(request.requestId);
      }
      const currentRejection = this.promptBoundaryRejection(
        subject,
        request,
        currentDetail,
      );
      if (currentRejection) return currentRejection;
      this.prunePreparedPrompts();
      const pending = this.pendingPreparations.get(preparationId);
      this.pendingPreparations.delete(preparationId);
      if (
        !pending
        || pending.key !== key
        || pending.createdAt
          < this.now().getTime() - PREPARED_PROMPT_TTL_MS
        || this.latestPreparationIdByRequest.get(key) !== preparationId
      ) {
        if (
          this.latestPreparationIdByRequest.get(key) === preparationId
        ) {
          this.latestPreparationIdByRequest.delete(key);
        }
        return failedResponse(
          request.requestId,
          "forbidden",
          "PrivateConnect prompt authorization is no longer current.",
        );
      }
      this.preparedPrompts.set(preparationId, {
        key,
        subject: structuredClone(subject),
        request: structuredClone(request),
        createdAt: this.now().getTime(),
      });
      return { preparationId };
    } catch (error) {
      return failedResponse(
        request.requestId,
        "unavailable",
        publicPrivateConnectError(error),
      );
    } finally {
      this.pendingPreparations.delete(preparationId);
      if (
        !this.preparedPrompts.has(preparationId)
        && this.latestPreparationIdByRequest.get(key) === preparationId
      ) {
        this.latestPreparationIdByRequest.delete(key);
      }
    }
  }

  commitPrompt(
    subject: PrivateConnectRuntimeAuthorization,
    untrustedRequest: unknown,
    preparationId: string,
  ): PrivateConnectRuntimeResponse {
    const parsed = privateConnectRuntimeRequestSchema.safeParse(untrustedRequest);
    if (!parsed.success || parsed.data.type !== "prompt.send") {
      return failedResponse(
        requestIdFrom(untrustedRequest),
        "invalid",
        "The Private Connect prompt was invalid.",
      );
    }
    const request = parsed.data;
    const requestRejection = this.requestBoundaryRejection(subject, request);
    if (requestRejection) return requestRejection;
    this.prunePreparedPrompts();
    const key = preparedPromptKey(subject, request);
    const prepared = this.preparedPrompts.get(preparationId);
    this.preparedPrompts.delete(preparationId);
    if (
      prepared
      && this.latestPreparationIdByRequest.get(prepared.key)
        === preparationId
    ) {
      this.latestPreparationIdByRequest.delete(prepared.key);
    }
    if (
      !prepared
      || prepared.key !== key
      || !samePreparedPrompt(prepared, subject, request)
    ) {
      return failedResponse(
        request.requestId,
        "forbidden",
        "PrivateConnect prompt authorization is no longer current.",
      );
    }
    const detail = this.dependencies.detail(request.conversationId);
    if (!detail) return unavailableConversationResponse(request.requestId);
    const rejection = this.promptBoundaryRejection(subject, request, detail);
    if (rejection) return rejection;
    try {
      const queued = this.dependencies.queuePrompt(
        request.conversationId,
        request.content,
      );
      const response: PrivateConnectRuntimeResponse = {
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: {
          kind: "prompt.accepted",
          deliveryId: request.deliveryId,
          turnId: queued.turnId,
        },
      };
      this.rememberReceipt(request, response);
      return response;
    } catch (error) {
      return failedResponse(
        request.requestId,
        "unavailable",
        publicPrivateConnectError(error),
      );
    }
  }

  private requestBoundaryRejection(
    subject: PrivateConnectRuntimeAuthorization,
    request: PrivateConnectRuntimeRequest,
  ): PrivateConnectRuntimeResponse | null {
    if (Date.parse(subject.expiresAt) <= this.now().getTime()) {
      return failedResponse(
        request.requestId,
        "forbidden",
        "This device grant has expired.",
      );
    }
    if (!subject.scopes.includes("view")) {
      return failedResponse(
        request.requestId,
        "forbidden",
        "This device cannot view Private Connect.",
      );
    }
    return null;
  }

  private promptBoundaryRejection(
    subject: PrivateConnectRuntimeAuthorization,
    request: Extract<PrivateConnectRuntimeRequest, { type: "prompt.send" }>,
    detail: ConversationDetail,
  ): PrivateConnectRuntimeResponse | null {
    if (!authorizedConversation(subject, detail)) {
      return unavailableConversationResponse(request.requestId);
    }
    if (detail.conversation.accessMode !== "supervised") {
      return failedResponse(
        request.requestId,
        "forbidden",
        "PrivateConnect prompting requires Supervised access on the desktop.",
      );
    }
    const safety = this.promptSafety(detail.conversation);
    if (!privateConnectPromptSafetyIsUsable(safety)) {
      return failedResponse(
        request.requestId,
        "forbidden",
        safety.explanation,
      );
    }
    if (this.dependencies.isConversationActive(request.conversationId)) {
      return failedResponse(
        request.requestId,
        "busy",
        "Wait for the active run to finish on the desktop.",
      );
    }
    return null;
  }

  private rememberReceipt(
    request: Extract<PrivateConnectRuntimeRequest, { type: "prompt.send" }>,
    response: PrivateConnectRuntimeResponse,
  ): void {
    this.receipts.set(request.deliveryId, {
      conversationId: request.conversationId,
      content: request.content,
      response,
    });
    while (this.receipts.size > PRIVATE_CONNECT_RUNTIME_LIMITS.deliveryReceipts) {
      const oldest = this.receipts.keys().next().value;
      if (typeof oldest === "string") this.receipts.delete(oldest);
    }
  }

  private promptSafety(conversation: Conversation): PrivateConnectPromptSafety {
    const resolve = this.dependencies.privateConnectPromptSafety;
    if (!resolve) return UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY;
    try {
      return resolve(conversation) ?? UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY;
    } catch {
      return UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY;
    }
  }

  private prunePreparedPrompts(): void {
    const cutoff = this.now().getTime() - PREPARED_PROMPT_TTL_MS;
    for (const [preparationId, pending] of this.pendingPreparations) {
      if (pending.createdAt >= cutoff) continue;
      this.pendingPreparations.delete(preparationId);
      if (
        this.latestPreparationIdByRequest.get(pending.key) === preparationId
      ) {
        this.latestPreparationIdByRequest.delete(pending.key);
      }
    }
    for (const [preparationId, prepared] of this.preparedPrompts) {
      if (prepared.createdAt >= cutoff) continue;
      this.preparedPrompts.delete(preparationId);
      if (
        this.latestPreparationIdByRequest.get(prepared.key)
          === preparationId
      ) {
        this.latestPreparationIdByRequest.delete(prepared.key);
      }
    }
  }
}

function safePrivateConnectPlan(
  plan: ConversationDetail["plans"][number] | undefined,
): { steps: Array<{ label: string; status: "pending" | "inProgress" | "completed" }> } | null {
  if (!plan) return null;
  return {
    steps: plan.steps.slice(0, 100).map((step) => ({
      label: sanitizePrivateConnectLabel(step.step) ?? "Plan step",
      status: step.status,
    })),
  };
}

function remotelyAnswerableInput(
  pending: AgentInputRequest | null,
): AgentInputRequest | null {
  if (!pending) return null;
  if (pending.questions.length === 0) return null;
  if (pending.questions.some((question) => question.isSecret)) return null;
  if (pending.questions.length > PRIVATE_CONNECT_QUESTION_LIMITS.questions) return null;
  if (
    pending.questions.some(
      ({ id, options }) => id.length > PRIVATE_CONNECT_QUESTION_LIMITS.identifierCharacters
        || options.length > PRIVATE_CONNECT_QUESTION_LIMITS.options
        || options.some((option) => (
          option.id.length > PRIVATE_CONNECT_QUESTION_LIMITS.identifierCharacters
        )),
    )
  ) return null;
  return pending;
}

function safePrivateConnectQuestions(
  answerable: AgentInputRequest | null,
): PrivateConnectSafeQuestion[] {
  if (!answerable) return [];
  return answerable.questions.map((question) => ({
    id: question.id,
    label: sanitizePrivateConnectLabel(question.question) ?? "Question",
    options: question.options.map((option) => ({
      id: option.id,
      label: sanitizePrivateConnectLabel(option.label) ?? "Option",
    })),
    allowMultiple: question.allowMultiple,
    allowCustomAnswer: question.isOther || question.options.length === 0,
  }));
}

function preparedPromptKey(
  subject: PrivateConnectRuntimeAuthorization,
  request: PrivateConnectPromptRequest,
): string {
  return `${subject.sessionId}:${request.requestId}`;
}

function samePreparedPrompt(
  prepared: PreparedPrivateConnectPrompt,
  subject: PrivateConnectRuntimeAuthorization,
  request: PrivateConnectPromptRequest,
): boolean {
  return prepared.subject.deviceId === subject.deviceId
    && prepared.subject.sessionId === subject.sessionId
    && prepared.subject.grantVersion === subject.grantVersion
    && prepared.subject.expiresAt === subject.expiresAt
    && sameStrings(prepared.subject.scopes, subject.scopes)
    && sameStrings(prepared.subject.projectIds, subject.projectIds)
    && prepared.request.requestId === request.requestId
    && prepared.request.deliveryId === request.deliveryId
    && prepared.request.conversationId === request.conversationId
    && prepared.request.content === request.content;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function authorizedConversation(
  subject: PrivateConnectRuntimeAuthorization,
  detail: ConversationDetail,
): boolean {
  const { id, projectId, archivedAt } = detail.conversation;
  return archivedAt === null
    && subject.projectIds.includes(projectId)
    && privateConnectRuntimeGrantAllowsConversation(subject.grants, projectId, id);
}

function unavailableConversationResponse(requestId: string): PrivateConnectRuntimeResponse {
  return failedResponse(
    requestId,
    "not-found",
    "That conversation is unavailable to this device.",
  );
}

function projectShell(
  snapshot: AppSnapshot,
  subject: PrivateConnectRuntimeAuthorization,
  now: Date,
  safety: (conversation: AppSnapshot["conversations"][number]) => PrivateConnectPromptSafety,
) {
  const projectIds = new Set(subject.projectIds);
  const conversationIds = new Set(
    snapshot.conversations
      .filter(({ id, projectId, archivedAt }) =>
        projectIds.has(projectId)
        && archivedAt === null
        && privateConnectRuntimeGrantAllowsConversation(subject.grants, projectId, id))
      .map(({ id }) => id),
  );
  return {
    generatedAt: now.toISOString(),
    projects: snapshot.projects
      .filter(({ id }) => projectIds.has(id))
      .map((project) => ({
        id: project.id,
        name: sanitizePrivateConnectLabel(project.name) ?? "Project",
      })),
    conversations: snapshot.conversations
      .filter(({ id }) => conversationIds.has(id))
      .map((conversation) => safeConversation(conversation, safety(conversation))),
    runs: snapshot.runs
      .filter((run) =>
        run.kind === "agent"
        && run.conversationId !== null
        && conversationIds.has(run.conversationId))
      .slice(0, PRIVATE_CONNECT_RUNTIME_LIMITS.activities)
      .map((run) => ({
        id: run.id,
        conversationId: run.conversationId,
        label: "Agent run",
        status: run.status,
      })),
  };
}

function safeConversation(
  conversation: AppSnapshot["conversations"][number],
  safety: PrivateConnectPromptSafety = UNSUPPORTED_PRIVATE_CONNECT_PROMPT_SAFETY,
): PrivateConnectRuntimeConversation {
  const usable = conversation.accessMode === "supervised"
    && privateConnectPromptSafetyIsUsable(safety);
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    title: sanitizePrivateConnectLabel(conversation.title) ?? "Conversation",
    providerLabel: PROVIDER_INFO[conversation.providerId].name,
    runId: conversation.latestTurn?.runId ?? null,
    status: conversation.status,
    pendingLocalApproval: conversation.pendingApproval,
    promptSafety: {
      supported: usable,
      headline: sanitizePrivateConnectLabel(
        usable
          ? safety.headline
          : conversation.accessMode === "supervised"
            ? safety.headline
            : "Private Connect prompts need Supervised access",
      ) ?? "Private Connect prompts unavailable",
      explanation: sanitizePrivateConnectContent(
        usable
          ? safety.explanation
          : conversation.accessMode === "supervised"
            ? safety.explanation
            : "Switch this conversation to Supervised access on the desktop to "
              + "allow Private Connect prompts.",
        600,
      ),
    },
    updatedAt: conversation.updatedAt,
  };
}

function safeActivityTitle(
  kind: ConversationDetail["activities"][number]["kind"],
  title: string,
): string {
  if (kind === "command") return "Command activity";
  if (kind === "file") return "File activity";
  if (kind === "tool") return "Tool activity";
  return sanitizePrivateConnectLabel(title) ?? "Activity";
}

export function boundPrivateConnectProjection(
  response: PrivateConnectRuntimeResponse,
): PrivateConnectRuntimeResponse {
  if (!response.ok) return response;
  if (response.result.kind === "state") {
    const { state } = response.result;
    state.conversations.sort(
      (left, right) =>
        Date.parse(left.updatedAt) - Date.parse(right.updatedAt),
    );
    keepNewestWithinBudget(response, state.runs, 0, (items) => {
      state.runs = items;
    });
    keepNewestWithinBudget(response, state.conversations, 0, (items) => {
      state.conversations = items;
    });
    keepNewestWithinBudget(response, state.projects, 0, (items) => {
      state.projects = items;
    });
    const conversations = new Set(
      state.conversations.map(({ id }) => id),
    );
    state.runs = state.runs.filter(
      ({ conversationId }) =>
        conversationId === null || conversations.has(conversationId),
    );
    return response;
  }
  if (response.result.kind !== "conversation") return response;
  const { detail } = response.result;
  keepNewestWithinBudget(response, detail.activities, 0, (items) => {
    detail.activities = items;
  });
  keepNewestWithinBudget(response, detail.subagents, 0, (items) => {
    detail.subagents = items;
  });
  keepNewestWithinBudget(
    response,
    detail.messages,
    detail.messages.length > 0 ? 1 : 0,
    (items) => {
      detail.messages = items;
    },
  );
  const newestMessage = detail.messages[0];
  if (
    newestMessage
    && privateConnectBytes(response) > PRIVATE_CONNECT_RUNTIME_LIMITS.plaintextBytes
  ) {
    const content = newestMessage.content;
    let low = 0;
    let high = content.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      newestMessage.content = content.slice(0, middle);
      if (privateConnectBytes(response) <= PRIVATE_CONNECT_RUNTIME_LIMITS.plaintextBytes) low = middle;
      else high = middle - 1;
    }
    newestMessage.content = content.slice(0, low);
  }
  return response;
}

function conditionalProjectionResponse(
  subject: PrivateConnectRuntimeAuthorization,
  request: Extract<PrivateConnectRuntimeRequest, { type: "state.get" | "conversation.get" }>,
  response: PrivateConnectRuntimeResponse,
): PrivateConnectRuntimeResponse {
  if (request.ifNoneMatch === undefined || !response.ok) return response;
  const { result } = response;
  if (result.kind !== "state" && result.kind !== "conversation") {
    return response;
  }
  const projection = result.kind === "state" ? result.state : result.detail;
  const { generatedAt, ...content } = projection;
  const validator = projectionValidator(subject, request, content);
  result.validator = validator;
  if (request.ifNoneMatch !== validator) return response;
  return {
    type: "response",
    requestId: request.requestId,
    ok: true,
    result: {
      kind: "not-modified",
      validator,
      checkedAt: generatedAt,
      resource: request.type === "state.get"
        ? { kind: "state" }
        : {
            kind: "conversation",
            conversationId: request.conversationId,
          },
    },
  };
}

function projectionValidator(
  subject: PrivateConnectRuntimeAuthorization,
  request: Extract<PrivateConnectRuntimeRequest, { type: "state.get" | "conversation.get" }>,
  content: object,
): PrivateConnectRuntimeProjectionValidator {
  const authority = {
    deviceId: subject.deviceId,
    scopes: [...subject.scopes].sort(),
    projectIds: [...subject.projectIds].sort(),
    grants: [...subject.grants]
      .map((grant) => ({
        ...grant,
        conversationIds: [...grant.conversationIds].sort(),
      }))
      .sort((left, right) => left.projectId.localeCompare(right.projectId)),
    grantVersion: subject.grantVersion,
    expiresAt: subject.expiresAt,
  };
  return createHash("sha256")
    .update("inertia-private-connect-projection-v1\0", "utf8")
    .update(JSON.stringify({
      resource: request.type === "state.get"
        ? { kind: "state" }
        : {
            kind: "conversation",
            conversationId: request.conversationId,
          },
      authority,
      content,
    }), "utf8")
    .digest("base64url") as PrivateConnectRuntimeProjectionValidator;
}

function keepNewestWithinBudget<T>(
  response: PrivateConnectRuntimeResponse,
  items: T[],
  minimum: number,
  update: (items: T[]) => void,
): void {
  if (
    privateConnectBytes(response) <= PRIVATE_CONNECT_RUNTIME_LIMITS.plaintextBytes
    || items.length <= minimum
  ) return;
  const original = items;
  let low = minimum;
  let high = original.length;
  update(newestSuffix(original, minimum));
  if (privateConnectBytes(response) > PRIVATE_CONNECT_RUNTIME_LIMITS.plaintextBytes) return;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    update(newestSuffix(original, middle));
    if (privateConnectBytes(response) <= PRIVATE_CONNECT_RUNTIME_LIMITS.plaintextBytes) low = middle;
    else high = middle - 1;
  }
  update(newestSuffix(original, low));
}

function newestSuffix<T>(items: T[], count: number): T[] {
  return count === 0 ? [] : items.slice(-count);
}

function privateConnectBytes(value: unknown): number {
  return new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  ).byteLength;
}

function failedResponse(
  requestId: string,
  code: Extract<PrivateConnectRuntimeResponse, { ok: false }>["code"],
  message: string,
): PrivateConnectRuntimeResponse {
  return {
    type: "response",
    requestId,
    ok: false,
    code,
    message,
  };
}

function requestIdFrom(value: unknown): string {
  if (
    typeof value === "object"
    && value !== null
    && "requestId" in value
    && typeof value.requestId === "string"
    && /^[0-9a-f-]{36}$/iu.test(value.requestId)
  ) return value.requestId;
  return "00000000-0000-4000-8000-000000000000";
}

function publicPrivateConnectError(error: unknown): string {
  if (!(error instanceof Error)) return "The prompt could not be started.";
  const message = sanitizePrivateConnectLabel(error.message, 240);
  return message ?? "The prompt could not be started.";
}
