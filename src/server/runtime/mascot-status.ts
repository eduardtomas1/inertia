import type { RuntimeMutationEvent } from "../../shared/contracts/events";
import type { ConversationShell } from "../../shared/contracts/app";
import { agentRunStateForTurn } from "../../shared/run-state";
import { emptyMascotStatus, type MascotStatus } from "../../shared/mascot";

function candidate(conversation: ConversationShell): MascotStatus | null {
  const turn = conversation.latestTurn;
  if (conversation.archivedAt || !turn) return null;
  const phase = agentRunStateForTurn(turn);
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(phase);
  if (terminal && (!turn.completedAt || (conversation.lastViewedAt ?? "") >= turn.completedAt)) return null;
  return {
    phase,
    projectId: conversation.projectId,
    conversationId: conversation.id,
    runId: turn.runId,
    turnId: turn.id,
    activeCount: terminal ? 0 : 1,
    chatTitle: preview(conversation.title, 96), message: null, progress: null,
  };
}

function priority(status: MascotStatus): number {
  if (status.phase === "waiting-for-input" || status.phase === "waiting-for-approval") return 4;
  if (status.activeCount) return 3;
  if (status.phase === "failed" || status.phase === "interrupted") return 2;
  return 1;
}

function preview(value: string | null | undefined, limit = 280): string | null {
  const text = (value ?? "").slice(0, 4_096)
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/`([^`]+)`|\*\*([^*]+)\*\*/gu, (_match, code: string | undefined, bold: string | undefined) => code ?? bold ?? "")
    .replace(/^#{1,6}\s+/u, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/[\s\x00-\x1f\x7f]+/gu, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text || null;
}
interface Candidate {
  status: MascotStatus;
  at: string;
  activityAt: string;
  requests: Map<string, { phase: MascotStatus["phase"]; message: string; progress: string | null }>;
}

/** Event-driven previews, scoped to the authoritative turn; never retains a transcript. */
export class MascotStatusPublisher {
  private readonly conversations = new Map<string, Candidate>();
  private last = "";
  constructor(
    private readonly publish?: (status: MascotStatus) => void,
    private readonly lookup?: (id: string) => ConversationShell | null,
  ) {}

  replace(conversations: readonly ConversationShell[]): void {
    if (!this.publish) return;
    const ids = new Set(conversations.map(({ id }) => id));
    for (const id of this.conversations.keys()) if (!ids.has(id)) this.conversations.delete(id);
    for (const conversation of conversations) this.store(conversation);
    this.emit();
  }

  update(conversation: ConversationShell): void {
    if (!this.publish) return;
    this.store(conversation);
    this.emit();
  }

  observe(event: RuntimeMutationEvent): void {
    if (!this.publish) return;
    if (event.type === "conversation.shell.updated") { this.update(event.conversation); return; }
    const owner = event.type === "agent.activity" ? event.activity
      : event.type === "agent.commentary.persisted" ? event.message
      : event.type === "agent.plan.updated" ? event.plan
      : event.type === "agent.input.requested" || event.type === "agent.approval.requested" ? event.request
      : event.type === "agent.input.resolved" || event.type === "agent.approval.resolved"
        || event.type === "agent.completed" || event.type === "agent.failed" ? event : null;
    if (!owner) return;
    const shell = this.lookup?.(owner.conversationId);
    if (shell) this.store(shell);
    const entry = this.conversations.get(owner.conversationId);
    if (!entry || !owner.turnId || owner.turnId !== entry.status.turnId
      || ("runId" in owner && owner.runId !== entry.status.runId)) return;
    const { status, requests } = entry;
    const live = status.activeCount > 0;
    switch (event.type) {
      case "agent.input.requested": {
        if (!live) return;
        const first = event.request.questions[0];
        const message = first?.isSecret ? "Sensitive information is needed. Answer privately in the chat."
          : preview(first?.question) ?? "Choose which conversation context to share in the chat.";
        requests.set(`input:${event.request.id}`, { phase: "waiting-for-input", message,
          progress: event.request.questions.length > 1 ? `${event.request.questions.length} questions to answer` : null });
        break;
      }
      case "agent.approval.requested":
        if (!live) return;
        requests.set(`approval:${event.request.id}`, { phase: "waiting-for-approval",
          message: preview([event.request.title, event.request.reason].filter(Boolean).join(" — ")) ?? "Review the requested permission in the chat.", progress: null });
        break;
      case "agent.input.resolved": requests.delete(`input:${event.requestId}`); break;
      case "agent.approval.resolved": requests.delete(`approval:${event.requestId}`); break;
      case "agent.activity":
        if (!live || status.phase.startsWith("waiting-") || event.activity.kind === "reasoning"
          || event.activity.createdAt < entry.activityAt) return;
        entry.activityAt = event.activity.createdAt;
        status.message = preview(`${event.activity.status === "completed" ? "Finished: " : event.activity.status === "failed" ? "Failed: " : ""}${event.activity.title}`);
        break;
      case "agent.commentary.persisted":
        if (!live || event.message.role !== "assistant" || event.message.createdAt < entry.activityAt) return;
        entry.activityAt = event.message.createdAt;
        status.message = preview(event.message.content);
        break;
      case "agent.plan.updated":
        if (!live) return;
        status.progress = event.plan.steps.length
          ? `${event.plan.steps.filter(({ status: stepStatus }) => stepStatus === "completed").length} of ${event.plan.steps.length} steps complete` : null;
        status.message = preview(event.plan.steps.find(({ status: stepStatus }) => stepStatus === "inProgress")?.step) ?? status.message;
        break;
      case "agent.completed":
      case "agent.failed": {
        if (status.phase !== event.status) return;
        const final = event.terminalAssistantMessage;
        status.message = event.type === "agent.failed" ? preview(event.message)
          : event.status === "completed" && final?.conversationId === status.conversationId
            && final.turnId === status.turnId && final.role === "assistant" ? preview(final.content) : null;
        status.progress = null;
        requests.clear();
        break;
      }
    }
    // Retain only small previews even if a provider sends excessive concurrent requests.
    if (requests.size > 32) requests.delete(requests.keys().next().value!);
    this.emit();
  }

  private store(conversation: ConversationShell): void {
    const status = candidate(conversation);
    if (!status) { this.conversations.delete(conversation.id); return; }
    const previous = this.conversations.get(conversation.id);
    const sameTurn = previous?.status.turnId === status.turnId && previous.status.runId === status.runId;
    const keep = sameTurn && (status.activeCount > 0 || previous.status.phase === status.phase);
    this.conversations.set(conversation.id, {
      status: { ...status, message: keep ? previous.status.message : null, progress: keep ? previous.status.progress : null },
      // Activity updates must not bounce between live chats.
      at: status.activeCount ? conversation.latestTurn!.requestedAt : conversation.latestTurn!.updatedAt,
      activityAt: keep ? previous.activityAt : "",
      requests: sameTurn && status.activeCount ? previous.requests : new Map(),
    });
  }

  private emit(): void {
    let selected: Candidate | undefined;
    let activeCount = 0;
    for (const next of this.conversations.values()) {
      activeCount += next.status.activeCount;
      if (!selected || priority(next.status) > priority(selected.status)
        || (priority(next.status) === priority(selected.status)
          && (next.at > selected.at || (next.at === selected.at
            && next.status.conversationId! < selected.status.conversationId!)))) selected = next;
    }
    const request = selected && [...selected.requests.values()].find(({ phase }) => phase === selected.status.phase);
    const status = selected ? { ...selected.status, activeCount,
      ...(request ? { message: request.message, progress: request.progress }
        : selected.status.phase.startsWith("waiting-") ? { message: null, progress: null } : {}),
    } : emptyMascotStatus();
    const serialized = JSON.stringify(status);
    if (serialized === this.last) return;
    this.last = serialized;
    this.publish?.(status);
  }
}
