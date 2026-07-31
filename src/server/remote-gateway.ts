import { randomUUID } from "node:crypto";
import type {
  AppSnapshot,
  Conversation,
  ConversationDetail,
} from "../shared/contracts";
import type { RuntimeRemotePromptPreparation } from "../node/runtime-process-protocol";
import {
  REMOTE_LIMITS,
  remoteRequestSchema,
  type RemoteAuthorizationSubject,
  type RemoteRequest,
  type RemoteResponse,
  type RemoteSafeConversation,
} from "../shared/remote-protocol";
import { sanitizeRemoteLabel } from "../shared/remote-sanitizer";
import { PROVIDER_INFO } from "./provider/catalog";
import { RemoteTranscriptCache } from "./remote-transcript-cache";

interface RemoteGatewayDependencies {
  shell(): AppSnapshot;
  detail(conversationId: string): ConversationDetail | null;
  isConversationActive(conversationId: string): boolean;
  preparePrompt(conversation: Conversation): Promise<void>;
  queuePrompt(conversationId: string, content: string): {
    turnId: string;
  };
  transcriptCache?: RemoteTranscriptCache;
  now?(): Date;
}

interface DeliveryReceipt {
  conversationId: string;
  content: string;
  response: RemoteResponse;
}

type RemotePromptRequest = Extract<RemoteRequest, { type: "prompt.send" }>;

interface PreparedRemotePrompt {
  key: string;
  subject: RemoteAuthorizationSubject;
  request: RemotePromptRequest;
  createdAt: number;
}

interface PendingRemotePromptPreparation {
  key: string;
  createdAt: number;
}

const PREPARED_PROMPT_TTL_MS = 15_000;
const PREPARED_PROMPT_LIMIT =
  REMOTE_LIMITS.sessions * REMOTE_LIMITS.inFlightRequestsPerSession;

export class RemoteRuntimeGateway {
  private readonly receipts = new Map<string, DeliveryReceipt>();
  private readonly preparedPrompts = new Map<string, PreparedRemotePrompt>();
  private readonly latestPreparationIdByRequest = new Map<string, string>();
  private readonly pendingPreparations =
    new Map<string, PendingRemotePromptPreparation>();
  private readonly transcriptCache: RemoteTranscriptCache;
  private readonly now: () => Date;

  constructor(private readonly dependencies: RemoteGatewayDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.transcriptCache = dependencies.transcriptCache
      ?? new RemoteTranscriptCache();
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
    subject: RemoteAuthorizationSubject,
    untrustedRequest: unknown,
  ): Promise<RemoteResponse> {
    const parsed = remoteRequestSchema.safeParse(untrustedRequest);
    if (!parsed.success) {
      return failedResponse(
        requestIdFrom(untrustedRequest),
        "invalid",
        "The remote request was invalid.",
      );
    }
    const request = parsed.data;
    const rejection = this.requestBoundaryRejection(subject, request);
    if (rejection) return rejection;

    if (request.type === "state.get") {
      return boundRemoteProjection({
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: {
          kind: "state",
          state: projectShell(
            this.dependencies.shell(),
            new Set(subject.projectIds),
            this.now(),
          ),
        },
      });
    }
    if (request.type === "conversation.get") {
      return this.conversation(subject, request);
    }
    return failedResponse(
      request.requestId,
      "invalid",
      "Remote prompts require an authorized prepare and commit.",
    );
  }

  private conversation(
    subject: RemoteAuthorizationSubject,
    request: Extract<RemoteRequest, { type: "conversation.get" }>,
  ): RemoteResponse {
    const detail = this.dependencies.detail(request.conversationId);
    if (
      !detail
      || detail.conversation.archivedAt !== null
      || !subject.projectIds.includes(detail.conversation.projectId)
    ) {
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
    );
    return boundRemoteProjection({
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: {
        kind: "conversation",
        detail: {
          generatedAt: this.now().toISOString(),
          conversation: projectedConversation,
          messages: detail.messages
            .filter(({ role }) => role === "user" || role === "assistant")
            .slice(-REMOTE_LIMITS.transcriptMessages)
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
            .slice(-REMOTE_LIMITS.activities)
            .map((activity) => ({
              id: activity.id,
              turnId: activity.turnId,
              kind: activity.kind,
              title: safeActivityTitle(activity.kind, activity.title),
              status: activity.status,
              createdAt: activity.createdAt,
            })),
          subagents: detail.subagents
            .slice(-REMOTE_LIMITS.subagents)
            .map((subagent) => ({
              id: subagent.id,
              turnId: subagent.turnId,
              providerLabel: PROVIDER_INFO[subagent.providerId].name,
              name: sanitizeRemoteLabel(subagent.providerName),
              status: subagent.status,
              description: null,
              progress: null,
              updatedAt: subagent.updatedAt,
            })),
          waitingForLocalAction:
            projectedConversation.pendingLocalApproval
            || shell.conversations.some(
              ({ id, pendingInput }) => id === request.conversationId && pendingInput,
            ),
        },
      },
    });
  }

  async preparePrompt(
    subject: RemoteAuthorizationSubject,
    untrustedRequest: unknown,
  ): Promise<RuntimeRemotePromptPreparation | RemoteResponse> {
    const parsed = remoteRequestSchema.safeParse(untrustedRequest);
    if (!parsed.success || parsed.data.type !== "prompt.send") {
      return failedResponse(
        requestIdFrom(untrustedRequest),
        "invalid",
        "The remote prompt was invalid.",
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
    if (
      !detail
      || detail.conversation.archivedAt !== null
      || !subject.projectIds.includes(detail.conversation.projectId)
    ) {
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
        "Too many remote prompts are awaiting authorization.",
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
          "Remote prompt authorization is no longer current.",
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
        publicRemoteError(error),
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
    subject: RemoteAuthorizationSubject,
    untrustedRequest: unknown,
    preparationId: string,
  ): RemoteResponse {
    const parsed = remoteRequestSchema.safeParse(untrustedRequest);
    if (!parsed.success || parsed.data.type !== "prompt.send") {
      return failedResponse(
        requestIdFrom(untrustedRequest),
        "invalid",
        "The remote prompt was invalid.",
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
        "Remote prompt authorization is no longer current.",
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
      const response: RemoteResponse = {
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
        publicRemoteError(error),
      );
    }
  }

  private requestBoundaryRejection(
    subject: RemoteAuthorizationSubject,
    request: RemoteRequest,
  ): RemoteResponse | null {
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
        "This device cannot view Remote Companion.",
      );
    }
    return null;
  }

  private promptBoundaryRejection(
    subject: RemoteAuthorizationSubject,
    request: Extract<RemoteRequest, { type: "prompt.send" }>,
    detail: ConversationDetail,
  ): RemoteResponse | null {
    if (
      detail.conversation.archivedAt !== null
      || !subject.projectIds.includes(detail.conversation.projectId)
    ) {
      return unavailableConversationResponse(request.requestId);
    }
    if (detail.conversation.accessMode !== "supervised") {
      return failedResponse(
        request.requestId,
        "forbidden",
        "Remote prompting requires Supervised access on the desktop.",
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
    request: Extract<RemoteRequest, { type: "prompt.send" }>,
    response: RemoteResponse,
  ): void {
    this.receipts.set(request.deliveryId, {
      conversationId: request.conversationId,
      content: request.content,
      response,
    });
    while (this.receipts.size > REMOTE_LIMITS.deliveryReceipts) {
      const oldest = this.receipts.keys().next().value;
      if (typeof oldest === "string") this.receipts.delete(oldest);
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

function preparedPromptKey(
  subject: RemoteAuthorizationSubject,
  request: RemotePromptRequest,
): string {
  return `${subject.sessionId}:${request.requestId}`;
}

function samePreparedPrompt(
  prepared: PreparedRemotePrompt,
  subject: RemoteAuthorizationSubject,
  request: RemotePromptRequest,
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

function unavailableConversationResponse(requestId: string): RemoteResponse {
  return failedResponse(
    requestId,
    "not-found",
    "That conversation is unavailable to this device.",
  );
}

function projectShell(
  snapshot: AppSnapshot,
  projectIds: Set<string>,
  now: Date,
) {
  const conversationIds = new Set(
    snapshot.conversations
      .filter(({ projectId, archivedAt }) =>
        projectIds.has(projectId) && archivedAt === null)
      .map(({ id }) => id),
  );
  return {
    generatedAt: now.toISOString(),
    projects: snapshot.projects
      .filter(({ id }) => projectIds.has(id))
      .map((project) => ({
        id: project.id,
        name: sanitizeRemoteLabel(project.name) ?? "Project",
      })),
    conversations: snapshot.conversations
      .filter(({ id }) => conversationIds.has(id))
      .map(safeConversation),
    runs: snapshot.runs
      .filter((run) =>
        run.kind === "agent"
        && run.conversationId !== null
        && conversationIds.has(run.conversationId))
      .slice(0, REMOTE_LIMITS.activities)
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
): RemoteSafeConversation {
  return {
    id: conversation.id,
    projectId: conversation.projectId,
    title: sanitizeRemoteLabel(conversation.title) ?? "Conversation",
    providerLabel: PROVIDER_INFO[conversation.providerId].name,
    status: conversation.status,
    pendingLocalApproval: conversation.pendingApproval,
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
  return sanitizeRemoteLabel(title) ?? "Activity";
}

export function boundRemoteProjection(
  response: RemoteResponse,
): RemoteResponse {
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
    && remoteBytes(response) > REMOTE_LIMITS.plaintextBytes
  ) {
    const content = newestMessage.content;
    let low = 0;
    let high = content.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      newestMessage.content = content.slice(0, middle);
      if (remoteBytes(response) <= REMOTE_LIMITS.plaintextBytes) low = middle;
      else high = middle - 1;
    }
    newestMessage.content = content.slice(0, low);
  }
  return response;
}

function keepNewestWithinBudget<T>(
  response: RemoteResponse,
  items: T[],
  minimum: number,
  update: (items: T[]) => void,
): void {
  if (
    remoteBytes(response) <= REMOTE_LIMITS.plaintextBytes
    || items.length <= minimum
  ) return;
  const original = items;
  let low = minimum;
  let high = original.length;
  update(newestSuffix(original, minimum));
  if (remoteBytes(response) > REMOTE_LIMITS.plaintextBytes) return;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    update(newestSuffix(original, middle));
    if (remoteBytes(response) <= REMOTE_LIMITS.plaintextBytes) low = middle;
    else high = middle - 1;
  }
  update(newestSuffix(original, low));
}

function newestSuffix<T>(items: T[], count: number): T[] {
  return count === 0 ? [] : items.slice(-count);
}

function remoteBytes(value: unknown): number {
  return new TextEncoder().encode(
    typeof value === "string" ? value : JSON.stringify(value),
  ).byteLength;
}

function failedResponse(
  requestId: string,
  code: Extract<RemoteResponse, { ok: false }>["code"],
  message: string,
): RemoteResponse {
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

function publicRemoteError(error: unknown): string {
  if (!(error instanceof Error)) return "The prompt could not be started.";
  const message = sanitizeRemoteLabel(error.message, 240);
  return message ?? "The prompt could not be started.";
}
