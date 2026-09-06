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
  };
}

function priority(status: MascotStatus): number {
  if (status.phase === "waiting-for-input" || status.phase === "waiting-for-approval") return 4;
  if (status.activeCount) return 3;
  if (status.phase === "failed" || status.phase === "interrupted") return 2;
  return 1;
}

/** Keeps only bounded identities/phases; never copies prompts, titles or provider text. */
export class MascotStatusPublisher {
  private readonly conversations = new Map<string, { status: MascotStatus; at: string }>();
  private last = "";
  constructor(private readonly publish?: (status: MascotStatus) => void) {}

  replace(conversations: readonly ConversationShell[]): void {
    if (!this.publish) return;
    this.conversations.clear();
    for (const conversation of conversations) this.store(conversation);
    this.emit();
  }

  update(conversation: ConversationShell): void {
    if (!this.publish) return;
    this.store(conversation);
    this.emit();
  }

  private store(conversation: ConversationShell): void {
    const status = candidate(conversation);
    if (status) this.conversations.set(conversation.id, {
      status, at: conversation.latestTurn!.updatedAt,
    });
    else this.conversations.delete(conversation.id);
  }

  private emit(): void {
    let selected: { status: MascotStatus; at: string } | undefined;
    let activeCount = 0;
    for (const next of this.conversations.values()) {
      activeCount += next.status.activeCount;
      if (!selected || priority(next.status) > priority(selected.status)
        || (priority(next.status) === priority(selected.status)
          && (next.at > selected.at || (next.at === selected.at
            && next.status.conversationId! < selected.status.conversationId!)))) selected = next;
    }
    const status = selected ? { ...selected.status, activeCount } : emptyMascotStatus();
    const serialized = JSON.stringify(status);
    if (serialized === this.last) return;
    this.last = serialized;
    this.publish?.(status);
  }
}
