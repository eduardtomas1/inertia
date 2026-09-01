import { createHash } from "node:crypto";

import {
  createDirectRuntimeJournalChildRoot,
  directRuntimeJournalRootIsPinned,
  discardDirectRuntimeJournalLeaf,
  listDirectRuntimeJournalLeaves,
  pinDirectRuntimeJournalChildRoot,
  readDirectRuntimeJournalLeaf,
  removeDirectRuntimeJournalChildRoot,
  renameDirectRuntimeJournalChildRoot,
  renameDirectRuntimeJournalLeaf,
  writeDirectRuntimeJournalLeaf,
  type DirectRuntimeJournalIdentity,
  type DirectRuntimeJournalLeaf,
  type DirectRuntimeJournalRoot,
} from "./direct-runtime-journal.js";
import {
  validRuntimeGenerationId,
  validSystemBootId,
} from "./runtime-process-protocol.js";

export const RUNTIME_OWNED_PROCESS_SESSION_VERSION = 1 as const;
const SESSION_PREFIX = ".runtime-owned-process-session-";
const WRITER_PREFIX = ".runtime-owned-process-writer-";
const MAX_SESSIONS = 32;
const MAX_SESSION_BYTES = 768;

export interface RuntimeOwnedProcessSession {
  readonly version: typeof RUNTIME_OWNED_PROCESS_SESSION_VERSION;
  readonly runtimeGenerationId: string;
  readonly systemBootId: string;
}

export interface RuntimeOwnedProcessSessionCapability {
  readonly session: RuntimeOwnedProcessSession;
  readonly identity: DirectRuntimeJournalIdentity;
  readonly writerRoot: DirectRuntimeJournalRoot;
}

export interface StoredRuntimeOwnedProcessSessionLeaf {
  readonly session: RuntimeOwnedProcessSession;
  readonly state: "active" | "retiring";
  readonly identity: DirectRuntimeJournalIdentity;
  readonly writerRoot: DirectRuntimeJournalRoot | null;
}

function generationHash(runtimeGenerationId: string): string {
  return createHash("sha256").update(runtimeGenerationId).digest("hex");
}

export function runtimeOwnedProcessSessionName(
  runtimeGenerationId: string,
): string {
  return `${SESSION_PREFIX}${generationHash(runtimeGenerationId)}.json`;
}

export function runtimeOwnedProcessRetiringSessionName(
  runtimeGenerationId: string,
): string {
  return `${SESSION_PREFIX}${generationHash(runtimeGenerationId)}.retire.tmp`;
}

export function runtimeOwnedProcessWriterName(
  runtimeGenerationId: string,
): string {
  return `${WRITER_PREFIX}${generationHash(runtimeGenerationId)}.active`;
}

export function runtimeOwnedProcessRetiringWriterName(
  runtimeGenerationId: string,
): string {
  return `${WRITER_PREFIX}${generationHash(runtimeGenerationId)}.retire`;
}

function parseSession(bytes: Buffer): RuntimeOwnedProcessSession | null {
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object") return null;
    const keys = Object.keys(value).sort();
    if (keys.join("|") !== "runtimeGenerationId|systemBootId|version") return null;
    const session = value as Partial<RuntimeOwnedProcessSession>;
    return session.version === RUNTIME_OWNED_PROCESS_SESSION_VERSION
      && validRuntimeGenerationId(session.runtimeGenerationId)
      && validSystemBootId(session.systemBootId)
      ? session as RuntimeOwnedProcessSession
      : null;
  } catch {
    return null;
  }
}

function sameSession(
  left: RuntimeOwnedProcessSession,
  right: RuntimeOwnedProcessSession,
): boolean {
  return left.version === right.version
    && left.runtimeGenerationId === right.runtimeGenerationId
    && left.systemBootId === right.systemBootId;
}

export class RuntimeOwnedProcessSessionJournal {
  constructor(private readonly root: DirectRuntimeJournalRoot) {}

  private readAll(
    repairCrashPrefixes: boolean,
  ): StoredRuntimeOwnedProcessSessionLeaf[] {
    const names = listDirectRuntimeJournalLeaves(
      this.root,
      SESSION_PREFIX,
      MAX_SESSIONS * 2,
    );
    const sessions: StoredRuntimeOwnedProcessSessionLeaf[] = [];
    const boundWriterNames = new Set<string>();
    for (const name of names) {
      const match = name.match(
        /^\.runtime-owned-process-session-([0-9a-f]{64})\.(?:(json)|(publish|retire)\.tmp)$/u,
      );
      if (!match) throw new Error("Runtime process ownership storage is invalid.");
      if (match[3] === "publish") {
        if (
          !repairCrashPrefixes
          || !discardDirectRuntimeJournalLeaf(this.root, name)
        ) {
          throw new Error("Runtime process ownership storage could not be repaired.");
        }
        continue;
      }
      const leaf = readDirectRuntimeJournalLeaf(
        this.root,
        name,
        MAX_SESSION_BYTES,
      );
      const session = leaf && parseSession(leaf.bytes);
      if (!session || generationHash(session.runtimeGenerationId) !== match[1]) {
        throw new Error("Runtime process ownership storage is invalid.");
      }
      const activeWriter = pinDirectRuntimeJournalChildRoot(
        this.root,
        runtimeOwnedProcessWriterName(session.runtimeGenerationId),
      );
      const retiringWriter = pinDirectRuntimeJournalChildRoot(
        this.root,
        runtimeOwnedProcessRetiringWriterName(session.runtimeGenerationId),
      );
      const fileRetiring = match[3] === "retire";
      if (
        (activeWriter && retiringWriter)
        || (!fileRetiring && !activeWriter && !retiringWriter)
        || (fileRetiring && activeWriter)
      ) throw new Error("Runtime process ownership writer storage conflicts.");
      if (retiringWriter) {
        boundWriterNames.add(runtimeOwnedProcessRetiringWriterName(
          session.runtimeGenerationId,
        ));
      } else if (activeWriter) {
        boundWriterNames.add(runtimeOwnedProcessWriterName(
          session.runtimeGenerationId,
        ));
      }
      sessions.push({
        session,
        state: fileRetiring || retiringWriter ? "retiring" : "active",
        identity: leaf.identity,
        writerRoot: retiringWriter ?? activeWriter,
      });
    }
    if (sessions.length > MAX_SESSIONS) {
      throw new Error("The runtime process ownership session bound was exceeded.");
    }
    if (new Set(sessions.map(({ session }) => session.runtimeGenerationId)).size
      !== sessions.length) {
      throw new Error("Runtime process ownership session storage conflicts.");
    }
    const writerNames = listDirectRuntimeJournalLeaves(
      this.root,
      WRITER_PREFIX,
      MAX_SESSIONS * 2,
    );
    for (const name of writerNames) {
      const match = name.match(
        /^\.runtime-owned-process-writer-([0-9a-f]{64})\.(active|retire)$/u,
      );
      if (!match) {
        throw new Error("Runtime process ownership writer storage is invalid.");
      }
      if (boundWriterNames.has(name)) continue;
      const writerRoot = pinDirectRuntimeJournalChildRoot(this.root, name);
      if (
        !repairCrashPrefixes
        || !writerRoot
        || match[2] !== "active"
      ) {
        throw new Error("Runtime process ownership writer storage is unbound.");
      }
      // start() cannot return a capability until the canonical session leaf
      // exists. An empty active writer without that leaf is therefore the
      // exact crash prefix between mkdir/fsync and session publication. It is
      // safe to remove by pinned identity; a non-empty or retiring orphan is
      // never inferred and remains fail-closed.
      if (!removeDirectRuntimeJournalChildRoot(
        this.root,
        name,
        writerRoot,
      )) {
        throw new Error("Runtime process ownership writer storage is unbound.");
      }
    }
    return sessions;
  }

  all(): StoredRuntimeOwnedProcessSessionLeaf[] {
    return this.readAll(false);
  }

  repairCrashPrefixes(): boolean {
    try {
      this.readAll(true);
      return true;
    } catch {
      return false;
    }
  }

  start(runtimeGenerationId: string, systemBootId: string): boolean {
    if (
      !validRuntimeGenerationId(runtimeGenerationId)
      || !validSystemBootId(systemBootId)
    ) return false;
    const sessions = this.all();
    const existing = sessions.find(({ session }) =>
      session.runtimeGenerationId === runtimeGenerationId);
    if (existing) {
      return existing.state === "active"
        && existing.session.systemBootId === systemBootId
        && existing.writerRoot !== null;
    }
    if (
      sessions.length >= MAX_SESSIONS
      || pinDirectRuntimeJournalChildRoot(
        this.root,
        runtimeOwnedProcessRetiringWriterName(runtimeGenerationId),
      )
    ) return false;
    const writerRoot = createDirectRuntimeJournalChildRoot(
      this.root,
      runtimeOwnedProcessWriterName(runtimeGenerationId),
    );
    if (
      !writerRoot
      || listDirectRuntimeJournalLeaves(
        writerRoot,
        ".runtime-owned-",
        1,
      ).length > 0
    ) return false;
    const temporaryName =
      `${SESSION_PREFIX}${generationHash(runtimeGenerationId)}.publish.tmp`;
    const canonicalName = runtimeOwnedProcessSessionName(runtimeGenerationId);
    const published = writeDirectRuntimeJournalLeaf(
      this.root,
      temporaryName,
      canonicalName,
      Buffer.from(JSON.stringify({
        version: RUNTIME_OWNED_PROCESS_SESSION_VERSION,
        runtimeGenerationId,
        systemBootId,
      }), "utf8"),
    );
    if (published) return true;
    // A failed durability confirmation may still have committed the canonical
    // leaf. Preserve that exact state for normal finish/recovery. If no
    // canonical exists, this caller never acquired a capability, so it can
    // finish only its own transient and exact empty writer prefix.
    const committed = readDirectRuntimeJournalLeaf(
      this.root,
      canonicalName,
      MAX_SESSION_BYTES,
    );
    if (committed) return false;
    const temporary = readDirectRuntimeJournalLeaf(
      this.root,
      temporaryName,
      MAX_SESSION_BYTES,
    );
    if (
      temporary
      && !discardDirectRuntimeJournalLeaf(this.root, temporaryName)
    ) return false;
    removeDirectRuntimeJournalChildRoot(
      this.root,
      runtimeOwnedProcessWriterName(runtimeGenerationId),
      writerRoot,
    );
    return false;
  }

  exact(runtimeGenerationId: string): RuntimeOwnedProcessSession | null | undefined {
    if (!validRuntimeGenerationId(runtimeGenerationId)) return undefined;
    try {
      return this.all().find(({ session }) =>
        session.runtimeGenerationId === runtimeGenerationId)?.session ?? null;
    } catch {
      return undefined;
    }
  }

  capability(
    runtimeGenerationId: string,
    systemBootId: string,
  ): RuntimeOwnedProcessSessionCapability | null {
    try {
      const entry = this.all().find(({ session }) =>
        session.runtimeGenerationId === runtimeGenerationId);
      return entry?.state === "active"
        && entry.session.systemBootId === systemBootId
        && entry.writerRoot
        ? {
            session: entry.session,
            identity: entry.identity,
            writerRoot: entry.writerRoot,
          }
        : null;
    } catch {
      return null;
    }
  }

  capabilityCurrent(capability: RuntimeOwnedProcessSessionCapability): boolean {
    const current = readDirectRuntimeJournalLeaf(
      this.root,
      runtimeOwnedProcessSessionName(capability.session.runtimeGenerationId),
      MAX_SESSION_BYTES,
    );
    const session = current && parseSession(current.bytes);
    const writerRoot = pinDirectRuntimeJournalChildRoot(
      this.root,
      runtimeOwnedProcessWriterName(capability.session.runtimeGenerationId),
    );
    return !!current
      && !!session
      && !!writerRoot
      && directRuntimeJournalRootIsPinned(capability.writerRoot)
      && current.identity.device === capability.identity.device
      && current.identity.inode === capability.identity.inode
      && writerRoot.device === capability.writerRoot.device
      && writerRoot.inode === capability.writerRoot.inode
      && sameSession(session, capability.session);
  }

  fence(expected: RuntimeOwnedProcessSession): boolean {
    const activeName = runtimeOwnedProcessSessionName(expected.runtimeGenerationId);
    const retiringName = runtimeOwnedProcessRetiringSessionName(
      expected.runtimeGenerationId,
    );
    const retiring = readDirectRuntimeJournalLeaf(
      this.root,
      retiringName,
      MAX_SESSION_BYTES,
    );
    if (retiring) {
      const parsed = parseSession(retiring.bytes);
      return !!parsed
        && sameSession(parsed, expected)
        && !pinDirectRuntimeJournalChildRoot(
          this.root,
          runtimeOwnedProcessWriterName(expected.runtimeGenerationId),
        )
        && !readDirectRuntimeJournalLeaf(
          this.root,
          activeName,
          MAX_SESSION_BYTES,
        );
    }
    const active = readDirectRuntimeJournalLeaf(
      this.root,
      activeName,
      MAX_SESSION_BYTES,
    );
    const parsed = active && parseSession(active.bytes);
    if (!active || !parsed || !sameSession(parsed, expected)) return false;
    const activeWriterName = runtimeOwnedProcessWriterName(
      expected.runtimeGenerationId,
    );
    const retiredWriterName = runtimeOwnedProcessRetiringWriterName(
      expected.runtimeGenerationId,
    );
    let retiredWriter = pinDirectRuntimeJournalChildRoot(
      this.root,
      retiredWriterName,
    );
    if (!retiredWriter) {
      const activeWriter = pinDirectRuntimeJournalChildRoot(
        this.root,
        activeWriterName,
      );
      if (!activeWriter) return false;
      retiredWriter = renameDirectRuntimeJournalChildRoot(
        this.root,
        activeWriterName,
        retiredWriterName,
        activeWriter,
      );
      if (!retiredWriter) return false;
    }
    return renameDirectRuntimeJournalLeaf(
      this.root,
      activeName,
      retiringName,
      active.identity,
    );
  }

  retiredLeaf(expected: RuntimeOwnedProcessSession): DirectRuntimeJournalLeaf | null {
    const leaf = readDirectRuntimeJournalLeaf(
      this.root,
      runtimeOwnedProcessRetiringSessionName(expected.runtimeGenerationId),
      MAX_SESSION_BYTES,
    );
    const session = leaf && parseSession(leaf.bytes);
    return leaf && session && sameSession(session, expected) ? leaf : null;
  }
}
