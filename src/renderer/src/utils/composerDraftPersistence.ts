export interface ComposerDraftPersistence {
  conversationId: string;
  draft: string;
}

type ComposerDraftPersistenceListener = (
  persistence: Readonly<ComposerDraftPersistence>,
) => void;

const listeners = new Set<ComposerDraftPersistenceListener>();
const draftHandoffs = new Map<string, string>();

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

function storeComposerDraft(conversationId: string, draft: string): boolean {
  try {
    const key = `inertia:draft:${conversationId}`;
    if (draft) window.localStorage.setItem(key, draft);
    else window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** Persists one composer draft and notifies this renderer's optional mirror. */
export function persistComposerDraft(
  conversationId: string,
  draft: string,
): void {
  draftHandoffs.delete(conversationId);
  storeComposerDraft(conversationId, draft);
  notifyComposerDraftPersistence({ conversationId, draft });
}

/** Clears only the exact draft accepted by a completed composer operation. */
export function clearPersistedComposerDraft(
  conversationId: string,
  expectedDraft: string,
): void {
  if (draftHandoffs.get(conversationId) === expectedDraft) {
    draftHandoffs.delete(conversationId);
  }
  try {
    const key = `inertia:draft:${conversationId}`;
    if (window.localStorage.getItem(key) !== expectedDraft) return;
    window.localStorage.removeItem(key);
  } catch {
    // The accepted in-memory draft still owns the detached mirror.
  }
  notifyComposerDraftPersistence({ conversationId, draft: "" });
}

export function handOffComposerDraft(
  conversationId: string,
  draft: string,
): boolean {
  const stored = storeComposerDraft(conversationId, draft);
  if (stored) draftHandoffs.delete(conversationId);
  else draftHandoffs.set(conversationId, draft);
  notifyComposerDraftPersistence({ conversationId, draft });
  return stored;
}

export function readComposerDraft(conversationId: string): string {
  const handoff = draftHandoffs.get(conversationId);
  if (handoff !== undefined) return handoff;
  try {
    return window.localStorage.getItem(`inertia:draft:${conversationId}`) ?? "";
  } catch {
    return "";
  }
}

export function takeComposerDraft(conversationId: string): string {
  const draft = readComposerDraft(conversationId);
  draftHandoffs.delete(conversationId);
  return draft;
}

export function onComposerDraftPersisted(
  listener: ComposerDraftPersistenceListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
