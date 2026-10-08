import { snapshotPromptContext } from "../../../shared/snapshots";
import { MAX_DOCUMENT_CONTEXT_TOTAL_BYTES } from "../attachments/document-attachment-context";
import type { ChatAttachment } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import { ProviderSteerDeliveryUnknownError, type ProviderSteerInput } from "../../provider/contracts";
import { RuntimeRequestError } from "../../runtime-errors";
import type {
  ActiveTurn,
  FollowUpAdmissionLease,
  FollowUpSteerResult,
  TurnProviderRuntime,
} from "./turn-controller-types";

function providerTurnStarted(active: ActiveTurn, signal?: AbortSignal): Promise<void> {
  if (!signal) return active.runState.providerTurnStarted();
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const settle = (): void => {
      signal.removeEventListener("abort", settle);
      resolve();
    };
    signal.addEventListener("abort", settle, { once: true });
    void active.runState.providerTurnStarted().then(settle);
  });
}

const PROVIDER_ENDED_ANSWER_HARNESSES = new Set(["claude-agent-sdk"]);
const UNKNOWN_DELIVERY = "The provider did not confirm whether it received this follow-up. Check this chat before retrying.";

interface TurnFollowUpCoordinatorOptions {
  store: RuntimeStore;
  providers: TurnProviderRuntime;
  now(): string;
  activeForConversation(conversationId: string): ActiveTurn | undefined;
  answerBoundary?: {
    prepare(active: ActiveTurn, keepAnswerOpen: boolean): { deferred: boolean; after: string | null };
    record(active: ActiveTurn, createdAt: string, deferred: boolean): void;
  };
}

function laterThan(submittedAt: string, after: string | null): string {
  if (!after) return submittedAt;
  return new Date(Math.max(Date.parse(submittedAt), Date.parse(after) + 1)).toISOString();
}

/** Owns exact-turn admission, ordering, acknowledgement, and persistence. */
export class TurnFollowUpCoordinator {
  private readonly owners = new WeakMap<FollowUpAdmissionLease, ActiveTurn>();
  private readonly lastSubmittedAtMs = new WeakMap<ActiveTurn, number>();
  private readonly attachmentCleanups = new WeakMap<ActiveTurn, Set<() => Promise<void>>>();

  constructor(private readonly options: TurnFollowUpCoordinatorOptions) {}

  acquire(active: ActiveTurn | undefined): FollowUpAdmissionLease | null {
    if (
      !active
      || !active.runState.acceptsProviderEvents()
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
    signal?: AbortSignal,
  ): Promise<FollowUpSteerResult> {
    await lease.ready;
    const active = this.owners.get(lease);
    if (active?.runState.awaitingProviderTurn()) await providerTurnStarted(active, signal);
    const current = this.options.activeForConversation(lease.conversationId);
    const followUp = input.content.trim();
    if (
      !active
      || current !== active
      || !active.runState.acceptsProviderEvents()
      || active.turn.runId !== lease.runId
      || active.turn.id !== lease.turnId
    ) return { kind: "turn-ended" };
    if (
      !followUp
      || (input.imagePaths.length > 0 && !lease.supportsImages)
      || !this.options.providers.steer
      || signal?.aborted
    ) return { kind: "unavailable" };
    const snapshotContext = snapshotPromptContext(attachments);
    if (Buffer.byteLength(snapshotContext, "utf8") > MAX_DOCUMENT_CONTEXT_TOTAL_BYTES) {
      throw new Error("Snapshot accessibility context exceeds the follow-up attachment limit.");
    }
    const freshSessionRequest = active.freshSessionRequest;
    active.freshSessionRequest = null;
    let accepted: boolean;
    try {
      accepted = await this.options.providers.steer(
        lease.conversationId,
        { content: [followUp, snapshotContext].filter(Boolean).join("\n\n"), imagePaths: input.imagePaths },
        { runId: active.turn.runId, turnId: active.turn.id },
      );
    } catch (error) {
      if (!(error instanceof ProviderSteerDeliveryUnknownError)) {
        active.freshSessionRequest ??= freshSessionRequest;
        throw error;
      }
      onProviderAcknowledged?.();
      if (error.turnEnded || !this.ownsLiveTurn(active, lease)) {
        return { kind: "unconfirmed", message: UNKNOWN_DELIVERY };
      }
      throw new RuntimeRequestError(UNKNOWN_DELIVERY, undefined, "ambiguous");
    }
    if (!accepted) {
      active.freshSessionRequest ??= freshSessionRequest;
      return { kind: "refused" };
    }
    onProviderAcknowledged?.();
    if (!this.ownsLiveTurn(active, lease)) {
      return { kind: "unconfirmed", message: "The follow-up was accepted as its turn ended. Check this chat before retrying." };
    }
    const boundary = this.options.answerBoundary?.prepare(
      active,
      PROVIDER_ENDED_ANSWER_HARNESSES.has(active.turn.harnessId),
    );
    const message = this.options.store.createAcknowledgedFollowUpMessage(
      lease.conversationId,
      active.turn.id,
      followUp,
      laterThan(lease.submittedAt, boundary?.after ?? null),
      this.options.now(),
      attachments,
    );
    this.options.answerBoundary?.record(active, message.createdAt, boundary?.deferred ?? false);
    return { kind: "accepted", message };
  }

  private ownsLiveTurn(active: ActiveTurn, lease: FollowUpAdmissionLease): boolean {
    return this.options.activeForConversation(lease.conversationId) === active
      && active.runState.acceptsProviderEvents()
      && active.turn.runId === lease.runId
      && active.turn.id === lease.turnId;
  }

  deferAttachmentCleanup(lease: FollowUpAdmissionLease, cleanup: () => Promise<void>): void {
    const active = this.owners.get(lease);
    if (!active) throw new Error("The follow-up attachment lease is no longer owned.");
    const cleanups = this.attachmentCleanups.get(active) ?? new Set<() => Promise<void>>();
    cleanups.add(cleanup);
    this.attachmentCleanups.set(active, cleanups);
  }

  async drain(active: ActiveTurn): Promise<void> {
    while (active.followUpAdmissions.size > 0) {
      await Promise.allSettled(active.followUpAdmissions);
    }
    const cleanups = this.attachmentCleanups.get(active);
    for (const cleanup of cleanups ?? []) {
      await cleanup();
      cleanups!.delete(cleanup);
    }
  }
}
