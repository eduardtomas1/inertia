import type {
  AppSnapshot,
  Conversation,
  ConversationDetail,
} from "../shared/contracts";
import {
  REMOTE_LIMITS,
  remoteRequestSchema,
  type RemoteAuthorizationSubject,
  type RemoteRequest,
  type RemoteResponse,
  type RemoteSafeConversation,
} from "../shared/remote-protocol";
import {
  sanitizeRemoteContent,
  sanitizeRemoteLabel,
} from "../shared/remote-sanitizer";
import { PROVIDER_INFO } from "./provider/catalog";

interface RemoteGatewayDependencies {
  shell(): AppSnapshot;
  detail(conversationId: string): ConversationDetail | null;
  isConversationActive(conversationId: string): boolean;
  preparePrompt(conversation: Conversation): Promise<void>;
  queuePrompt(conversationId: string, content: string): {
    turnId: string;
  };
  now?(): Date;
}

interface DeliveryReceipt {
  conversationId: string;
  content: string;
  response: RemoteResponse;
}

export class RemoteRuntimeGateway {
  private readonly receipts = new Map<string, DeliveryReceipt>();
  private readonly now: () => Date;

  constructor(private readonly dependencies: RemoteGatewayDependencies) {
    this.now = dependencies.now ?? (() => new Date());
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
    return await this.prompt(subject, request);
  }

  private conversation(
    subject: RemoteAuthorizationSubject,
    request: Extract<RemoteRequest, { type: "conversation.get" }>,
  ): RemoteResponse {
    const detail = this.dependencies.detail(request.conversationId);
    if (!detail || !subject.projectIds.includes(detail.conversation.projectId)) {
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
              content: sanitizeRemoteContent(message.content),
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

  private async prompt(
    subject: RemoteAuthorizationSubject,
    request: Extract<RemoteRequest, { type: "prompt.send" }>,
  ): Promise<RemoteResponse> {
    if (!subject.scopes.includes("prompt")) {
      return failedResponse(
        request.requestId,
        "forbidden",
        "Prompting is not enabled for this device.",
      );
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
    const detail = this.dependencies.detail(request.conversationId);
    if (!detail || !subject.projectIds.includes(detail.conversation.projectId)) {
      return failedResponse(
        request.requestId,
        "not-found",
        "That conversation is unavailable to this device.",
      );
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
    try {
      await this.dependencies.preparePrompt(detail.conversation);
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
