import { randomUUID } from "node:crypto";

import { snapshotPromptContext } from "../../../shared/snapshots";
import { previewAnnotationPromptContext } from "../../../shared/preview-annotation";
import { supportsActiveParentFollowUp } from "../../../shared/follow-up-steer";
import { MAX_DOCUMENT_CONTEXT_TOTAL_BYTES } from "../attachments/document-attachment-context";
import type { ChatAttachment } from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import { ProviderSteerDeliveryUnknownError, type ProviderRunResult, type ProviderSteerInput } from "../../provider/contracts";
import { RuntimeRequestError } from "../../runtime-errors";
import type {
  ActiveTurn,
  FollowUpAdmissionLease,
  FollowUpSteerOptions,
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

interface PendingSteerRead {
  steerId: string;
  readAt: string;
  runId: string;
  attemptId: string;
  unsubscribe?: () => void;
}

const steerEffectByLease = new WeakMap<FollowUpAdmissionLease, string>();
const steerEffectByTurn = new WeakMap<ActiveTurn, Map<string, string>>();
const pendingSteerReadsByTurn = new WeakMap<ActiveTurn, Map<string, PendingSteerRead>>();

/** Associates a V2 `provider.steer` effectId with a follow-up admission lease before calling `turns.steer(...)`. */
export function bindSteerEffectId(lease: FollowUpAdmissionLease, effectId: string): void {
  steerEffectByLease.set(lease, effectId);
}

function registerSteerEffect(active: ActiveTurn, steerId: string, effectId: string): void {
  let map = steerEffectByTurn.get(active);
  if (!map) {
    map = new Map();
    steerEffectByTurn.set(active, map);
  }
  map.set(steerId, effectId);
}

function unregisterSteerEffect(active: ActiveTurn, steerId: string): void {
  steerEffectByTurn.get(active)?.delete(steerId);
}

function clearPendingSteerRead(active: ActiveTurn, effectId: string | undefined): void {
  if (!effectId) return;
  const pending = pendingSteerReadsByTurn.get(active);
  const entry = pending?.get(effectId);
  if (!entry) return;
  entry.unsubscribe?.();
  entry.unsubscribe = undefined;
  pending!.delete(effectId);
}

function clearAllPendingSteerReads(active: ActiveTurn): void {
  const pending = pendingSteerReadsByTurn.get(active);
  if (!pending) return;
  for (const entry of pending.values()) {
    entry.unsubscribe?.();
    entry.unsubscribe = undefined;
  }
  pending.clear();
}

function flushPendingSteerRead(store: RuntimeStore, active: ActiveTurn, effectId: string | undefined): boolean {
  if (!effectId) return false;
  const pending = pendingSteerReadsByTurn.get(active);
  const entry = pending?.get(effectId);
  if (!entry) return false;
  const runControl = store.orchestration.runControl;
  try {
    const recorded = runControl.recordSteerRead({
      conversationId: active.conversation.id,
      projectId: active.conversation.projectId,
      runId: entry.runId,
      attemptId: entry.attemptId,
      effectId,
      readAt: entry.readAt,
    });
    if (recorded) {
      clearPendingSteerRead(active, effectId);
      return true;
    }
    const current = runControl.steer(effectId);
    if (!current || current.state !== "dispatching") {
      clearPendingSteerRead(active, effectId);
    }
  } catch {
    return false;
  }
  return false;
}

function flushAllPendingSteerReads(store: RuntimeStore, active: ActiveTurn): void {
  const pending = pendingSteerReadsByTurn.get(active);
  if (!pending || pending.size === 0) return;
  for (const effectId of Array.from(pending.keys())) {
    flushPendingSteerRead(store, active, effectId);
  }
}

/**
 * Records a durable `run-control.steer-read` mark when the provider starts reading an accepted steer.
 * If the callback arrives before durable acceptance commits (`state === "dispatching"`), the read
 * timestamp is preserved per active turn and flushed immediately once durable acceptance lands.
 */
export function recordActiveTurnSteerRead(
  store: RuntimeStore,
  active: ActiveTurn,
  steerId: string,
  readAt?: string,
  fallbackAttemptId?: string | null,
): boolean {
  if (!steerId) return false;
  if (fallbackAttemptId && active.attemptId && fallbackAttemptId !== active.attemptId) return false;
  const runControl = store.orchestration.runControl;
  const mappedEffectId = steerEffectByTurn.get(active)?.get(steerId);
  const effectId = mappedEffectId ?? (runControl.steer(steerId) ? steerId : undefined);
  if (!effectId) return false;
  const target = runControl.target(active.turn.runId);
  const runId = target?.runId ?? active.turn.runId;
  const attemptId = active.attemptId ?? target?.attemptId ?? fallbackAttemptId ?? null;
  if (!attemptId) return false;
  const effectiveReadAt = readAt ?? new Date().toISOString();
  try {
    const recorded = runControl.recordSteerRead({
      conversationId: active.conversation.id,
      projectId: active.conversation.projectId,
      runId,
      attemptId,
      effectId,
      readAt: effectiveReadAt,
    });
    if (recorded) {
      clearPendingSteerRead(active, effectId);
      return true;
    }
    const current = runControl.steer(effectId);
    if (
      current
      && current.runId === runId
      && current.attemptId === attemptId
      && current.state === "dispatching"
    ) {
      let pending = pendingSteerReadsByTurn.get(active);
      if (!pending) {
        pending = new Map();
        pendingSteerReadsByTurn.set(active, pending);
      }
      if (!pending.has(effectId)) {
        const entry: PendingSteerRead = {
          steerId,
          readAt: effectiveReadAt,
          runId,
          attemptId,
        };
        if (typeof runControl.onSteerSettled === "function") {
          entry.unsubscribe = runControl.onSteerSettled((settled) => {
            if (settled.effectId !== effectId) return;
            clearPendingSteerRead(active, effectId);
            if (settled.outcome === "accepted") {
              try {
                runControl.recordSteerRead({
                  conversationId: active.conversation.id,
                  projectId: active.conversation.projectId,
                  runId: settled.runId,
                  attemptId: settled.attemptId,
                  effectId,
                  readAt: entry.readAt,
                });
              } catch {
                // Replaying a buffered steer-read must never break settlement.
              }
            }
          });
        }
        pending.set(effectId, entry);
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Lets a provider's report of an unread follow-up (by steer id) find its persisted message and V2 effect. */
function recordFollowUpMessage(
  store: RuntimeStore,
  active: ActiveTurn,
  steerId: string,
  messageId: string,
  effectId?: string,
): void {
  (active.followUpMessagesBySteerId ??= new Map()).set(steerId, messageId);
  if (effectId) {
    registerSteerEffect(active, steerId, effectId);
    flushPendingSteerRead(store, active, effectId);
  }
}

export const STEER_DELIVERY_NOT_CONFIRMED_TITLE = "Steer delivery not confirmed";

/**
 * A follow-up the provider accepted but never read is not its run's input:
 * settlement leaves it out of the run's coverage and the queue sends it next.
 * On Stop, unread steers are NOT requeued; instead, a visible N14 notice is
 * recorded with each steer's text so the user can resend it if needed.
 */
export function recordUnreadFollowUps(store: RuntimeStore, active: ActiveTurn, result: ProviderRunResult): void {
  flushAllPendingSteerReads(store, active);
  const fromResult = (result.unreadFollowUps ?? [])
    .flatMap((steerId) => active.followUpMessagesBySteerId?.get(steerId) ?? []);
  const durableUnread = active.turn.providerId === "claude"
    ? store.orchestration.runControl.listUnreadAcceptedSteers(active.turn.runId)
        .flatMap((steer) => steer.messageId ? [steer.messageId] : [])
    : [];
  const unreadMessageIds = [...new Set([...fromResult, ...durableUnread])];
  if (unreadMessageIds.length === 0) return;

  const stopped = result.status === "cancelled"
    || store.orchestration.runControl.interruptRequested(active.conversation.id);
  if (stopped) {
    for (const messageId of unreadMessageIds) {
      let text = "";
      try {
        text = store.message(messageId).content.trim();
      } catch {
        continue;
      }
      if (!text) continue;
      const snippet = text.length > 500 ? `${text.slice(0, 500)}…` : text;
      store.addActivity({
        conversationId: active.conversation.id,
        runId: active.turn.runId,
        turnId: active.turn.id,
        kind: "status",
        title: STEER_DELIVERY_NOT_CONFIRMED_TITLE,
        detail: `Steer delivery not confirmed before the run stopped. Resend it if needed: "${snippet}"`,
        status: "completed",
      });
    }
    return;
  }
  active.unreadFollowUpMessageIds = unreadMessageIds;
}

export const UNKNOWN_FOLLOW_UP_DELIVERY = "The provider did not confirm whether it received this follow-up. Check this chat before retrying.";

interface TurnFollowUpCoordinatorOptions {
  store: RuntimeStore;
  providers: TurnProviderRuntime;
  now(): string;
  activeForConversation(conversationId: string): ActiveTurn | undefined;
  answerBoundary?: {
    prepare(active: ActiveTurn): { deferred: boolean; after: string | null };
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
      || !supportsActiveParentFollowUp(active.turn.harnessId)
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
    options: FollowUpSteerOptions = {},
  ): Promise<FollowUpSteerResult> {
    await lease.ready;
    const active = this.owners.get(lease);
    if (active?.runState.awaitingProviderTurn()) await providerTurnStarted(active, signal);
    const current = this.options.activeForConversation(lease.conversationId);
    const followUp = input.content.trim();
    const providerContent = options.providerContent?.trim() ?? followUp;
    const messageOptions = options.watcherNote || options.delegatedCompletion ? [{
      ...(options.watcherNote ? { watcherNote: options.watcherNote } : {}),
      ...(options.delegatedCompletion ? { delegatedCompletion: options.delegatedCompletion } : {}),
    }] as const : [] as const;
    if (
      !active
      || current !== active
      || !active.runState.acceptsProviderEvents()
      || active.turn.runId !== lease.runId
      || active.turn.id !== lease.turnId
    ) return { kind: "turn-ended" };
    if (
      !followUp
      || !providerContent
      || (input.imagePaths.length > 0 && !lease.supportsImages)
      || !this.options.providers.steer
      || signal?.aborted
    ) return { kind: "unavailable" };
    const snapshotContext = [
      snapshotPromptContext(attachments),
      previewAnnotationPromptContext(attachments),
    ].filter(Boolean).join("\n\n");
    if (Buffer.byteLength(snapshotContext, "utf8") > MAX_DOCUMENT_CONTEXT_TOTAL_BYTES) {
      throw new Error("Snapshot accessibility context exceeds the follow-up attachment limit.");
    }
    const freshSessionRequest = active.freshSessionRequest;
    active.freshSessionRequest = null;
    const steerId = randomUUID();
    const effectId = steerEffectByLease.get(lease);
    if (effectId) {
      registerSteerEffect(active, steerId, effectId);
    }
    let accepted: boolean;
    try {
      accepted = await this.options.providers.steer(
        lease.conversationId,
        { content: [providerContent, snapshotContext].filter(Boolean).join("\n\n"), imagePaths: input.imagePaths, steerId },
        { runId: active.turn.runId, turnId: active.turn.id },
      );
    } catch (error) {
      clearPendingSteerRead(active, effectId);
      if (!(error instanceof ProviderSteerDeliveryUnknownError)) {
        unregisterSteerEffect(active, steerId);
        active.freshSessionRequest ??= freshSessionRequest;
        throw error;
      }
      onProviderAcknowledged?.();
      if (error.turnEnded || !this.ownsLiveTurn(active, lease)) {
        return { kind: "unconfirmed", message: UNKNOWN_FOLLOW_UP_DELIVERY };
      }
      throw new RuntimeRequestError(UNKNOWN_FOLLOW_UP_DELIVERY, undefined, "ambiguous");
    }
    if (!accepted) {
      clearPendingSteerRead(active, effectId);
      unregisterSteerEffect(active, steerId);
      active.freshSessionRequest ??= freshSessionRequest;
      return { kind: "refused" };
    }
    onProviderAcknowledged?.();
    if (!this.ownsLiveTurn(active, lease)) {
      const outcome = active.runState.terminalRequest()
        ?? this.options.store.agentTurn(active.turn.id).status;
      if (outcome !== "completed") {
        clearPendingSteerRead(active, effectId);
        return { kind: "unconfirmed", message: "The follow-up was accepted as its turn ended. Check this chat before retrying." };
      }
      const message = this.options.store.createAcknowledgedFollowUpMessage(
        lease.conversationId,
        active.turn.id,
        followUp,
        lease.submittedAt,
        this.options.now(),
        attachments,
        options.queuedMessageId,
        ...messageOptions,
      );
      recordFollowUpMessage(this.options.store, active, steerId, message.id, effectId);
      return { kind: "accepted", message };
    }
    const boundary = this.options.answerBoundary?.prepare(active);
    const message = this.options.store.createAcknowledgedFollowUpMessage(
      lease.conversationId,
      active.turn.id,
      followUp,
      laterThan(lease.submittedAt, boundary?.after ?? null),
      this.options.now(),
      attachments,
      options.queuedMessageId,
      ...messageOptions,
    );
    this.options.answerBoundary?.record(active, message.createdAt, boundary?.deferred ?? false);
    recordFollowUpMessage(this.options.store, active, steerId, message.id, effectId);
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
    clearAllPendingSteerReads(active);
    const cleanups = this.attachmentCleanups.get(active);
    for (const cleanup of cleanups ?? []) {
      await cleanup();
      cleanups!.delete(cleanup);
    }
  }
}
