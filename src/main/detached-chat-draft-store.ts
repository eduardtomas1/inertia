import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { basename, join } from "node:path";

import { FILE_OPEN_DIRECTORY } from
  "../node/platform-file-open-flags.js";
import {
  parseDetachedChatDraftAcknowledgement,
  parseDetachedChatDraftHandoff,
  parsePendingDetachedChatDraft,
  type DetachedChatDraftAcknowledgement,
  type DetachedChatDraftHandoff,
  type PendingDetachedChatDraft,
} from "../shared/desktop.js";
import {
  readSecureAtomicStateStrict,
  resolveSecureAtomicStatePaths,
  SecureAtomicStateReadError,
  writeSecureAtomicState,
} from "./secure-atomic-state.js";

const STORE_VERSION = 1;
export const MAX_PENDING_DETACHED_CHAT_DRAFTS = 16;
export const MAX_QUARANTINED_DETACHED_CHAT_DRAFT_STATES = 8;
const MAX_STORE_BYTES = 6 * 1024 * 1024;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const QUARANTINE_DIRECTORY = ".detached-chat-draft-recovery";

export interface DetachedChatDraftStoreSnapshot {
  version: 1;
  drafts: PendingDetachedChatDraft[];
}

export type DetachedChatDraftStoreDiagnosticReason =
  | "changed"
  | "invalid-json"
  | "invalid-schema"
  | "missing"
  | "permission"
  | "too-large"
  | "transient-io"
  | "unsafe";

export interface DetachedChatDraftStoreDiagnostic {
  reason: DetachedChatDraftStoreDiagnosticReason;
  outcome: "blocked" | "quarantined" | "recovered";
  evidencePreserved: boolean;
}

export interface DetachedChatDraftStoreOptions {
  onDiagnostic?: (diagnostic: DetachedChatDraftStoreDiagnostic) => void;
}

export interface DetachedChatDraftRecoveryPaths {
  directory: string;
  lastKnownGoodPath: string;
  target: string;
}

type ReadCandidate =
  | { state: "missing" }
  | {
      state: "valid";
      content: string;
      snapshot: DetachedChatDraftStoreSnapshot;
    }
  | {
      state: "damaged" | "unavailable";
      reason: DetachedChatDraftStoreDiagnosticReason;
    };

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Public parsing remains entry-tolerant for callers inspecting untrusted
 * values. Durable loading below is strict so invalid state is preserved rather
 * than silently rewritten as an empty queue.
 */
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

function parseStrictSnapshot(
  value: unknown,
): DetachedChatDraftStoreSnapshot | null {
  if (
    !plainObject(value)
    || Object.keys(value).length !== 2
    || value.version !== STORE_VERSION
    || !Array.isArray(value.drafts)
    || value.drafts.length > MAX_PENDING_DETACHED_CHAT_DRAFTS
  ) return null;
  const drafts = new Map<string, PendingDetachedChatDraft>();
  for (const candidate of value.drafts) {
    const draft = parsePendingDetachedChatDraft(candidate);
    if (!draft || drafts.has(draft.conversationId)) return null;
    drafts.set(draft.conversationId, draft);
  }
  return { version: STORE_VERSION, drafts: [...drafts.values()] };
}

function serialized(snapshot: DetachedChatDraftStoreSnapshot): string {
  return JSON.stringify(snapshot);
}

function readFailureReason(
  error: SecureAtomicStateReadError,
): DetachedChatDraftStoreDiagnosticReason {
  switch (error.code) {
    case "changed": return "changed";
    case "permission": return "permission";
    case "too-large": return "too-large";
    case "unsafe": return "unsafe";
    case "io": return "transient-io";
  }
}

function writeFailureReason(error: unknown): DetachedChatDraftStoreDiagnosticReason {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (
    code === "ELOOP"
    || code === "ENOTDIR"
    || (error instanceof Error && /unsafe|escaped/iu.test(error.message))
  ) return "unsafe";
  return "transient-io";
}

function readCandidate(path: string): ReadCandidate {
  let content: string | null;
  try {
    content = readSecureAtomicStateStrict(path, MAX_STORE_BYTES);
  } catch (error) {
    if (!(error instanceof SecureAtomicStateReadError)) {
      return { state: "unavailable", reason: "transient-io" };
    }
    const reason = readFailureReason(error);
    return {
      state: reason === "too-large" ? "damaged" : "unavailable",
      reason,
    };
  }
  if (content === null) return { state: "missing" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { state: "damaged", reason: "invalid-json" };
  }
  const snapshot = parseStrictSnapshot(parsed);
  if (!snapshot) return { state: "damaged", reason: "invalid-schema" };
  return { state: "valid", content: serialized(snapshot), snapshot };
}

export function detachedChatDraftRecoveryPaths(
  path: string,
): DetachedChatDraftRecoveryPaths {
  const { directory, target } = resolveSecureAtomicStatePaths(path);
  return {
    directory: join(directory, QUARANTINE_DIRECTORY),
    lastKnownGoodPath: join(
      directory,
      `.${basename(target)}.last-known-good`,
    ),
    target,
  };
}

function syncDirectory(path: string): void {
  try {
    const directoryOnly = "O_DIRECTORY" in constants
      ? FILE_OPEN_DIRECTORY
      : 0;
    const descriptor = openSync(path, constants.O_RDONLY | directoryOnly);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // Some platforms do not permit directory fsync; renamed evidence remains.
  }
}

/**
 * Durable queue between an isolated popup and the persistent workbench session.
 * Entries are removed only by an exact main-renderer acknowledgement.
 */
export class DetachedChatDraftStore {
  #entries = new Map<string, PendingDetachedChatDraft>();
  #lastKnownGoodPath: string | null = null;
  #paths: DetachedChatDraftRecoveryPaths | null = null;
  #persistedContent = serialized({ version: STORE_VERSION, drafts: [] });
  #hadPersistedState = false;
  #writeBlocked = false;
  readonly #onDiagnostic: (
    diagnostic: DetachedChatDraftStoreDiagnostic,
  ) => void;

  constructor(
    readonly path: string,
    options: DetachedChatDraftStoreOptions = {},
  ) {
    this.#onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.#initialize();
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

  #emit(diagnostic: DetachedChatDraftStoreDiagnostic): void {
    try {
      this.#onDiagnostic(diagnostic);
    } catch {
      // Diagnostics must not alter draft recovery behavior.
    }
  }

  #block(
    reason: DetachedChatDraftStoreDiagnosticReason,
    evidencePreserved: boolean,
  ): void {
    this.#writeBlocked = true;
    this.#emit({ reason, outcome: "blocked", evidencePreserved });
  }

  #load(snapshot: DetachedChatDraftStoreSnapshot): void {
    this.#entries.clear();
    for (const draft of snapshot.drafts) {
      this.#entries.set(draft.conversationId, draft);
    }
    this.#persistedContent = serialized(snapshot);
    this.#hadPersistedState = true;
  }

  #initialize(): void {
    let paths: DetachedChatDraftRecoveryPaths;
    try {
      paths = detachedChatDraftRecoveryPaths(this.path);
    } catch (error) {
      this.#block(writeFailureReason(error), true);
      return;
    }
    this.#paths = paths;
    this.#lastKnownGoodPath = paths.lastKnownGoodPath;
    const primary = readCandidate(paths.target);
    if (primary.state === "valid") {
      this.#load(primary.snapshot);
      this.#refreshLastKnownGood(primary.content);
      return;
    }
    if (primary.state === "unavailable") {
      this.#block(primary.reason, true);
      return;
    }
    if (primary.state === "damaged") {
      if (!this.#quarantine(paths.target, "primary", primary.reason)) return;
    }

    const backup = readCandidate(paths.lastKnownGoodPath);
    if (backup.state === "valid") {
      this.#load(backup.snapshot);
      try {
        writeSecureAtomicState(paths.target, backup.content, MAX_STORE_BYTES);
        if (primary.state === "damaged" || this.#hadPersistedState) {
          this.#emit({
            reason: primary.state === "missing" ? "missing" : primary.reason,
            outcome: "recovered",
            evidencePreserved: true,
          });
        }
      } catch (error) {
        this.#block(writeFailureReason(error), true);
      }
      return;
    }
    if (backup.state === "unavailable") {
      this.#block(backup.reason, primary.state === "damaged");
      return;
    }
    if (backup.state === "damaged") {
      if (!this.#quarantine(
        paths.lastKnownGoodPath,
        "last-known-good",
        backup.reason,
      )) return;
    }
  }

  #refreshLastKnownGood(content: string): void {
    const path = this.#lastKnownGoodPath;
    if (!path) return;
    const current = readCandidate(path);
    if (current.state === "unavailable") {
      this.#block(current.reason, true);
      return;
    }
    if (
      current.state === "valid"
      && current.content !== content
      && !this.#quarantine(path, "last-known-good", "changed")
    ) return;
    if (
      current.state === "damaged"
      && !this.#quarantine(path, "last-known-good", current.reason)
    ) return;
    try {
      writeSecureAtomicState(path, content, MAX_STORE_BYTES);
    } catch (error) {
      this.#block(writeFailureReason(error), true);
    }
  }

  #quarantine(
    source: string,
    label: "last-known-good" | "primary",
    reason: DetachedChatDraftStoreDiagnosticReason,
  ): boolean {
    const paths = this.#paths;
    if (!paths) {
      this.#block("transient-io", true);
      return false;
    }
    try {
      mkdirSync(paths.directory, { recursive: true, mode: DIRECTORY_MODE });
      const recoveryDirectory = lstatSync(paths.directory);
      if (!recoveryDirectory.isDirectory() || recoveryDirectory.isSymbolicLink()) {
        this.#block("unsafe", true);
        return false;
      }
      chmodSync(paths.directory, DIRECTORY_MODE);
      const names = readdirSync(paths.directory);
      if (names.length >= MAX_QUARANTINED_DETACHED_CHAT_DRAFT_STATES) {
        this.#block("transient-io", true);
        return false;
      }
      const metadata = lstatSync(source);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        this.#block("unsafe", true);
        return false;
      }
      const destination = join(
        paths.directory,
        `detached-chat-draft-${label}-${randomUUID()}.damaged`,
      );
      renameSync(source, destination);
      chmodSync(destination, FILE_MODE);
      syncDirectory(paths.directory);
      syncDirectory(resolveSecureAtomicStatePaths(paths.target).directory);
      this.#emit({ reason, outcome: "quarantined", evidencePreserved: true });
      return true;
    } catch (error) {
      this.#block(writeFailureReason(error), true);
      return false;
    }
  }

  #ensureWritableState(): void {
    const target = this.#paths?.target;
    if (this.#writeBlocked || !this.#lastKnownGoodPath || !target) {
      throw new Error("Detached chat draft persistence is unavailable");
    }
    const primary = readCandidate(target);
    if (primary.state === "unavailable") {
      this.#block(primary.reason, true);
      throw new Error("Detached chat draft persistence is unavailable");
    }
    if (primary.state === "valid" && primary.content !== this.#persistedContent) {
      this.#block("changed", true);
      throw new Error("Detached chat draft persistence is unavailable");
    }
    if (primary.state === "damaged") {
      if (!this.#quarantine(target, "primary", primary.reason)) {
        throw new Error("Detached chat draft persistence is unavailable");
      }
    }
    if (primary.state === "missing" || primary.state === "damaged") {
      try {
        writeSecureAtomicState(
          target,
          this.#persistedContent,
          MAX_STORE_BYTES,
        );
        if (primary.state === "damaged" || this.#hadPersistedState) {
          this.#emit({
            reason: primary.state === "missing" ? "missing" : primary.reason,
            outcome: "recovered",
            evidencePreserved: true,
          });
        }
      } catch (error) {
        this.#block(writeFailureReason(error), true);
        throw new Error("Detached chat draft persistence is unavailable");
      }
    }
    const backup = readCandidate(this.#lastKnownGoodPath);
    if (backup.state === "unavailable") {
      this.#block(backup.reason, true);
      throw new Error("Detached chat draft persistence is unavailable");
    }
    if (backup.state === "valid" && backup.content !== this.#persistedContent) {
      this.#block("changed", true);
      throw new Error("Detached chat draft persistence is unavailable");
    }
    if (
      backup.state === "damaged"
      && !this.#quarantine(
        this.#lastKnownGoodPath,
        "last-known-good",
        backup.reason,
      )
    ) throw new Error("Detached chat draft persistence is unavailable");
  }

  #flush(): void {
    this.#ensureWritableState();
    const lastKnownGoodPath = this.#lastKnownGoodPath;
    const target = this.#paths?.target;
    if (!lastKnownGoodPath || !target) {
      throw new Error("Detached chat draft persistence is unavailable");
    }
    const snapshot: DetachedChatDraftStoreSnapshot = {
      version: STORE_VERSION,
      drafts: this.snapshot(),
    };
    const content = serialized(snapshot);
    try {
      writeSecureAtomicState(target, content, MAX_STORE_BYTES);
      this.#persistedContent = content;
      this.#hadPersistedState = true;
    } catch (error) {
      this.#block(writeFailureReason(error), true);
      throw error;
    }
    try {
      writeSecureAtomicState(lastKnownGoodPath, content, MAX_STORE_BYTES);
    } catch (error) {
      // The primary commit is authoritative. Keep the matching in-memory state,
      // block subsequent writes, and let restart repair the recovery copy.
      this.#block(writeFailureReason(error), true);
    }
  }
}
