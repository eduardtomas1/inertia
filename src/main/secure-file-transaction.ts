import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  open,
  readdir,
} from "node:fs/promises";

import { FILE_OPEN_NO_FOLLOW } from
  "../node/platform-file-open-flags.js";
import type {
  SecureFileIdentity,
  SecureFileRequest,
  SecureFileResult,
} from "../node/secure-file-protocol.js";
import {
  digest,
  errorCode,
  identity,
  openVerifiedFile,
  sameIdentity,
  SecureFileOperationError,
  snapshotNamedFile,
  writeComplete,
} from "./secure-file-io.js";
import {
  quarantineExact,
  removeExact,
  syncCurrentDirectory,
} from "./secure-file-cleanup.js";
import { claimSecureFileTarget } from "./secure-file-claim.js";
import {
  JOURNAL_SUFFIX,
  matchesSnapshot,
  MAX_JOURNAL_BYTES,
  parseJournal,
  parsePendingJournal,
  quarantineName,
  readJournal,
  recoverPendingJournal,
  restoreQuarantinedFile,
  restoreTransactionQuarantines,
  TRANSACTION_PREFIX,
  type SaveJournal,
} from "./secure-file-journal.js";
import {
  assertExpectedTarget,
  assertVerifiedStage,
  hooksWithQuarantineStop,
  SimulatedWorkerTermination,
  type SecureFileTransactionHooks,
} from "./secure-file-transaction-support.js";

export type {
  SecureFileTransactionHooks,
} from "./secure-file-transaction-support.js";

const PENDING_SUFFIX = ".pending";
const MAX_JOURNALS_PER_PARENT = 32;

async function reconcileJournal(
  journalName: string,
  basename: string,
  expectedJournalIdentity?: SecureFileIdentity,
  hooks?: SecureFileTransactionHooks,
): Promise<void> {
  const loaded = await readJournal(journalName, expectedJournalIdentity);
  const { journal } = loaded;
  if (journal.target !== basename) return;
  await restoreTransactionQuarantines(journalName, journal);

  let target = await snapshotNamedFile(journal.target, journal.maxBytes);
  const stage = await snapshotNamedFile(journal.stage, journal.maxBytes);
  const backup = await snapshotNamedFile(journal.backup, journal.maxBytes);
  const backupIsExpected = Boolean(
    backup
    && matchesSnapshot(
      backup,
      journal.expectedIdentity,
      journal.expectedDigest,
      journal.expectedMode,
    ),
  );
  const targetIsExistingBackup = Boolean(
    target
    && backup
    && sameIdentity(target.fileIdentity, backup.fileIdentity),
  );
  if (
    backup
    && (
      !backupIsExpected
      || (
        backup.linkCount !== 1
        && !(backup.linkCount === 2 && targetIsExistingBackup)
      )
    )
  ) {
    throw new SecureFileOperationError(
      "unsafe",
      "A secure save recovery copy was replaced or linked unexpectedly.",
    );
  }
  const stageIsReplacement = !stage || matchesSnapshot(
    stage,
    journal.replacementIdentity,
    journal.replacementDigest,
    journal.replacementMode,
  );
  const targetIsExistingStage = Boolean(
    target
    && stage
    && sameIdentity(target.fileIdentity, stage.fileIdentity),
  );
  const stageHasExpectedLinks = !(
    stage
    && stageIsReplacement
    && (
      stage.linkCount !== 1
      && !(stage.linkCount === 2 && targetIsExistingStage)
    )
  );
  if (!stageIsReplacement) {
    await rollBackJournal(
      journalName,
      basename,
      expectedJournalIdentity,
      hooks,
    );
    return;
  }

  if (!backup) {
    if (!target) {
      throw new SecureFileOperationError(
        "unsafe",
        "A secure save is missing both its target and recovery copy.",
      );
    }
  } else if (!target) {
    if (!backupIsExpected || backup.linkCount !== 1) {
      throw new SecureFileOperationError(
        "unsafe",
        "A secure save recovery copy is unsafe.",
      );
    }
    try {
      await link(journal.backup, journal.target);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    await syncCurrentDirectory();
    target = await snapshotNamedFile(journal.target, journal.maxBytes);
    if (
      !matchesSnapshot(
        target,
        journal.expectedIdentity,
        journal.expectedDigest,
        journal.expectedMode,
      )
      || !sameIdentity(target.fileIdentity, backup.fileIdentity)
      || target.linkCount !== 2
    ) {
      throw new SecureFileOperationError(
        "unsafe",
        "A concurrent file prevented secure save recovery.",
      );
    }
  }

  const targetIsExpected = matchesSnapshot(
    target,
    journal.expectedIdentity,
    journal.expectedDigest,
    journal.expectedMode,
  );
  const targetIsReplacement = matchesSnapshot(
    target,
    journal.replacementIdentity,
    journal.replacementDigest,
    journal.replacementMode,
  );
  const targetIsBackup = Boolean(
    target
    && backup
    && sameIdentity(target.fileIdentity, backup.fileIdentity),
  );
  if (!targetIsExpected && !targetIsReplacement && !targetIsBackup) {
    throw new SecureFileOperationError(
      "conflict",
      "A concurrent file is present while a secure save awaits recovery.",
    );
  }
  if (!stageHasExpectedLinks) {
    throw new SecureFileOperationError(
      "unsafe",
      "The staged secure save was linked unexpectedly during recovery.",
    );
  }

  if (stage && stageIsReplacement) {
    await removeExact(
      journal.stage,
      stage.fileIdentity,
      hooksWithQuarantineStop(
        hooks ?? {},
        journal.stage,
        "stage-quarantine",
      ),
      quarantineName(journal, "stage"),
    );
  }
  if (targetIsReplacement) {
    target = await snapshotNamedFile(journal.target, journal.maxBytes);
    if (
      !matchesSnapshot(
        target,
        journal.replacementIdentity,
        journal.replacementDigest,
        journal.replacementMode,
      )
      || target.linkCount !== 1
    ) {
      throw new SecureFileOperationError(
        "unsafe",
        "The installed secure save unexpectedly has another hard link.",
      );
    }
  }
  if (backup) {
    await removeExact(
      journal.backup,
      backup.fileIdentity,
      hooks,
      quarantineName(journal, "backup"),
    );
  }
  await removeExact(
    journalName,
    loaded.identity,
    hooksWithQuarantineStop(
      hooks ?? {},
      journalName,
      "journal-quarantine",
    ),
    quarantineName(journal, "journal"),
  );
  await syncCurrentDirectory();
}

async function rollBackJournal(
  journalName: string,
  basename: string,
  expectedJournalIdentity?: SecureFileIdentity,
  hooks?: SecureFileTransactionHooks,
): Promise<void> {
  const loaded = await readJournal(journalName, expectedJournalIdentity);
  const { journal } = loaded;
  if (journal.target !== basename) return;
  await restoreTransactionQuarantines(journalName, journal);
  let target = await snapshotNamedFile(journal.target, journal.maxBytes);
  const stage = await snapshotNamedFile(journal.stage, journal.maxBytes);
  const backup = await snapshotNamedFile(journal.backup, journal.maxBytes);
  const rollbackTargetName = quarantineName(journal, "rollback-target");
  let rollbackTarget = await snapshotNamedFile(
    rollbackTargetName,
    journal.maxBytes,
  );
  const stageIsReplacement = !stage || matchesSnapshot(
    stage,
    journal.replacementIdentity,
    journal.replacementDigest,
    journal.replacementMode,
  );
  const targetIsExistingStage = Boolean(
    target
    && stage
    && sameIdentity(target.fileIdentity, stage.fileIdentity),
  );
  const stageHasExpectedLinks = !(
    stage
    && stageIsReplacement
    && (
      stage.linkCount !== 1
      && !(
        stage.linkCount === 2
        && (
          targetIsExistingStage
          || Boolean(
            rollbackTarget
            && sameIdentity(
              stage.fileIdentity,
              rollbackTarget.fileIdentity,
            )
          )
        )
      )
    )
  );
  if (
    !backup
    || !matchesSnapshot(
      backup,
      journal.expectedIdentity,
      journal.expectedDigest,
      journal.expectedMode,
    )
    || (
      backup.linkCount !== 1
      && !(
        backup.linkCount === 2
        && target
        && sameIdentity(target.fileIdentity, backup.fileIdentity)
      )
    )
  ) {
    throw new SecureFileOperationError(
      "unsafe",
      "The claimed file could not be verified for secure save rollback.",
    );
  }
  if (
    rollbackTarget
    && (
      !(
        matchesSnapshot(
          rollbackTarget,
          journal.replacementIdentity,
          journal.replacementDigest,
          journal.replacementMode,
        )
        || (
          stage
          && !stageIsReplacement
          && sameIdentity(
            rollbackTarget.fileIdentity,
            stage.fileIdentity,
          )
        )
      )
      || (
        rollbackTarget.linkCount !== 1
        && !(
          rollbackTarget.linkCount === 2
          && stage
          && sameIdentity(
            rollbackTarget.fileIdentity,
            stage.fileIdentity,
          )
        )
      )
    )
  ) {
    throw new SecureFileOperationError(
      "unsafe",
      "The rollback replacement quarantine could not be verified.",
    );
  }
  if (
    !rollbackTarget
    &&
    target
    && (
      matchesSnapshot(
        target,
        journal.replacementIdentity,
        journal.replacementDigest,
        journal.replacementMode,
      )
      || (
        stage
        && !stageIsReplacement
        && sameIdentity(target.fileIdentity, stage.fileIdentity)
      )
    )
  ) {
    await quarantineExact(
      journal.target,
      target.fileIdentity,
      hooksWithQuarantineStop(
        hooks ?? {},
        journal.target,
        "rollback-target-quarantine",
      ),
      rollbackTargetName,
    );
    rollbackTarget = await snapshotNamedFile(
      rollbackTargetName,
      journal.maxBytes,
    );
    if (!rollbackTarget) {
      throw new SecureFileOperationError(
        "unsafe",
        "The rollback replacement quarantine disappeared.",
      );
    }
    target = null;
  }
  if (rollbackTarget && target) {
    const targetIsExpected = matchesSnapshot(
      target,
      journal.expectedIdentity,
      journal.expectedDigest,
      journal.expectedMode,
    );
    if (!targetIsExpected) {
      throw new SecureFileOperationError(
        "conflict",
        "A concurrent file prevents secure save rollback.",
      );
    }
  }
  if (!target) {
    try {
      await link(journal.backup, journal.target);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    await syncCurrentDirectory();
    target = await snapshotNamedFile(journal.target, journal.maxBytes);
  }
  if (
    !matchesSnapshot(
      target,
      journal.expectedIdentity,
      journal.expectedDigest,
      journal.expectedMode,
    )
    || !sameIdentity(target.fileIdentity, backup.fileIdentity)
    || target.linkCount !== 2
  ) {
    throw new SecureFileOperationError(
      "conflict",
      "A concurrent file prevented secure save rollback.",
    );
  }
  if (rollbackTarget) {
    await removeExact(
      rollbackTargetName,
      rollbackTarget.fileIdentity,
      hooks,
      `${rollbackTargetName}.discard`,
    );
  }
  if (stage && stageIsReplacement) {
    await removeExact(
      journal.stage,
      stage.fileIdentity,
      hooksWithQuarantineStop(
        hooks ?? {},
        journal.stage,
        "stage-quarantine",
      ),
      quarantineName(journal, "stage"),
    );
  }
  await removeExact(
    journal.backup,
    backup.fileIdentity,
    hooks,
    quarantineName(journal, "backup"),
  );
  await removeExact(
    journalName,
    loaded.identity,
    hooksWithQuarantineStop(
      hooks ?? {},
      journalName,
      "journal-quarantine",
    ),
    quarantineName(journal, "journal"),
  );
  await syncCurrentDirectory();
  if (!stageHasExpectedLinks) {
    throw new SecureFileOperationError(
      "unsafe",
      "The staged secure save was linked unexpectedly during rollback.",
    );
  }
}

export async function recoverSecureFileTransactions(
  basename: string,
): Promise<void> {
  let entries = await readdir(".", { withFileTypes: true });
  const publishedQuarantines = entries
    .filter((entry) => (
      entry.isFile()
      && entry.name.startsWith(TRANSACTION_PREFIX)
      && (
        entry.name.endsWith(`${JOURNAL_SUFFIX}.quarantine`)
        || entry.name.endsWith(`${PENDING_SUFFIX}.quarantine`)
      )
    ))
    .map((entry) => entry.name)
    .sort();
  if (publishedQuarantines.length > MAX_JOURNALS_PER_PARENT * 2) {
    throw new SecureFileOperationError(
      "unsafe",
      "Too many secure save quarantines require recovery.",
    );
  }
  for (const quarantinedName of publishedQuarantines) {
    const name = quarantinedName.slice(0, -".quarantine".length);
    const isJournal = name.endsWith(JOURNAL_SUFFIX);
    await restoreQuarantinedFile(
      name,
      quarantinedName,
      (snapshot) => Boolean(
        snapshot.content
        && (
          isJournal
            ? parseJournal(snapshot.content.toString("utf8"), name)
            : parsePendingJournal(snapshot.content.toString("utf8"))
        )
      ),
    );
  }
  entries = await readdir(".", { withFileTypes: true });
  const pendingNames = entries
    .filter((entry) => (
      entry.isFile()
      && entry.name.startsWith(TRANSACTION_PREFIX)
      && entry.name.endsWith(PENDING_SUFFIX)
    ))
    .map((entry) => entry.name)
    .sort()
    .slice(0, MAX_JOURNALS_PER_PARENT);
  for (const pendingName of pendingNames) {
    await recoverPendingJournal(pendingName, basename);
  }
  const journalNames = entries
    .filter((entry) => (
      entry.isFile()
      && entry.name.startsWith(TRANSACTION_PREFIX)
      && entry.name.endsWith(JOURNAL_SUFFIX)
    ))
    .map((entry) => entry.name)
    .sort();
  if (journalNames.length > MAX_JOURNALS_PER_PARENT) {
    throw new SecureFileOperationError(
      "unsafe",
      "Too many secure save journals require recovery.",
    );
  }
  for (const journalName of journalNames) {
    const { journal } = await readJournal(journalName);
    if (journal.target === basename) {
      await restoreTransactionQuarantines(journalName, journal);
      const rollbackTarget = await snapshotNamedFile(
        quarantineName(journal, "rollback-target"),
        journal.maxBytes,
      );
      if (rollbackTarget) {
        await rollBackJournal(journalName, basename);
      } else {
        await reconcileJournal(journalName, basename);
      }
    }
  }
}

async function writeJournal(
  name: string,
  journal: SaveJournal,
  hooks: SecureFileTransactionHooks,
): Promise<SecureFileIdentity> {
  const content = Buffer.from(JSON.stringify(journal), "utf8");
  if (content.byteLength > MAX_JOURNAL_BYTES) {
    throw new SecureFileOperationError(
      "unavailable",
      "The secure save journal exceeded its size limit.",
    );
  }
  const pendingName = `${TRANSACTION_PREFIX}${randomUUID()}${PENDING_SUFFIX}`;
  const handle = await open(
    pendingName,
    fsConstants.O_CREAT
      | fsConstants.O_EXCL
      | fsConstants.O_WRONLY
      | FILE_OPEN_NO_FOLLOW,
    0o600,
  );
  let pendingIdentity: SecureFileIdentity | null = null;
  let published = false;
  let preservePending = false;
  try {
    try {
      const created = await handle.stat({ bigint: true });
      if (!created.isFile() || Number(created.nlink) !== 1) {
        throw new SecureFileOperationError(
          "unsafe",
          "The secure save pending journal is unsafe.",
        );
      }
      pendingIdentity = identity(created);
      await (hooks.writeJournalPending ?? writeComplete)(handle, content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (hooks.stopAfter === "journal-pending") {
      preservePending = true;
      throw new SimulatedWorkerTermination();
    }
    const pending = await snapshotNamedFile(pendingName, MAX_JOURNAL_BYTES);
    if (
      !pending?.metadata
      || !pendingIdentity
      || !sameIdentity(pending.fileIdentity, pendingIdentity)
      || pending.linkCount !== 1
      || pending.metadata.digest !== digest(content)
    ) {
      throw new SecureFileOperationError(
        "unsafe",
        "The secure save pending journal could not be verified.",
      );
    }
    if (await snapshotNamedFile(name, MAX_JOURNAL_BYTES)) {
      throw new SecureFileOperationError(
        "conflict",
        "A secure save journal already exists.",
      );
    }
    await hooks.beforeJournalPublish?.(pendingName, name);
    try {
      await link(pendingName, name);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new SecureFileOperationError(
          "conflict",
          "A concurrent file prevented secure save journal publication.",
        );
      }
      throw error;
    }
    if (hooks.stopAfter === "journal-published") {
      preservePending = true;
      throw new SimulatedWorkerTermination();
    }
    const linked = await snapshotNamedFile(name, MAX_JOURNAL_BYTES);
    if (
      !linked?.metadata
      || !sameIdentity(linked.fileIdentity, pendingIdentity)
      || linked.linkCount !== 2
      || linked.metadata.digest !== digest(content)
    ) {
      const current = await lstat(name, { bigint: true })
        .catch((error) => {
          if (errorCode(error) === "ENOENT") return null;
          throw error;
        });
      if (current) {
        await removeExact(
          name,
          identity(current),
          hooks,
          `${name}.quarantine`,
        );
      }
      throw new SecureFileOperationError(
        "unsafe",
        "The secure save journal source changed during publication.",
      );
    }
    await removeExact(
      pendingName,
      pendingIdentity,
      hooks,
      `${pendingName}.quarantine`,
    );
    const publishedJournal = await snapshotNamedFile(name, MAX_JOURNAL_BYTES);
    if (
      !publishedJournal?.metadata
      || !sameIdentity(publishedJournal.fileIdentity, pendingIdentity)
      || publishedJournal.linkCount !== 1
      || publishedJournal.metadata.digest !== digest(content)
    ) {
      throw new SecureFileOperationError(
        "unsafe",
        "The secure save journal could not be verified after publication.",
      );
    }
    await syncCurrentDirectory();
    published = true;
    return pendingIdentity;
  } finally {
    if (!preservePending && !published && pendingIdentity) {
      await removeExact(
        pendingName,
        pendingIdentity,
        hooks,
        `${pendingName}.quarantine`,
      )
        .catch(() => undefined);
    }
  }
}

export async function replaceSecureFileTransaction(
  request: Extract<SecureFileRequest, { operation: "replace" }>,
  basename: string,
  assertNamespace: () => Promise<void>,
  hooks: SecureFileTransactionHooks = {},
): Promise<SecureFileResult> {
  await recoverSecureFileTransactions(basename);
  await assertNamespace();
  await assertExpectedTarget(request, basename);

  const content = Buffer.from(request.contentBase64, "base64");
  const token = randomUUID();
  const stem = `${TRANSACTION_PREFIX}${token}`;
  const stageName = `${stem}.stage`;
  const backupName = `${stem}.backup`;
  const journalName = `${stem}${JOURNAL_SUFFIX}`;
  const probeName = `${stem}.probe`;
  let stageIdentity: SecureFileIdentity | null = null;
  let probeIdentity: SecureFileIdentity | null = null;
  let journalIdentity: SecureFileIdentity | null = null;
  let journalCreated = false;
  let commitStarted = false;
  let commitFinished = false;
  try {
    const stageHandle = await open(
      stageName,
      fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_WRONLY
        | FILE_OPEN_NO_FOLLOW,
      0o600,
    );
    try {
      const created = await stageHandle.stat({ bigint: true });
      if (!created.isFile() || Number(created.nlink) !== 1) {
        throw new SecureFileOperationError(
          "unsafe",
          "The staged secure save is unsafe.",
        );
      }
      stageIdentity = identity(created);
      await (hooks.writeStaged ?? writeComplete)(stageHandle, content);
      if (process.platform !== "win32") {
        await stageHandle.chmod(request.mode & 0o777);
      }
      await stageHandle.sync();
      const info = await stageHandle.stat({ bigint: true });
      if (
        !info.isFile()
        || Number(info.nlink) !== 1
        || !sameIdentity(identity(info), stageIdentity)
      ) {
        throw new SecureFileOperationError(
          "unsafe",
          "The staged secure save is unsafe.",
        );
      }
    } finally {
      await stageHandle.close();
    }

    await link(stageName, probeName);
    probeIdentity = stageIdentity;
    await removeExact(
      probeName,
      probeIdentity,
      hooks,
      `${stem}.probe.quarantine`,
    );
    probeIdentity = null;
    const stage = await snapshotNamedFile(stageName, request.maxBytes);
    const replacementDigest = digest(content);
    if (
      !stage
      || !stage.metadata
      || !stageIdentity
      || !sameIdentity(stage.fileIdentity, stageIdentity)
      || stage.linkCount !== 1
      || stage.metadata.digest !== replacementDigest
      || stage.metadata.mode !== request.mode
    ) {
      throw new SecureFileOperationError(
        "unsafe",
        "The staged secure save could not be verified.",
      );
    }

    const journal: SaveJournal = {
      version: 1,
      token,
      target: basename,
      stage: stageName,
      backup: backupName,
      maxBytes: request.maxBytes,
      expectedIdentity: request.targetIdentity,
      expectedDigest: request.expectedDigest,
      expectedMode: request.expectedMode,
      replacementIdentity: stageIdentity,
      replacementDigest,
      replacementMode: request.mode,
    };
    journalIdentity = await writeJournal(journalName, journal, hooks);
    journalCreated = true;
    await syncCurrentDirectory();

    await hooks.beforeClaim?.();
    await assertNamespace();
    await assertExpectedTarget(request, basename);
    await assertVerifiedStage(stageName, journal);
    await hooks.beforeClaimRename?.();
    const claim = await claimSecureFileTarget({
      basename,
      backupName,
      backupQuarantineName: quarantineName(journal, "backup"),
      journalName,
      journalIdentity,
      journalQuarantineName: quarantineName(journal, "journal"),
      maxBytes: request.maxBytes,
      expectedIdentity: request.targetIdentity,
      expectedDigest: request.expectedDigest,
      expectedMode: request.expectedMode,
      hooks,
    });
    if (!claim.ok) {
      journalCreated = false;
      throw new SecureFileOperationError(
        claim.code,
        claim.message,
      );
    }
    hooks.onCommitPhase?.("started");
    commitStarted = true;
    await removeExact(
      basename,
      request.targetIdentity,
      hooksWithQuarantineStop(
        hooks,
        basename,
        "claim-quarantine",
      ),
      quarantineName(journal, "target"),
    );
    await syncCurrentDirectory();
    if (hooks.stopAfter === "claim") throw new SimulatedWorkerTermination();
    await hooks.afterClaim?.();
    await assertNamespace();

    const backup = await snapshotNamedFile(backupName, request.maxBytes);
    if (!backup) {
      throw new SecureFileOperationError(
        "unsafe",
        "The claimed file disappeared before the secure save committed.",
      );
    }
    if (!matchesSnapshot(
      backup,
      request.targetIdentity,
      request.expectedDigest,
      request.expectedMode,
    )) {
      throw new SecureFileOperationError(
        "unsafe",
        "The secure save recovery copy changed after the file was claimed.",
      );
    }
    if (backup.linkCount !== 1) {
      throw new SecureFileOperationError(
        "unsafe",
        "The claimed file gained another hard link before commit.",
      );
    }
    await assertVerifiedStage(stageName, journal);
    await hooks.beforeInstallLink?.();
    await link(stageName, basename);
    await syncCurrentDirectory();
    if (hooks.stopAfter === "install") throw new SimulatedWorkerTermination();
    await hooks.afterInstall?.();

    const installed = await snapshotNamedFile(basename, request.maxBytes);
    if (
      !matchesSnapshot(
        installed,
        stageIdentity,
        journal.replacementDigest,
        journal.replacementMode,
      )
      || installed.linkCount !== 2
    ) {
      throw new SecureFileOperationError(
        "unsafe",
        "The secure save could not verify its installed file.",
      );
    }
    try {
      await assertNamespace();
    } catch (error) {
      await rollBackJournal(
        journalName,
        basename,
        journalIdentity,
        hooks,
      );
      journalCreated = false;
      throw error;
    }
    await reconcileJournal(
      journalName,
      basename,
      journalIdentity,
      hooks,
    );
    journalCreated = false;
    commitFinished = true;
    hooks.onCommitPhase?.("finished");

    const saved = await openVerifiedFile(basename, request.maxBytes);
    try {
      if (
        saved.metadata.digest !== journal.replacementDigest
        || saved.metadata.mode !== journal.replacementMode
        || saved.linkCount !== 1
      ) {
        throw new SecureFileOperationError(
          "unsafe",
          "The replacement file could not be verified.",
        );
      }
      return {
        ok: true,
        operation: "replace",
        metadata: saved.metadata,
      };
    } finally {
      await saved.handle.close();
    }
  } catch (error) {
    if (error instanceof SimulatedWorkerTermination) throw error;
    if (journalCreated) {
      if (commitStarted) {
        await rollBackJournal(
          journalName,
          basename,
          journalIdentity ?? undefined,
          hooks,
        );
      } else {
        await reconcileJournal(
          journalName,
          basename,
          journalIdentity ?? undefined,
          hooks,
        );
      }
      journalCreated = false;
    }
    throw error;
  } finally {
    if (commitStarted && !commitFinished) hooks.onCommitPhase?.("finished");
    if (probeIdentity) {
      await removeExact(
        probeName,
        probeIdentity,
        hooks,
        `${stem}.probe.quarantine`,
      ).catch(() => undefined);
    }
    if (!journalCreated && stageIdentity) {
      await removeExact(
        stageName,
        stageIdentity,
        hooks,
        `${stem}.stage.quarantine`,
      ).catch(() => undefined);
    }
  }
}
