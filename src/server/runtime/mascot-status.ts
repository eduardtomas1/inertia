import type { RuntimeMutationEvent } from "../../shared/contracts/events";
import type { ConversationShell, Project } from "../../shared/contracts/app";
import { agentRunStateForTurn } from "../../shared/run-state";
import { isTurnCheckpointUnavailableActivity } from "../../shared/turn-checkpoint";
import {
  emptyMascotStatus, isLiveMascotPhase, isMascotAttention, MASCOT_CHAT_LIMIT, MASCOT_ROW_LIMIT, mascotTier, parseMascotStatus,
  type MascotStatus,
} from "../../shared/mascot";
import type { MascotFeed } from "../../shared/mascot-feed";
import {
  mascotActivityLine, mascotApprovalLine, mascotCommentaryLine, mascotPreview, mascotResultLine,
} from "./mascot-message";

const MINUTE = 60_000;
export const MASCOT_QUIET_AFTER_MS = 10 * MINUTE;
export const MASCOT_DWELL_MS = 1_500;
const LIFETIME: Record<number, number> = { 4: 24 * 60 * MINUTE, 3: 60 * MINUTE, 2: 7 * 24 * 60 * MINUTE };
const LONGEST_WAKE = 2_147_483_647;

export interface MascotClock {
  now(): number;
  wake(delay: number, task: () => void): () => void;
}

const systemClock: MascotClock = {
  now: () => Date.now(),
  wake: (delay, task) => {
    const timer = setTimeout(task, delay);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

function timestamp(value: string | null | undefined): string | null {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

interface Line {
  text: string | null;
  weight: number;
  at: number;
}

interface Candidate {
  status: MascotStatus;
  seen: boolean;
  at: string;
  changedAt: number;
  heardAt: number;
  tier: number;
  commentary: { text: string; at: string } | null;
  step: string | null;
  activity: { text: string; at: string } | null;
  outcome: string | null;
  line: Line;
  requests: Map<string, { phase: MascotStatus["phase"]; message: string; progress: string | null }>;
}

const settledRequests: Candidate["requests"] = new Map();

export function keepBest<T>(best: T[], entry: T, limit: number, compare: (left: T, right: T) => number): void {
  if (best.length === limit && compare(entry, best[limit - 1]!) > 0) return;
  let index = best.length;
  while (index > 0 && compare(entry, best[index - 1]!) < 0) index -= 1;
  best.splice(index, 0, entry);
  if (best.length > limit) best.pop();
}

function rank(left: Candidate, right: Candidate): number {
  if (left.tier !== right.tier) return right.tier - left.tier;
  if (left.at !== right.at) return left.at > right.at ? -1 : 1;
  return left.status.conversationId! < right.status.conversationId! ? -1 : 1;
}

/** Event-driven previews, scoped to the authoritative turn; never retains a transcript. */
export class MascotStatusPublisher {
  private readonly conversations = new Map<string, Candidate>();
  private projects = new Map<string, string | null>();
  private focused: string | null = null;
  private shown: string | null = null;
  private request: number | null = null;
  private pending = false;
  private closed = false;
  private last = "";
  private wakeAt = Number.POSITIVE_INFINITY;
  private nextWake = Number.POSITIVE_INFINITY;
  private cancelWake: (() => void) | null = null;
  constructor(
    private readonly publish?: (feed: MascotFeed) => void,
    private readonly lookup?: (id: string) => ConversationShell | null,
    private readonly projectName?: (id: string) => string | null,
    private readonly schedule: (task: () => void) => void = (task) => queueMicrotask(task),
    private readonly clock: MascotClock = systemClock,
  ) {}

  replace(conversations: readonly ConversationShell[], projects: readonly Pick<Project, "id" | "name">[] = []): void {
    if (!this.publish) return;
    this.projects = new Map(projects.map(({ id, name }) => [id, name]));
    const ids = new Set(conversations.map(({ id }) => id));
    for (const id of this.conversations.keys()) if (!ids.has(id)) this.conversations.delete(id);
    for (const conversation of conversations) this.store(conversation);
    this.emit();
  }

  focus(conversationId: string | null, request: number): void {
    this.request = request;
    this.focused = conversationId !== null && this.conversations.has(conversationId) ? conversationId : null;
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
    if (event.type === "agent.text" || event.type === "agent.reasoning" || event.type === "agent.subagent.updated") {
      const owner = event.type === "agent.subagent.updated" ? event.trace : event;
      const entry = this.conversations.get(owner.conversationId);
      if (!entry || entry.status.turnId !== owner.turnId || entry.status.runId !== owner.runId) return;
      const quiet = this.quiet(entry, this.clock.now());
      entry.heardAt = this.clock.now();
      if (quiet) this.emit();
      return;
    }
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
    if (live) entry.heardAt = this.clock.now();
    switch (event.type) {
      case "agent.input.requested": {
        if (!live) return;
        const first = event.request.questions[0];
        const message = first?.isSecret ? "Sensitive information is needed. Answer privately in the chat."
          : mascotPreview(first?.question) ?? "Choose which conversation context to share in the chat.";
        requests.set(`input:${event.request.id}`, { phase: "waiting-for-input", message,
          progress: event.request.questions.length > 1 ? `${event.request.questions.length} questions to answer` : null });
        break;
      }
      case "agent.approval.requested":
        if (!live) return;
        requests.set(`approval:${event.request.id}`, { phase: "waiting-for-approval", message: mascotApprovalLine(event.request), progress: null });
        break;
      case "agent.input.resolved": requests.delete(`input:${event.requestId}`); break;
      case "agent.approval.resolved": requests.delete(`approval:${event.requestId}`); break;
      case "agent.activity": {
        if (!live || isTurnCheckpointUnavailableActivity(event.activity)
          || (entry.activity && event.activity.createdAt < entry.activity.at)) return;
        const text = mascotActivityLine(event.activity);
        if (text) entry.activity = { text, at: event.activity.createdAt };
        break;
      }
      case "agent.commentary.persisted": {
        if (!live || event.message.role !== "assistant"
          || (entry.commentary && event.message.createdAt < entry.commentary.at)) return;
        const text = mascotCommentaryLine(event.message.content);
        if (text) entry.commentary = { text, at: event.message.createdAt };
        break;
      }
      case "agent.plan.updated": {
        if (!live) return;
        const completed = event.plan.steps.filter(({ status: stepStatus }) => stepStatus === "completed").length;
        const total = Math.min(event.plan.steps.length, 1_000);
        status.steps = total ? { completed: Math.min(completed, total), total } : null;
        status.progress = total ? `${completed} of ${event.plan.steps.length} steps complete` : null;
        entry.step = mascotPreview(event.plan.steps.find(({ status: stepStatus }) => stepStatus === "inProgress")?.step);
        break;
      }
      case "agent.completed":
      case "agent.failed": {
        if (status.phase !== event.status) return;
        const final = event.terminalAssistantMessage;
        entry.outcome = event.type === "agent.failed" ? mascotPreview(event.message)
          : event.status === "completed" && final?.conversationId === status.conversationId
            && final.turnId === status.turnId && final.role === "assistant" ? mascotResultLine(final.content) : null;
        status.progress = null;
        status.steps = null;
        requests.clear();
        break;
      }
    }
    // Retain only small previews even if a provider sends excessive concurrent requests.
    if (requests.size > 32) requests.delete(requests.keys().next().value!);
    this.emit();
  }

  private store(conversation: ConversationShell): void {
    const { projectId } = conversation;
    if (!this.projects.has(projectId)) this.projects.set(projectId, this.projectName?.(projectId) ?? null);
    const turn = conversation.latestTurn;
    if (conversation.archivedAt || !turn) { this.conversations.delete(conversation.id); return; }
    const phase = agentRunStateForTurn(turn);
    const terminal = !isLiveMascotPhase(phase);
    const previous = this.conversations.get(conversation.id);
    const sameTurn = previous?.status.turnId === turn.id && previous.status.runId === turn.runId;
    const keep = sameTurn && (!terminal || previous.status.phase === phase);
    const now = this.clock.now();
    const changed = Date.parse(terminal ? turn.completedAt ?? turn.updatedAt : turn.updatedAt);
    this.conversations.set(conversation.id, {
      status: {
        phase, projectId, conversationId: conversation.id, runId: turn.runId, turnId: turn.id, activeCount: terminal ? 0 : 1,
        chatTitle: mascotPreview(conversation.title, 96), projectName: mascotPreview(this.projects.get(projectId), 64),
        message: null, progress: keep ? previous.status.progress : null, steps: keep ? previous.status.steps : null,
        since: timestamp(terminal ? turn.completedAt ?? turn.updatedAt : turn.startedAt ?? turn.requestedAt), quietSince: null,
      },
      seen: terminal && (!turn.completedAt || (conversation.lastViewedAt ?? "") >= turn.completedAt),
      // Activity updates must not bounce between live chats.
      at: terminal ? turn.updatedAt : turn.requestedAt,
      changedAt: sameTurn && previous.status.phase === phase ? previous.changedAt : Number.isFinite(changed) ? changed : now,
      heardAt: sameTurn && previous.status.phase === phase ? previous.heardAt : now,
      tier: 0,
      commentary: keep ? previous.commentary : null,
      step: keep ? previous.step : null,
      activity: keep ? previous.activity : null,
      outcome: keep ? previous.outcome : null,
      line: sameTurn ? previous.line : { text: null, weight: 0, at: 0 },
      requests: terminal ? settledRequests : sameTurn && previous.status.activeCount ? previous.requests : new Map(),
    });
  }

  close(): void {
    this.closed = true;
    this.cancelWake?.();
    this.cancelWake = null;
    this.wakeAt = Number.POSITIVE_INFINITY;
  }

  private emit(): void {
    if (!this.publish || this.pending || this.closed) return;
    this.pending = true;
    this.schedule(() => {
      this.pending = false;
      this.flush();
    });
  }

  private quiet(entry: Candidate, now: number): boolean {
    return entry.status.activeCount > 0 && !isMascotAttention(entry.status.phase) && now - entry.heardAt >= MASCOT_QUIET_AFTER_MS;
  }

  private tier(entry: Candidate, now: number): number {
    const tier = mascotTier(entry.status.phase);
    if (tier === 1) return 1;
    if (tier === 0 || (tier < 4 && entry.seen)) return 0;
    return now - entry.changedAt < LIFETIME[tier]! ? tier : 0;
  }

  private line(entry: Candidate): { text: string | null; weight: number } {
    const { phase } = entry.status;
    if (isMascotAttention(phase)) {
      return { text: [...entry.requests.values()].find((request) => request.phase === phase)?.message ?? null, weight: 4 };
    }
    if (!isLiveMascotPhase(phase)) return { text: entry.outcome, weight: 4 };
    if (entry.commentary) return { text: entry.commentary.text, weight: 3 };
    if (entry.step) return { text: entry.step, weight: 2 };
    return { text: entry.activity?.text ?? null, weight: entry.activity ? 1 : 0 };
  }

  private display(entry: Candidate, activeCount: number, now: number): MascotStatus {
    const next = this.line(entry);
    const current = entry.line;
    if (next.text !== current.text) {
      const elapsed = now - current.at;
      const hold = next.weight < 4 && next.weight <= current.weight && current.text !== null && elapsed >= 0 && elapsed < MASCOT_DWELL_MS;
      if (hold) this.wakeAtMost(current.at + MASCOT_DWELL_MS);
      else entry.line = { text: next.text, weight: next.weight, at: now };
    }
    const request = isMascotAttention(entry.status.phase)
      ? [...entry.requests.values()].find(({ phase }) => phase === entry.status.phase) : undefined;
    const status: MascotStatus = { ...entry.status, activeCount, message: entry.line.text,
      ...(isMascotAttention(entry.status.phase) ? { progress: request?.progress ?? null } : {}),
      quietSince: this.quiet(entry, now) ? new Date(entry.heardAt).toISOString() : null,
    };
    return parseMascotStatus(status) ? status : { ...status, chatTitle: null, projectName: null, message: null, progress: null };
  }

  private wakeAtMost(at: number): void {
    if (at < this.nextWake) this.nextWake = at;
  }

  private flush(): void {
    if (this.closed) return;
    const now = this.clock.now();
    this.nextWake = Number.POSITIVE_INFINITY;
    let activeCount = 0;
    let attention = 0;
    let eligible = 0;
    let focused: Candidate | undefined;
    const listed: Candidate[] = [];
    const ranked: Candidate[] = [];
    for (const entry of this.conversations.values()) {
      entry.tier = this.tier(entry, now);
      activeCount += entry.status.activeCount;
      if (entry.tier === 4) attention += 1;
      if (entry.tier > 1) this.wakeAtMost(entry.changedAt + LIFETIME[entry.tier]!);
      else if (entry.tier === 1 && !this.quiet(entry, now) && !isMascotAttention(entry.status.phase)) this.wakeAtMost(entry.heardAt + MASCOT_QUIET_AFTER_MS);
      if (entry.tier > 0) { eligible += 1; keepBest(ranked, entry, MASCOT_ROW_LIMIT + 1, rank); }
      if (entry.status.conversationId === this.focused) focused = entry;
      keepBest(listed, entry, MASCOT_CHAT_LIMIT, rank);
    }
    const previous = this.shown === null ? undefined : this.conversations.get(this.shown);
    const best = ranked[0];
    const shown = previous && previous.tier > 0 && (!best || best.tier <= previous.tier) ? previous : best;
    this.shown = shown?.status.conversationId ?? null;
    if (shown && listed[0] !== shown) {
      const index = listed.indexOf(shown);
      listed.splice(index < 0 ? MASCOT_CHAT_LIMIT - 1 : index, 1);
      listed.unshift(shown);
    }
    if (focused && !listed.includes(focused)) listed.splice(MASCOT_CHAT_LIMIT - 1, 1, focused);
    if (!focused) this.focused = null;
    const excluded = focused ?? shown;
    const rows = ranked.filter((entry) => entry !== excluded).slice(0, MASCOT_ROW_LIMIT);
    const shownStatuses = new Map<Candidate, MascotStatus>();
    const show = (entry: Candidate): MascotStatus => {
      let value = shownStatuses.get(entry);
      if (!value) shownStatuses.set(entry, value = this.display(entry, activeCount, now));
      return value;
    };
    const status = shown ? show(shown) : { ...emptyMascotStatus(), activeCount };
    const feed: MascotFeed = {
      status, chats: listed.map(show), rows: rows.map(show),
      focus: this.focused,
      counts: { chats: this.conversations.size, attention, others: eligible - Number(Boolean(excluded && excluded.tier > 0)) },
      request: this.request,
    };
    this.rewake(now);
    const serialized = JSON.stringify(feed);
    if (serialized === this.last) return;
    this.last = serialized;
    this.publish?.(feed);
  }

  private rewake(now: number): void {
    const at = this.nextWake;
    if (at === this.wakeAt) return;
    this.cancelWake?.();
    this.cancelWake = null;
    this.wakeAt = at;
    if (Number.isFinite(at)) this.cancelWake = this.clock.wake(Math.min(LONGEST_WAKE, Math.max(0, at - now)), () => {
      this.cancelWake = null;
      this.wakeAt = Number.POSITIVE_INFINITY;
      this.emit();
    });
  }
}
