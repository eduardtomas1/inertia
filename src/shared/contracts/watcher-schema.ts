import { z } from "zod";

import { messageQueueResultSchema } from "../queued-messages";
import {
  MAX_ACTIVE_WATCHERS,
  MAX_WATCHER_FEED_PAGE,
  MAX_WATCHER_LINKS_SERIALIZED_BYTES,
  MAX_WATCHER_LIVE_LABEL_CHARS,
  watcherDeliverySchema,
  watcherFeedItemSchema,
  watcherLinkViewSchema,
  watcherLinksSerializedBytes,
  watcherLivePhaseSchema,
  watcherUsageSchema,
  watcherWakeSummarySchema,
  type WatcherLinkView,
} from "../watcher";

const timestampSchema = z.string().datetime({ offset: true });
const singleLineLabel = z.string().max(MAX_WATCHER_LIVE_LABEL_CHARS).refine((value) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}, "Watcher live labels must stay on one line.");

export const watcherLinkUpdatedEventSchema = z.strictObject({
  type: z.literal("watcher.link.updated"),
  link: watcherLinkViewSchema,
});

export const watcherLinkRemovedEventSchema = z.strictObject({
  type: z.literal("watcher.link.removed"),
  linkId: z.uuid(),
});

export const watcherLiveEventSchema = z.strictObject({
  type: z.literal("watcher.live"),
  linkId: z.uuid(),
  watcherConversationId: z.uuid(),
  turnId: z.string().min(1).max(200),
  phase: watcherLivePhaseSchema,
  label: singleLineLabel.nullable(),
  at: timestampSchema,
});

export const watcherLinkResultSchema = z.strictObject({
  kind: z.literal("watcher.link"),
  link: watcherLinkViewSchema,
});

export const watcherFeedResultSchema = z.strictObject({
  kind: z.literal("watcher.feed"),
  linkId: z.uuid(),
  feedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  items: z.array(watcherFeedItemSchema).max(MAX_WATCHER_FEED_PAGE),
  next: z.strictObject({
    beforeSequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  }).nullable(),
  usage: watcherUsageSchema.optional(),
}).superRefine((result, context) => {
  const ordered = result.items.every((item, index) =>
    index === 0 || item.sequence < result.items[index - 1]!.sequence);
  const uniqueWakes = new Set(result.items.map(({ wakeId }) => wakeId)).size === result.items.length;
  const oldest = result.items.at(-1)?.sequence;
  const pageCoherent = result.next === null
    || (oldest !== undefined && result.next.beforeSequence <= oldest);
  if (!ordered || !uniqueWakes || !pageCoherent) {
    context.addIssue({ code: "custom", message: "Watcher feed pages are newest first, unique, and continue below the oldest item." });
  }
});

export const watcherDeliveryResultSchema = z.strictObject({
  kind: z.literal("watcher.delivery"),
  linkId: z.uuid(),
  wakeId: z.uuid(),
  delivery: watcherDeliverySchema,
  queue: messageQueueResultSchema.optional(),
});

type WatcherEventType = "watcher.link.updated" | "watcher.link.removed" | "watcher.live";

export function watcherMutationEvent(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  switch ((value as { type?: unknown }).type as WatcherEventType) {
    case "watcher.link.updated":
      return watcherLinkUpdatedEventSchema.safeParse(value).success;
    case "watcher.link.removed":
      return watcherLinkRemovedEventSchema.safeParse(value).success;
    case "watcher.live":
      return watcherLiveEventSchema.safeParse(value).success;
    default:
      return false;
  }
}

export const watcherRequestResultValidators = {
  "watcher.link": (value: unknown) => watcherLinkResultSchema.safeParse(value).success,
  "watcher.feed": (value: unknown) => watcherFeedResultSchema.safeParse(value).success,
  "watcher.delivery": (value: unknown) => watcherDeliveryResultSchema.safeParse(value).success,
} as const;

/**
 * Snapshot coherence for `AppSnapshot.watchers`. Links are unique, at most
 * one attached link watches a chat, attached watchers never watch another
 * attached watcher, and every chat present in the snapshot shares the link's
 * project. A projection may omit one side of a link (a detached chat window
 * carries only its own chat), but never both.
 */
export function watcherLinkCollectionCoherent(
  value: unknown,
  conversationProjects: ReadonlyMap<unknown, unknown>,
  projectIds: ReadonlySet<unknown>,
): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const parsed = value.map((entry) => watcherLinkViewSchema.safeParse(entry));
  if (parsed.some((result) => !result.success)) return false;
  const links = parsed.flatMap((result) => result.success ? [result.data] : []);
  const attached = links.filter(({ status }) => status !== "detached");
  const attachedWatchers = new Set(attached.map(({ watcherConversationId }) => watcherConversationId));
  const attachedWatched = attached.map(({ watchedConversationId }) => watchedConversationId);
  const sideCoherent = (link: WatcherLinkView): boolean => {
    const sides = [link.watcherConversationId, link.watchedConversationId]
      .filter((id): id is string => id !== null && conversationProjects.has(id));
    return sides.length > 0 && sides.every((id) => conversationProjects.get(id) === link.projectId);
  };
  return attached.length <= MAX_ACTIVE_WATCHERS
    && new Set(links.map(({ id }) => id)).size === links.length
    && new Set(links.map(({ watcherConversationId }) => watcherConversationId)).size === links.length
    && new Set(attachedWatched).size === attachedWatched.length
    && attachedWatched.every((id) => id === null || !attachedWatchers.has(id))
    && links.every((link) => projectIds.has(link.projectId) && sideCoherent(link))
    && watcherLinksSerializedBytes(links) <= MAX_WATCHER_LINKS_SERIALIZED_BYTES;
}

/** Detail coherence for `ConversationDetail.watcherWakes`: unique and owned by loaded turns. */
export function watcherWakeSummariesCoherent(value: unknown, agentTurns: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || !Array.isArray(agentTurns)) return false;
  const parsed = value.map((entry) => watcherWakeSummarySchema.safeParse(entry));
  if (parsed.some((result) => !result.success)) return false;
  const wakes = parsed.flatMap((result) => result.success ? [result.data] : []);
  const turnIds = new Set(agentTurns.map((turn) => (turn as { id?: unknown }).id));
  return new Set(wakes.map(({ wakeId }) => wakeId)).size === wakes.length
    && new Set(wakes.map(({ turnId }) => turnId)).size === wakes.length
    && wakes.every(({ turnId }) => turnIds.has(turnId));
}
