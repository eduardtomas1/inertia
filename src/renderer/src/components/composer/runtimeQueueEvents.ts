import { useCallback, useSyncExternalStore } from "react";
import type { QueueHoldReason } from "@shared/orchestration-queue";

export const RUNTIME_QUEUE_CHANGED = "inertia:runtime-queue-changed";
export const RUNTIME_QUEUE_RECONNECTED = "inertia:runtime-queue-reconnected";

export interface RuntimeQueueChangedDetail {
  readonly conversationId: string;
  readonly revision?: number;
}

export interface RuntimeQueueSummary {
  readonly userCount: number;
  readonly totalCount: number;
  readonly held: boolean;
  readonly holdReason: QueueHoldReason | null;
  readonly canResume: boolean;
  readonly latestRevision: number;
}

export const EMPTY_RUNTIME_QUEUE_SUMMARY: RuntimeQueueSummary = Object.freeze({
  userCount: 0,
  totalCount: 0,
  held: false,
  holdReason: null,
  canResume: false,
  latestRevision: 0,
});

export function parseRuntimeQueueChangedDetail(detail: unknown): RuntimeQueueChangedDetail | null {
  if (typeof detail === "string" && detail.length > 0) {
    return { conversationId: detail };
  }
  if (detail && typeof detail === "object" && "conversationId" in detail) {
    const record = detail as { conversationId?: unknown; revision?: unknown };
    if (typeof record.conversationId === "string" && record.conversationId.length > 0) {
      return {
        conversationId: record.conversationId,
        ...(typeof record.revision === "number" && Number.isFinite(record.revision)
          ? { revision: record.revision }
          : {}),
      };
    }
  }
  return null;
}

export function announceRuntimeQueueChanged(conversationId: string, revision?: number): void {
  const detail: string | RuntimeQueueChangedDetail = revision === undefined
    ? conversationId
    : { conversationId, revision };
  window.dispatchEvent(new CustomEvent(RUNTIME_QUEUE_CHANGED, { detail }));
}

export function announceRuntimeQueueReconnected(conversationId: string): void {
  window.dispatchEvent(new CustomEvent(RUNTIME_QUEUE_RECONNECTED, { detail: conversationId }));
}

const RUNTIME_QUEUE_LENGTH_CHANGED = "inertia:runtime-queue-length-changed";
const RUNTIME_QUEUE_SUMMARY_CHANGED = "inertia:runtime-queue-summary-changed";
const queueLengths = new Map<string, number>();
const queueSummaries = new Map<string, RuntimeQueueSummary>();

export function setRuntimeQueueLength(conversationId: string, length: number): void {
  if ((queueLengths.get(conversationId) ?? 0) === length) return;
  if (length === 0) queueLengths.delete(conversationId);
  else queueLengths.set(conversationId, length);
  window.dispatchEvent(new CustomEvent(RUNTIME_QUEUE_LENGTH_CHANGED, { detail: conversationId }));
}

function sameSummary(left: RuntimeQueueSummary, right: RuntimeQueueSummary): boolean {
  return left.userCount === right.userCount
    && left.totalCount === right.totalCount
    && left.held === right.held
    && left.holdReason === right.holdReason
    && left.canResume === right.canResume
    && left.latestRevision === right.latestRevision;
}

export function setRuntimeQueueSummary(conversationId: string, summary: RuntimeQueueSummary): void {
  setRuntimeQueueLength(conversationId, summary.userCount);
  const prior = queueSummaries.get(conversationId) ?? EMPTY_RUNTIME_QUEUE_SUMMARY;
  if (sameSummary(prior, summary)) return;
  if (sameSummary(summary, EMPTY_RUNTIME_QUEUE_SUMMARY)) queueSummaries.delete(conversationId);
  else queueSummaries.set(conversationId, Object.freeze({ ...summary }));
  window.dispatchEvent(new CustomEvent(RUNTIME_QUEUE_SUMMARY_CHANGED, { detail: conversationId }));
}

function subscribeLength(onChange: () => void): () => void {
  window.addEventListener(RUNTIME_QUEUE_LENGTH_CHANGED, onChange);
  return () => window.removeEventListener(RUNTIME_QUEUE_LENGTH_CHANGED, onChange);
}

export function useRuntimeQueueLength(conversationId: string): number {
  return useSyncExternalStore(
    subscribeLength,
    useCallback(() => queueLengths.get(conversationId) ?? 0, [conversationId]),
  );
}

function subscribeSummary(onChange: () => void): () => void {
  window.addEventListener(RUNTIME_QUEUE_SUMMARY_CHANGED, onChange);
  return () => window.removeEventListener(RUNTIME_QUEUE_SUMMARY_CHANGED, onChange);
}

export function useRuntimeQueueSummary(conversationId: string): RuntimeQueueSummary {
  return useSyncExternalStore(
    subscribeSummary,
    useCallback(() => queueSummaries.get(conversationId) ?? EMPTY_RUNTIME_QUEUE_SUMMARY, [conversationId]),
  );
}

const RUNTIME_QUEUED_FOLLOW_UPS_CHANGED = "inertia:runtime-queued-follow-ups-changed";
const EMPTY_IDS: readonly string[] = [];
const queuedFollowUps = new Map<string, readonly string[]>();

/**
 * Messages that queue rows name: follow-ups the agent accepted but never read. They wait in the queue to be sent
 * as their own turns, so the timeline hides them until then (T3 `9fb449232`).
 */
export function setRuntimeQueuedFollowUps(conversationId: string, messageIds: readonly string[]): void {
  const prior = queuedFollowUps.get(conversationId) ?? EMPTY_IDS;
  if (prior.length === messageIds.length && prior.every((id, index) => id === messageIds[index])) return;
  if (messageIds.length === 0) queuedFollowUps.delete(conversationId);
  else queuedFollowUps.set(conversationId, [...messageIds]);
  window.dispatchEvent(new CustomEvent(RUNTIME_QUEUED_FOLLOW_UPS_CHANGED, { detail: conversationId }));
}

function subscribeQueuedFollowUps(onChange: () => void): () => void {
  window.addEventListener(RUNTIME_QUEUED_FOLLOW_UPS_CHANGED, onChange);
  return () => window.removeEventListener(RUNTIME_QUEUED_FOLLOW_UPS_CHANGED, onChange);
}

export function useRuntimeQueuedFollowUps(conversationId: string | null): readonly string[] {
  return useSyncExternalStore(subscribeQueuedFollowUps, useCallback(
    () => (conversationId ? queuedFollowUps.get(conversationId) : undefined) ?? EMPTY_IDS, [conversationId]));
}
