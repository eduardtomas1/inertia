import type { open } from "node:fs/promises";

import type { SecureFileRequest } from "../node/secure-file-protocol.js";
import {
  openVerifiedFile,
  SecureFileOperationError,
  snapshotNamedFile,
} from "./secure-file-io.js";
import {
  matchesSnapshot,
  type SaveJournal,
} from "./secure-file-journal.js";

export interface SecureFileTransactionHooks {
  beforeClaim?(): Promise<void> | void;
  beforeClaimRename?(): Promise<void> | void;
  afterClaim?(): Promise<void> | void;
  writeStaged?(
    handle: Awaited<ReturnType<typeof open>>,
    content: Buffer,
  ): Promise<void>;
  writeJournalPending?(
    handle: Awaited<ReturnType<typeof open>>,
    content: Buffer,
  ): Promise<void>;
  beforeJournalPublish?(
    pendingName: string,
    journalName: string,
  ): Promise<void> | void;
  beforeQuarantine?(name: string): Promise<void> | void;
  afterQuarantine?(
    name: string,
    quarantineName: string,
  ): Promise<void> | void;
  beforeInstallLink?(): Promise<void> | void;
  afterInstall?(): Promise<void> | void;
  stopAfter?:
    | "journal-pending"
    | "journal-published"
    | "claim-quarantine"
    | "rollback-target-quarantine"
    | "claim"
    | "stage-quarantine"
    | "install"
    | "journal-quarantine";
  onCommitPhase?(phase: "started" | "finished"): void;
}

export class SimulatedWorkerTermination extends Error {}

export function hooksWithQuarantineStop(
  hooks: SecureFileTransactionHooks,
  name: string,
  stopAfter:
    | "claim-quarantine"
    | "rollback-target-quarantine"
    | "stage-quarantine"
    | "journal-quarantine",
): SecureFileTransactionHooks {
  if (hooks.stopAfter !== stopAfter) return hooks;
  return {
    ...hooks,
    afterQuarantine: async (quarantinedName, quarantine) => {
      await hooks.afterQuarantine?.(quarantinedName, quarantine);
      if (quarantinedName === name) throw new SimulatedWorkerTermination();
    },
  };
}

export async function assertExpectedTarget(
  request: Extract<SecureFileRequest, { operation: "replace" }>,
  basename: string,
): Promise<void> {
  const current = await openVerifiedFile(
    basename,
    request.maxBytes,
    request.targetIdentity,
  );
  try {
    if (
      current.metadata.digest !== request.expectedDigest
      || current.metadata.mode !== request.expectedMode
    ) {
      throw new SecureFileOperationError(
        "conflict",
        "The selected file changed before it was saved.",
      );
    }
    if (current.linkCount !== 1) {
      throw new SecureFileOperationError(
        "unsafe",
        "Files with multiple hard links cannot be replaced safely.",
      );
    }
  } finally {
    await current.handle.close();
  }
}

export async function assertVerifiedStage(
  name: string,
  journal: SaveJournal,
): Promise<void> {
  const stage = await snapshotNamedFile(name, journal.maxBytes);
  if (
    !matchesSnapshot(
      stage,
      journal.replacementIdentity,
      journal.replacementDigest,
      journal.replacementMode,
    )
    || stage.linkCount !== 1
  ) {
    throw new SecureFileOperationError(
      "unsafe",
      "The staged secure save changed or gained another hard link.",
    );
  }
}
