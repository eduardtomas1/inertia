import { MAX_CHAT_MESSAGE_CHARS } from "@shared/diff-review";

export interface ComposerDraftPersistence {
  conversationId: string;
  draft: string;
}

type ComposerDraftPersistenceListener = (
  persistence: Readonly<ComposerDraftPersistence>,
) => void;

export const MAX_UNSTORED_COMPOSER_DRAFTS = 16;
const DRAFT_KEY_PREFIX = "inertia:draft:";
const listeners = new Set<ComposerDraftPersistenceListener>();
const unstoredDrafts = new Map<string, string>();
let listeningForStoredDrafts = false;

function notifyComposerDraftPersistence(
  persistence: ComposerDraftPersistence,
): void {
  for (const listener of listeners) {
    try {
      listener(persistence);
    } catch {
      // Draft persistence must not depend on an optional mirror subscriber.
    }
  }
}

function isLocalStorageEvent(event: StorageEvent): boolean {
  try {
    return event.storageArea === window.localStorage;
  } catch {
    return false;
  }
}

function dropSupersededDrafts(event: StorageEvent): void {
  if (!isLocalStorageEvent(event)) return;
  if (event.key === null) unstoredDrafts.clear();
  else if (event.key.startsWith(DRAFT_KEY_PREFIX)) {
    unstoredDrafts.delete(event.key.slice(DRAFT_KEY_PREFIX.length));
  }
  syncStoredDraftListener();
}

function syncStoredDraftListener(): void {
  const listening = unstoredDrafts.size > 0;
  if (listening === listeningForStoredDrafts) return;
  listeningForStoredDrafts = listening;
  if (listening) window.addEventListener("storage", dropSupersededDrafts);
  else window.removeEventListener("storage", dropSupersededDrafts);
}

function rememberUnstoredDraft(conversationId: string, draft: string): void {
  unstoredDrafts.delete(conversationId);
  if (draft.length <= MAX_CHAT_MESSAGE_CHARS) {
    unstoredDrafts.set(conversationId, draft);
    for (const oldest of unstoredDrafts.keys()) {
      if (unstoredDrafts.size <= MAX_UNSTORED_COMPOSER_DRAFTS) break;
      unstoredDrafts.delete(oldest);
    }
  }
  syncStoredDraftListener();
}

function storeComposerDraft(conversationId: string, draft: string): boolean {
  try {
    const key = `${DRAFT_KEY_PREFIX}${conversationId}`;
    if (draft) window.localStorage.setItem(key, draft);
    else window.localStorage.removeItem(key);
  } catch {
    rememberUnstoredDraft(conversationId, draft);
    return false;
  }
  unstoredDrafts.delete(conversationId);
  syncStoredDraftListener();
  return true;
}

/** Persists one composer draft and notifies this renderer's optional mirror. */
export function persistComposerDraft(
  conversationId: string,
  draft: string,
): boolean {
  const stored = storeComposerDraft(conversationId, draft);
  notifyComposerDraftPersistence({ conversationId, draft });
  return stored;
}

/** Clears only the exact draft accepted by a completed composer operation. */
export function clearPersistedComposerDraft(
  conversationId: string,
  expectedDraft: string,
): void {
  const unstored = unstoredDrafts.get(conversationId);
  try {
    const current = unstored
      ?? window.localStorage.getItem(`${DRAFT_KEY_PREFIX}${conversationId}`);
    if (current !== expectedDraft) return;
  } catch {
    // The accepted in-memory draft still owns the detached mirror.
  }
  storeComposerDraft(conversationId, "");
  notifyComposerDraftPersistence({ conversationId, draft: "" });
}

export function readComposerDraft(conversationId: string): string {
  const unstored = unstoredDrafts.get(conversationId);
  if (unstored !== undefined) return unstored;
  try {
    return window.localStorage.getItem(`${DRAFT_KEY_PREFIX}${conversationId}`) ?? "";
  } catch {
    return "";
  }
}

export function onComposerDraftPersisted(
  listener: ComposerDraftPersistenceListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
