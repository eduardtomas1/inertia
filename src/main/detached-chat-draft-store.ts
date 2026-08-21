import { randomUUID } from "node:crypto";

import {
  parseDetachedChatDraftAcknowledgement,
  parseDetachedChatDraftHandoff,
  parsePendingDetachedChatDraft,
  type DetachedChatDraftAcknowledgement,
  type DetachedChatDraftHandoff,
  type PendingDetachedChatDraft,
} from "../shared/desktop.js";
import {
  readSecureAtomicState,
  writeSecureAtomicState,
} from "./secure-atomic-state.js";

const STORE_VERSION = 1;
export const MAX_PENDING_DETACHED_CHAT_DRAFTS = 16;
const MAX_STORE_BYTES = 6 * 1024 * 1024;

export interface DetachedChatDraftStoreSnapshot {
  version: 1;
  drafts: PendingDetachedChatDraft[];
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDetachedChatDraftStore(
  value: unknown,
): DetachedChatDraftStoreSnapshot {
  if (
    !plainObject(value)
    || Object.keys(value).length !== 2
    || value.version !== STORE_VERSION
    || !Array.isArray(value.drafts)
    || value.drafts.length > MAX_PENDING_DETACHED_CHAT_DRAFTS
  ) return { version: STORE_VERSION, drafts: [] };

  const drafts = new Map<string, PendingDetachedChatDraft>();
  for (const candidate of value.drafts) {
    const draft = parsePendingDetachedChatDraft(candidate);
    if (!draft) continue;
    drafts.delete(draft.conversationId);
    drafts.set(draft.conversationId, draft);
  }
  return { version: STORE_VERSION, drafts: [...drafts.values()] };
}

/**
 * Durable queue between an isolated popup and the persistent workbench session.
 * Entries are removed only by an exact main-renderer acknowledgement.
 */
export class DetachedChatDraftStore {
  #entries = new Map<string, PendingDetachedChatDraft>();

  constructor(readonly path: string) {
    const snapshot = this.#read();
    for (const draft of snapshot.drafts) {
      this.#entries.set(draft.conversationId, draft);
    }
  }

  put(value: DetachedChatDraftHandoff): PendingDetachedChatDraft {
    const draft = parseDetachedChatDraftHandoff(value);
    if (!draft) throw new Error("Invalid detached-chat draft handoff");
    const pending = parsePendingDetachedChatDraft({
      ...draft,
      handoffId: randomUUID(),
    });
    if (!pending) throw new Error("Invalid pending detached-chat draft");

    const previous = new Map(this.#entries);
    this.#entries.delete(pending.conversationId);
    this.#entries.set(pending.conversationId, pending);
    while (this.#entries.size > MAX_PENDING_DETACHED_CHAT_DRAFTS) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.#entries.delete(oldest);
    }
    try {
      this.#flush();
    } catch (error) {
      this.#entries = previous;
      throw error;
    }
    return { ...pending };
  }

  acknowledge(value: DetachedChatDraftAcknowledgement): boolean {
    const acknowledgement = parseDetachedChatDraftAcknowledgement(value);
    if (!acknowledgement) {
      throw new Error("Invalid detached-chat draft acknowledgement");
    }
    const current = this.#entries.get(acknowledgement.conversationId);
    if (!current || current.handoffId !== acknowledgement.handoffId) {
      return false;
    }
    const previous = new Map(this.#entries);
    this.#entries.delete(acknowledgement.conversationId);
    try {
      this.#flush();
    } catch (error) {
      this.#entries = previous;
      throw error;
    }
    return true;
  }

  snapshot(): PendingDetachedChatDraft[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry }));
  }

  #flush(): void {
    const snapshot: DetachedChatDraftStoreSnapshot = {
      version: STORE_VERSION,
      drafts: this.snapshot(),
    };
    writeSecureAtomicState(
      this.path,
      JSON.stringify(snapshot),
      MAX_STORE_BYTES,
    );
  }

  #read(): DetachedChatDraftStoreSnapshot {
    try {
      const content = readSecureAtomicState(this.path, MAX_STORE_BYTES);
      if (content === null) return { version: STORE_VERSION, drafts: [] };
      return parseDetachedChatDraftStore(JSON.parse(content));
    } catch {
      return { version: STORE_VERSION, drafts: [] };
    }
  }
}
