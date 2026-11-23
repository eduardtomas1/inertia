import type { Dir } from "node:fs";

import type { ChatAttachment } from "../shared/contracts.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ConversationAttachmentReconcileOptions {
  readonly isReferenced?: (id: string) => boolean;
}

export interface AttachmentReconciliationState {
  readonly directory: Dir;
  readonly references: Map<string, ChatAttachment>;
  readonly imported: Map<string, ChatAttachment>;
  readonly isReferenced?: (id: string) => boolean;
  readonly records: Map<string, number>;
  readonly retryNames: string[];
  readonly settled: Promise<void>;
  readonly settle: () => void;
  directoryExhausted: boolean;
  scheduled: boolean;
}

function consistentReferences(references: readonly ChatAttachment[]): Map<string, ChatAttachment> {
  const referenced = new Map<string, ChatAttachment>();
  const conflicted = new Set<string>();
  for (const attachment of references) {
    if (!UUID_PATTERN.test(attachment.id) || conflicted.has(attachment.id)) continue;
    const prior = referenced.get(attachment.id);
    if (
      prior
      && (
        prior.name !== attachment.name
        || prior.mimeType !== attachment.mimeType
        || prior.size !== attachment.size
      )
    ) {
      referenced.delete(attachment.id);
      conflicted.add(attachment.id);
      continue;
    }
    referenced.set(attachment.id, attachment);
  }
  return referenced;
}

export function createAttachmentReconciliationState(
  directory: Dir,
  references: readonly ChatAttachment[],
  options: ConversationAttachmentReconcileOptions,
): AttachmentReconciliationState {
  let settle!: () => void;
  const settled = new Promise<void>((resolveSettled) => { settle = resolveSettled; });
  return {
    directory,
    references: consistentReferences(references),
    imported: new Map<string, ChatAttachment>(),
    ...(options.isReferenced ? { isReferenced: options.isReferenced } : {}),
    records: new Map<string, number>(),
    retryNames: [],
    settled,
    settle,
    directoryExhausted: false,
    scheduled: false,
  };
}

export function queueImportedReferences(
  state: AttachmentReconciliationState,
  references: readonly ChatAttachment[],
): void {
  for (const attachment of references) {
    if (!UUID_PATTERN.test(attachment.id) || state.references.has(attachment.id)) continue;
    state.references.set(attachment.id, attachment);
    state.imported.set(attachment.id, attachment);
  }
}

export function referencedNow(state: AttachmentReconciliationState, id: string): boolean {
  if (!state.isReferenced) return false;
  try {
    return state.isReferenced(id);
  } catch {
    return true;
  }
}
