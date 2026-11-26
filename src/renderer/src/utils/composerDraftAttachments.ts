import type { ChatAttachment } from "@shared/contracts";
import { mergeComposerAttachments } from "./composerAttachments";

export const MAX_COMPOSER_ATTACHMENT_DRAFTS = 8;

type ReleaseAttachment = (attachmentId: string) => Promise<void>;

interface DraftAttachments {
  readonly attachments: readonly ChatAttachment[];
  readonly release: ReleaseAttachment;
}

const MAX_DISCARDED_CONVERSATIONS = 64;
const drafts = new Map<string, DraftAttachments>();
const discarded = new Set<string>();
let releasingOnUnload = false;

function releaseEach(attachments: readonly ChatAttachment[], release: ReleaseAttachment): void {
  for (const { id } of attachments) {
    try {
      void Promise.resolve(release(id)).catch(() => undefined);
    } catch {
      continue;
    }
  }
}

function releaseOnUnload(): void {
  releaseAllComposerDraftAttachments();
}

function syncUnloadListener(): void {
  if (typeof window === "undefined") return;
  const listening = drafts.size > 0;
  if (listening === releasingOnUnload) return;
  releasingOnUnload = listening;
  if (listening) window.addEventListener("beforeunload", releaseOnUnload);
  else window.removeEventListener("beforeunload", releaseOnUnload);
}

export function keepComposerDraftAttachments(
  conversationId: string,
  attachments: readonly ChatAttachment[],
  release: ReleaseAttachment,
): void {
  if (attachments.length === 0) return;
  if (discarded.has(conversationId)) {
    releaseEach(attachments, release);
    return;
  }
  const existing = drafts.get(conversationId);
  drafts.delete(conversationId);
  const merged = mergeComposerAttachments(existing?.attachments ?? [], attachments);
  const kept = new Set(merged.attachments.map(({ id }) => id));
  releaseEach(merged.rejected.filter(({ id }) => !kept.has(id)), release);
  drafts.set(conversationId, { attachments: merged.attachments, release });
  for (const [oldestId, oldest] of drafts) {
    if (drafts.size <= MAX_COMPOSER_ATTACHMENT_DRAFTS) break;
    drafts.delete(oldestId);
    releaseEach(oldest.attachments, oldest.release);
  }
  syncUnloadListener();
}

export function takeComposerDraftAttachments(conversationId: string): ChatAttachment[] {
  const draft = drafts.get(conversationId);
  if (!draft) return [];
  drafts.delete(conversationId);
  syncUnloadListener();
  return [...draft.attachments];
}

export function hasComposerDraftAttachments(conversationId: string): boolean {
  return drafts.has(conversationId);
}

export function discardComposerDraftAttachments(conversationId: string): void {
  discarded.delete(conversationId);
  discarded.add(conversationId);
  for (const oldest of discarded) {
    if (discarded.size <= MAX_DISCARDED_CONVERSATIONS) break;
    discarded.delete(oldest);
  }
  const draft = drafts.get(conversationId);
  if (!draft) return;
  drafts.delete(conversationId);
  releaseEach(draft.attachments, draft.release);
  syncUnloadListener();
}

export function releaseAllComposerDraftAttachments(): void {
  const all = [...drafts.values()];
  drafts.clear();
  for (const draft of all) releaseEach(draft.attachments, draft.release);
  syncUnloadListener();
}
