import type { ChatAttachment, ChatMessage } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import type { ProviderSteerInput } from "../../provider/contracts";
import type {
  ActiveTurn,
  FollowUpAdmissionLease,
  TurnProviderRuntime,
} from "./turn-controller-types";

interface TurnFollowUpCoordinatorOptions {
  store: RuntimeStore;
  providers: TurnProviderRuntime;
  now(): string;
  activeForConversation(conversationId: string): ActiveTurn | undefined;
}

/** Owns exact-turn admission, ordering, acknowledgement, and persistence. */
export class TurnFollowUpCoordinator {
  private readonly owners = new WeakMap<FollowUpAdmissionLease, ActiveTurn>();
  private readonly lastSubmittedAtMs = new WeakMap<ActiveTurn, number>();

  constructor(private readonly options: TurnFollowUpCoordinatorOptions) {}

  acquire(active: ActiveTurn | undefined): FollowUpAdmissionLease | null {
    if (
      !active
      || active.settled
      || !active.acceptingProviderEvents
      || !this.options.providers.steer
      || ![
        "codex-app-server",
        "claude-agent-sdk",
        "opencode-sdk",
      ].includes(active.turn.harnessId)
    ) return null;
    const ready = active.followUpAdmissionTail.catch(() => undefined);
    let releaseAdmission!: () => void;
    const admission = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    active.followUpAdmissions.add(admission);
    active.followUpAdmissionTail = ready.then(() => admission);
    const clockMs = Date.parse(this.options.now());
    const previousSubmittedAtMs = this.lastSubmittedAtMs.get(active);
    const submittedAtMs = previousSubmittedAtMs === undefined
      ? clockMs
      : Math.max(clockMs, previousSubmittedAtMs + 1);
    this.lastSubmittedAtMs.set(active, submittedAtMs);
    let released = false;
    const lease: FollowUpAdmissionLease = {
      conversationId: active.conversation.id,
      runId: active.turn.runId,
      turnId: active.turn.id,
      supportsImages: active.supportsFollowUpImages,
      submittedAt: new Date(submittedAtMs).toISOString(),
      ready,
      release: () => {
        if (released) return;
        released = true;
        this.owners.delete(lease);
        active.followUpAdmissions.delete(admission);
        releaseAdmission();
      },
    };
    this.owners.set(lease, active);
    return lease;
  }

  async steer(
    lease: FollowUpAdmissionLease,
    input: ProviderSteerInput,
    attachments: readonly ChatAttachment[],
    onProviderAcknowledged?: () => void,
  ): Promise<ChatMessage | null> {
    await lease.ready;
    const active = this.owners.get(lease);
    const current = this.options.activeForConversation(lease.conversationId);
    const followUp = input.content.trim();
    if (
      !active
      || current !== active
      || active.settled
      || !active.acceptingProviderEvents
      || active.turn.runId !== lease.runId
      || active.turn.id !== lease.turnId
      || !followUp
      || (input.imagePaths.length > 0 && !lease.supportsImages)
      || !this.options.providers.steer
    ) return null;
    const accepted = await this.options.providers.steer(
      lease.conversationId,
      { content: followUp, imagePaths: input.imagePaths },
      { runId: active.turn.runId, turnId: active.turn.id },
    );
    if (!accepted) return null;
    onProviderAcknowledged?.();
    return this.options.store.createAcknowledgedFollowUpMessage(
      lease.conversationId,
      active.turn.id,
      followUp,
      lease.submittedAt,
      this.options.now(),
      attachments,
    );
  }

  async drain(active: ActiveTurn): Promise<void> {
    while (active.followUpAdmissions.size > 0) {
      await Promise.allSettled(active.followUpAdmissions);
    }
  }
}
