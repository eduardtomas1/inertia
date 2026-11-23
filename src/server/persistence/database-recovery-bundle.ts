import { createHash, randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import type Database from "better-sqlite3";

import {
  metadataFromUnknown,
  type PersistedAttachmentMetadata,
} from "../../node/conversation-attachment-store-metadata";
import { FILE_OPEN_NO_FOLLOW } from "../../node/platform-file-open-flags";
import {
  attachmentLimitError,
  chatAttachmentStorageExtension,
  type ChatAttachmentMimeType,
} from "../../shared/attachments";
import type { ChatAttachment } from "../../shared/contracts";
import {
  DATABASE_RECOVERY_BUNDLE_FORMAT,
  DATABASE_RECOVERY_BUNDLE_MAX_ATTACHMENTS,
  DATABASE_RECOVERY_BUNDLE_MAX_ATTACHMENT_BYTES,
  DATABASE_RECOVERY_BUNDLE_MAX_MANIFEST_BYTES,
  DATABASE_RECOVERY_BUNDLE_MAX_TOTAL_ATTACHMENT_BYTES,
  DATABASE_RECOVERY_BUNDLE_VERSION,
  DATABASE_RECOVERY_EXPORT_MAX_BYTES,
  type DatabaseRecoveryExport,
  type DatabaseRecoveryExportResultSummary,
  type DatabaseRecoveryImportResult,
  type RecoveryBundleAttachmentEntry,
  type RecoveryBundleManifest,
  parseDatabaseRecoveryExport,
  parseRecoveryBundleManifest,
  recoveryBundleManifestSchema,
  serializeDatabaseRecoveryBundleExport,
} from "./database-export";
import { readDatabaseRecoveryExportFile } from "./database-export-file";
import {
  assertAttachmentRootAuthority,
  assertContainedPath,
  type AttachmentRootAuthority,
  detectRecoveryFileFormat,
  ensureSecureAttachmentRoot,
  errorCode,
  isContained,
  isPrivateEntry,
  readSmallSecureFile,
  reconcileRecoveryAttachmentStaging,
  RECOVERY_ATTACHMENT_DIRECTORY_MODE,
  RECOVERY_ATTACHMENT_FILE_MODE,
  RECOVERY_ATTACHMENT_MAX_METADATA_BYTES,
  RECOVERY_ATTACHMENT_METADATA_FILE,
  RECOVERY_ATTACHMENT_UUID_V4,
  resolveExistingAttachmentRoot,
  sameDeviceAndInode,
  streamCopyFile,
  syncDirectory,
  throwIfAborted,
  writeBufferFile,
} from "./database-recovery-bundle-io";
import { reconcileRecoveryImportJournal } from "./database-recovery-import";
import {
  type DatabaseRecoveryImportOptions,
  type DatabaseRecoveryImportWriters,
  importDatabaseRecoveryData,
  importPreparedDatabaseRecovery,
  snapshotRecoveryExportData,
  type RecoveryExportAttachmentReference,
} from "./database-recovery-store";
import {
  RecoveryTarWriter,
  streamRecoveryTarEntries,
  TAR_BLOCK_BYTES,
} from "./recovery-tar";

export { detectRecoveryFileFormat, reconcileRecoveryAttachmentStaging };

const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ExportDatabaseRecoveryBundleOptions {
  readonly database: Database.Database;
  readonly dataDirectory: string;
  readonly outputPath: string;
  readonly maxExportBytes?: number;
  readonly maxAttachmentBytes?: number;
  readonly maxTotalAttachmentBytes?: number;
  readonly signal?: AbortSignal;
}

export interface StageRecoveryBundleImportOptions {
  readonly bundlePath: string;
  readonly dataDirectory: string;
  readonly authorizedRoot: string;
  readonly operationId: string;
  readonly maxExportBytes?: number;
  readonly maxAttachments?: number;
  readonly maxAttachmentBytes?: number;
  readonly maxTotalAttachmentBytes?: number;
  readonly signal?: AbortSignal;
}

export interface StagedRecoveryBundle {
  readonly bundleDigest: string;
  readonly recovery: DatabaseRecoveryExport;
  readonly attachmentsByMessageKey: ReadonlyMap<string, ChatAttachment[]>;
  readonly includedCount: number;
  readonly missingCount: number;
  readonly publishedAttachments: readonly ChatAttachment[];
  publish(options?: { readonly beforePublishAttachment?: (id: string) => void }): Promise<string[]>;
  rollbackPublished(publishedIds: readonly string[]): Promise<void>;
  cleanup(): Promise<void>;
}

interface OpenedRetainedAttachment {
  readonly handle: FileHandle;
  readonly metadata: PersistedAttachmentMetadata;
  readonly statBefore: Awaited<ReturnType<FileHandle["stat"]>>;
}

async function openRetainedAttachmentForExport(
  root: AttachmentRootAuthority,
  reference: RecoveryExportAttachmentReference,
  maxAttachmentBytes: number,
): Promise<OpenedRetainedAttachment | null> {
  const { id, mimeType, size } = reference.attachment;
  if (!RECOVERY_ATTACHMENT_UUID_V4.test(id)) return null;
  await assertAttachmentRootAuthority(root);
  const recordDirectory = join(root.path, id);
  let recordStat: Awaited<ReturnType<typeof lstat>>;
  try {
    recordStat = await lstat(recordDirectory, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (
    !recordStat.isDirectory()
    || recordStat.isSymbolicLink()
    || !isPrivateEntry(recordStat, RECOVERY_ATTACHMENT_DIRECTORY_MODE)
  ) {
    throw new Error("A retained attachment directory is unsafe.");
  }
  const canonicalRecordDir = await assertContainedPath(root.path, recordDirectory);
  const metadataPath = join(canonicalRecordDir, RECOVERY_ATTACHMENT_METADATA_FILE);
  const metadataBuffer = await readSmallSecureFile(
    metadataPath,
    RECOVERY_ATTACHMENT_MAX_METADATA_BYTES,
    canonicalRecordDir,
  );
  if (!metadataBuffer) return null;
  let parsedMetadata: PersistedAttachmentMetadata | null = null;
  try {
    parsedMetadata = metadataFromUnknown(JSON.parse(metadataBuffer.toString("utf8")));
  } catch {
    parsedMetadata = null;
  }
  if (
    !parsedMetadata
    || parsedMetadata.id !== id
    || parsedMetadata.mimeType !== mimeType
    || parsedMetadata.size !== size
    || parsedMetadata.size > maxAttachmentBytes
  ) {
    return null;
  }
  const contentPath = join(canonicalRecordDir, `${id}.${parsedMetadata.extension}`);
  let contentStat: Awaited<ReturnType<typeof lstat>>;
  try {
    contentStat = await lstat(contentPath, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (
    !contentStat.isFile()
    || contentStat.isSymbolicLink()
    || !isPrivateEntry(contentStat, RECOVERY_ATTACHMENT_FILE_MODE)
    || contentStat.size !== BigInt(parsedMetadata.size)
  ) {
    return null;
  }
  await assertContainedPath(canonicalRecordDir, contentPath);
  const noFollow = "O_NOFOLLOW" in constants ? FILE_OPEN_NO_FOLLOW : 0;
  let handle: FileHandle;
  try {
    handle = await open(contentPath, constants.O_RDONLY | noFollow);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const statBefore = await handle.stat({ bigint: true });
    if (
      !statBefore.isFile()
      || !sameDeviceAndInode(contentStat, statBefore)
      || statBefore.size !== contentStat.size
      || !isPrivateEntry(statBefore, RECOVERY_ATTACHMENT_FILE_MODE)
    ) {
      throw new Error("The retained attachment changed while opening.");
    }
    return {
      handle,
      metadata: parsedMetadata,
      statBefore: await handle.stat(),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

export async function exportDatabaseRecoveryBundle(
  options: ExportDatabaseRecoveryBundleOptions,
): Promise<DatabaseRecoveryExportResultSummary> {
  const maxExportBytes = options.maxExportBytes ?? DATABASE_RECOVERY_EXPORT_MAX_BYTES;
  const maxAttachmentBytes = options.maxAttachmentBytes ?? DATABASE_RECOVERY_BUNDLE_MAX_ATTACHMENT_BYTES;
  const maxTotalAttachmentBytes =
    options.maxTotalAttachmentBytes ?? DATABASE_RECOVERY_BUNDLE_MAX_TOTAL_ATTACHMENT_BYTES;
  const snapshot = snapshotRecoveryExportData(
    options.database,
    maxExportBytes,
    DATABASE_RECOVERY_BUNDLE_VERSION,
  );
  if (snapshot.attachmentReferences.length > DATABASE_RECOVERY_BUNDLE_MAX_ATTACHMENTS) {
    throw new Error("The recovery bundle contains too many attachments.");
  }
  const exportBuffer = Buffer.from(
    serializeDatabaseRecoveryBundleExport(snapshot.exportData),
    "utf8",
  );
  const attachmentRoot = await resolveExistingAttachmentRoot(options.dataDirectory);
  const writer = await RecoveryTarWriter.open(options.outputPath, options.signal);
  try {
    const writtenExport = await writer.writeBufferEntry("export.json", exportBuffer, options.signal);
    const processedById = new Map<
      string,
      | { readonly status: "included"; readonly sha256: string; readonly size: number; readonly entryPath: string }
      | { readonly status: "missing" }
    >();
    const includedIds = new Set<string>();
    const missingIds = new Set<string>();
    const manifestAttachments: RecoveryBundleAttachmentEntry[] = [];
    let totalIncludedBytes = 0;

    for (const reference of snapshot.attachmentReferences) {
      throwIfAborted(options.signal, "The database recovery export was cancelled.");
      const { attachment } = reference;
      let outcome = processedById.get(attachment.id);
      if (!outcome) {
        if (!attachmentRoot) {
          outcome = { status: "missing" };
        } else {
          const opened = await openRetainedAttachmentForExport(
            attachmentRoot,
            reference,
            maxAttachmentBytes,
          );
          if (!opened) {
            outcome = { status: "missing" };
          } else {
            try {
              const nextTotal = totalIncludedBytes + opened.metadata.size;
              if (!Number.isSafeInteger(nextTotal) || nextTotal > maxTotalAttachmentBytes) {
                throw new Error("The recovery bundle exceeds its safe attachment size limit.");
              }
              const entryPath = `attachments/${attachment.id}.${opened.metadata.extension}`;
              const streamed = await writer.writeFileStreamEntry(
                entryPath,
                opened.handle,
                opened.metadata.size,
                options.signal,
              );
              const statAfter = await opened.handle.stat();
              if (
                statAfter.size !== opened.statBefore.size
                || statAfter.mtimeMs !== opened.statBefore.mtimeMs
                || statAfter.ctimeMs !== opened.statBefore.ctimeMs
                || streamed.sha256 !== opened.metadata.digest
              ) {
                throw new Error("A retained attachment changed or failed integrity verification during export.");
              }
              totalIncludedBytes = nextTotal;
              includedIds.add(attachment.id);
              outcome = {
                status: "included",
                sha256: streamed.sha256,
                size: streamed.size,
                entryPath,
              };
            } finally {
              await opened.handle.close();
            }
          }
        }
        processedById.set(attachment.id, outcome);
      }
      if (outcome.status === "missing") {
        missingIds.add(attachment.id);
      }
      manifestAttachments.push({
        id: attachment.id,
        conversationId: reference.conversationId,
        messageReference: {
          projectIndex: reference.projectIndex,
          conversationIndex: reference.conversationIndex,
          messageOrdinal: reference.messageOrdinal,
          messageId: reference.messageId,
        },
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: outcome.status === "included" ? outcome.size : attachment.size,
        sha256: outcome.status === "included" ? outcome.sha256 : null,
        status: outcome.status,
        entryPath: outcome.status === "included" ? outcome.entryPath : null,
      });
    }

    const manifest: RecoveryBundleManifest = recoveryBundleManifestSchema.parse({
      format: DATABASE_RECOVERY_BUNDLE_FORMAT,
      version: DATABASE_RECOVERY_BUNDLE_VERSION,
      exportedAt: snapshot.exportData.exportedAt,
      exportEntry: "export.json",
      exportSize: writtenExport.size,
      exportSha256: writtenExport.sha256,
      attachments: manifestAttachments,
    });
    const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    if (manifestBuffer.byteLength > DATABASE_RECOVERY_BUNDLE_MAX_MANIFEST_BYTES) {
      throw new Error("The recovery bundle manifest exceeds its safe size limit.");
    }
    await writer.writeBufferEntry("manifest.json", manifestBuffer, options.signal);
    await writer.finish(options.signal);
    return {
      includeAttachments: true,
      attachments: includedIds.size,
      missingAttachments: missingIds.size,
    };
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

export function recoveryMessageKey(
  projectIndex: number,
  conversationIndex: number,
  messageOrdinal: number,
): string {
  return `${projectIndex}:${conversationIndex}:${messageOrdinal}`;
}

export async function stageRecoveryBundleImport(
  options: StageRecoveryBundleImportOptions,
): Promise<StagedRecoveryBundle> {
  if (!OPERATION_ID_PATTERN.test(options.operationId)) {
    throw new Error("The recovery import operation identity is invalid.");
  }
  const maxExportBytes = options.maxExportBytes ?? DATABASE_RECOVERY_EXPORT_MAX_BYTES;
  const maxAttachments = options.maxAttachments ?? DATABASE_RECOVERY_BUNDLE_MAX_ATTACHMENTS;
  const maxAttachmentBytes = options.maxAttachmentBytes ?? DATABASE_RECOVERY_BUNDLE_MAX_ATTACHMENT_BYTES;
  const maxTotalAttachmentBytes =
    options.maxTotalAttachmentBytes ?? DATABASE_RECOVERY_BUNDLE_MAX_TOTAL_ATTACHMENT_BYTES;
  const rootAuthority = await ensureSecureAttachmentRoot(options.dataDirectory);
  const stagingName = `.recovery-import-${options.operationId}.partial`;
  const stagingDirectory = join(rootAuthority.path, stagingName);
  const rawDirectory = join(stagingDirectory, "raw");
  const readyDirectory = join(stagingDirectory, "ready");
  await mkdir(stagingDirectory, { mode: RECOVERY_ATTACHMENT_DIRECTORY_MODE });
  if (process.platform !== "win32") await chmod(stagingDirectory, RECOVERY_ATTACHMENT_DIRECTORY_MODE);
  await assertContainedPath(rootAuthority.path, stagingDirectory);
  await mkdir(rawDirectory, { mode: RECOVERY_ATTACHMENT_DIRECTORY_MODE });
  await mkdir(readyDirectory, { mode: RECOVERY_ATTACHMENT_DIRECTORY_MODE });
  if (process.platform !== "win32") {
    await chmod(rawDirectory, RECOVERY_ATTACHMENT_DIRECTORY_MODE);
    await chmod(readyDirectory, RECOVERY_ATTACHMENT_DIRECTORY_MODE);
  }

  const removeStaging = async (): Promise<void> => {
    await assertAttachmentRootAuthority(rootAuthority).catch(() => undefined);
    await rm(stagingDirectory, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    }).catch(() => undefined);
    await syncDirectory(rootAuthority.path).catch(() => undefined);
  };

  try {
    let exportBuffer: Buffer | null = null;
    let exportSha256: string | null = null;
    let manifestBuffer: Buffer | null = null;
    const stagedRaw = new Map<
      string,
      { readonly tempPath: string; readonly size: number; readonly sha256: string }
    >();
    let stagedAttachmentBytes = 0;

    const maxTotalPayloadBytes =
      maxExportBytes + DATABASE_RECOVERY_BUNDLE_MAX_MANIFEST_BYTES + maxTotalAttachmentBytes;
    const maxArchiveBytes =
      maxTotalPayloadBytes + (maxAttachments + 4) * TAR_BLOCK_BYTES * 2;
    const archive = await streamRecoveryTarEntries(
      options.bundlePath,
      {
        maxArchiveBytes,
        maxEntries: maxAttachments + 2,
        maxEntryBytes: Math.max(maxExportBytes, DATABASE_RECOVERY_BUNDLE_MAX_MANIFEST_BYTES, maxAttachmentBytes),
        maxTotalPayloadBytes,
        signal: options.signal,
      },
      async (entry) => {
        if (entry.name === "export.json") {
          if (entry.size < 1 || entry.size > maxExportBytes) {
            throw new Error("The recovery export exceeds its safe size limit.");
          }
          const pieces: Buffer[] = [];
          const hash = createHash("sha256");
          for await (const chunk of entry.chunks()) {
            hash.update(chunk);
            pieces.push(chunk);
          }
          exportBuffer = Buffer.concat(pieces, entry.size);
          exportSha256 = hash.digest("hex");
          return;
        }
        if (entry.name === "manifest.json") {
          if (entry.size < 1 || entry.size > DATABASE_RECOVERY_BUNDLE_MAX_MANIFEST_BYTES) {
            throw new Error("The recovery bundle manifest exceeds its safe size limit.");
          }
          const pieces: Buffer[] = [];
          for await (const chunk of entry.chunks()) {
            pieces.push(chunk);
          }
          manifestBuffer = Buffer.concat(pieces, entry.size);
          return;
        }
        if (entry.size < 1 || entry.size > maxAttachmentBytes) {
          throw new Error("A recovery bundle attachment exceeds the maximum allowed size.");
        }
        if (stagedRaw.size >= maxAttachments) {
          throw new Error("The recovery bundle contains too many attachments.");
        }
        const nextTotal = stagedAttachmentBytes + entry.size;
        if (!Number.isSafeInteger(nextTotal) || nextTotal > maxTotalAttachmentBytes) {
          throw new Error("The recovery bundle exceeds the maximum total attachment size.");
        }
        const leaf = entry.name.slice("attachments/".length);
        if (basename(leaf) !== leaf || leaf.includes("..") || /[\\/]/u.test(leaf)) {
          throw new Error("The recovery bundle contains an unsafe attachment path.");
        }
        const tempPath = join(rawDirectory, leaf);
        const handle = await open(
          tempPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          RECOVERY_ATTACHMENT_FILE_MODE,
        );
        const hash = createHash("sha256");
        let writtenTotal = 0;
        try {
          for await (const chunk of entry.chunks()) {
            hash.update(chunk);
            let chunkOffset = 0;
            while (chunkOffset < chunk.length) {
              const { bytesWritten } = await handle.write(
                chunk,
                chunkOffset,
                chunk.length - chunkOffset,
                writtenTotal + chunkOffset,
              );
              if (bytesWritten < 1) {
                throw new Error("Failed to stage recovery attachment file.");
              }
              chunkOffset += bytesWritten;
            }
            writtenTotal += chunk.length;
          }
          await handle.sync();
        } finally {
          await handle.close();
        }
        if (process.platform !== "win32") await chmod(tempPath, RECOVERY_ATTACHMENT_FILE_MODE);
        await assertContainedPath(rawDirectory, tempPath);
        if (writtenTotal !== entry.size) {
          throw new Error("A staged recovery attachment did not match its archive size.");
        }
        stagedAttachmentBytes = nextTotal;
        stagedRaw.set(entry.name, {
          tempPath,
          size: writtenTotal,
          sha256: hash.digest("hex"),
        });
      },
    );

    if (!exportBuffer || !exportSha256 || !manifestBuffer) {
      throw new Error("The recovery bundle is missing required export or manifest data.");
    }
    const manifest = parseRecoveryBundleManifest((manifestBuffer as Buffer).toString("utf8"));
    if (
      manifest.exportSize !== (exportBuffer as Buffer).byteLength
      || manifest.exportSha256 !== exportSha256
    ) {
      throw new Error("The recovery bundle export failed integrity verification.");
    }
    const recovery = parseDatabaseRecoveryExport(
      (exportBuffer as Buffer).toString("utf8"),
      { allowBundleVersion: true },
    );

    const conversationIdByCoord = new Map<string, string>();
    const usedRawEntries = new Set<string>();
    const missingIds = new Set<string>();
    const newIdByConversationAndOriginal = new Map<string, string>();
    const attachmentsByMessageKey = new Map<string, ChatAttachment[]>();
    const readyPlan = new Map<
      string,
      {
        readonly newId: string;
        readonly rawEntryPath: string;
        readonly metadata: PersistedAttachmentMetadata;
      }
    >();
    let totalPlannedBytes = 0;

    for (const entry of manifest.attachments) {
      const { projectIndex, conversationIndex, messageOrdinal } = entry.messageReference;
      const project = recovery.projects[projectIndex];
      const conversation = project?.conversations[conversationIndex];
      const message = conversation?.messages[messageOrdinal];
      if (!project || !conversation || !message) {
        throw new Error("The recovery bundle manifest references an unknown message.");
      }
      const convCoord = `${projectIndex}:${conversationIndex}`;
      const existingConversationId = conversationIdByCoord.get(convCoord);
      if (existingConversationId && existingConversationId !== entry.conversationId) {
        throw new Error("The recovery bundle manifest has conflicting conversation identities.");
      }
      conversationIdByCoord.set(convCoord, entry.conversationId);

      if (entry.status === "missing") {
        missingIds.add(entry.id);
        continue;
      }
      if (entry.size > maxAttachmentBytes) {
        throw new Error("A recovery bundle attachment exceeds the maximum allowed size.");
      }
      const rawEntryPath = entry.entryPath!;
      const staged = stagedRaw.get(rawEntryPath);
      if (!staged) {
        throw new Error("A recovery bundle attachment listed in the manifest is missing.");
      }
      if (staged.size !== entry.size) {
        throw new Error("A recovery bundle attachment size does not match the manifest.");
      }
      if (staged.sha256 !== entry.sha256) {
        throw new Error("A recovery bundle attachment checksum does not match the manifest.");
      }
      usedRawEntries.add(rawEntryPath);

      const scopedKey = `${convCoord}:${entry.id}`;
      let newId = newIdByConversationAndOriginal.get(scopedKey);
      const extension = chatAttachmentStorageExtension(entry.mimeType as ChatAttachmentMimeType);
      if (!newId) {
        newId = randomUUID();
        newIdByConversationAndOriginal.set(scopedKey, newId);
        totalPlannedBytes += entry.size;
        if (readyPlan.size >= maxAttachments) {
          throw new Error("The recovery bundle contains too many attachments.");
        }
        if (!Number.isSafeInteger(totalPlannedBytes) || totalPlannedBytes > maxTotalAttachmentBytes) {
          throw new Error("The recovery bundle exceeds the maximum total attachment size.");
        }
        readyPlan.set(newId, {
          newId,
          rawEntryPath,
          metadata: {
            version: 1,
            id: newId,
            name: entry.name,
            mimeType: entry.mimeType as ChatAttachmentMimeType,
            size: entry.size,
            digest: staged.sha256,
            extension,
          },
        });
      }
      const messageKey = recoveryMessageKey(projectIndex, conversationIndex, messageOrdinal);
      const list = attachmentsByMessageKey.get(messageKey) ?? [];
      if (list.some((existing) => existing.id === newId)) {
        throw new Error("The recovery bundle lists a duplicate attachment on one message.");
      }
      list.push({
        id: newId,
        name: entry.name,
        path: newId,
        mimeType: entry.mimeType as ChatAttachmentMimeType,
        size: entry.size,
      });
      if (attachmentLimitError(list) !== null) {
        throw new Error("A recovered message exceeds the attachment limit.");
      }
      attachmentsByMessageKey.set(messageKey, list);
    }

    if (usedRawEntries.size !== stagedRaw.size) {
      throw new Error("The recovery bundle contains unreferenced attachment files.");
    }

    const consumersRemaining = new Map<string, number>();
    for (const plan of readyPlan.values()) {
      consumersRemaining.set(
        plan.rawEntryPath,
        (consumersRemaining.get(plan.rawEntryPath) ?? 0) + 1,
      );
    }

    const publishedAttachments: ChatAttachment[] = [];
    for (const plan of readyPlan.values()) {
      throwIfAborted(options.signal, "The database recovery import was cancelled.");
      await assertAttachmentRootAuthority(rootAuthority);
      const recordDir = join(readyDirectory, plan.newId);
      await mkdir(recordDir, { mode: RECOVERY_ATTACHMENT_DIRECTORY_MODE });
      if (process.platform !== "win32") await chmod(recordDir, RECOVERY_ATTACHMENT_DIRECTORY_MODE);
      await assertContainedPath(readyDirectory, recordDir);
      const raw = stagedRaw.get(plan.rawEntryPath)!;
      const contentPath = join(recordDir, `${plan.newId}.${plan.metadata.extension}`);
      const remaining = consumersRemaining.get(plan.rawEntryPath) ?? 1;
      if (remaining === 1) {
        await rename(raw.tempPath, contentPath);
        if (process.platform !== "win32") await chmod(contentPath, RECOVERY_ATTACHMENT_FILE_MODE);
      } else {
        await streamCopyFile(
          raw.tempPath,
          contentPath,
          plan.metadata.size,
          plan.metadata.digest,
          options.signal,
        );
      }
      consumersRemaining.set(plan.rawEntryPath, remaining - 1);
      const metadataPath = join(recordDir, RECOVERY_ATTACHMENT_METADATA_FILE);
      await writeBufferFile(
        metadataPath,
        Buffer.from(JSON.stringify(plan.metadata), "utf8"),
        options.signal,
      );
      await assertContainedPath(rootAuthority.path, contentPath);
      await assertContainedPath(rootAuthority.path, metadataPath);
      await syncDirectory(recordDir);
      publishedAttachments.push({
        id: plan.newId,
        name: plan.metadata.name,
        path: join(rootAuthority.path, plan.newId, `${plan.newId}.${plan.metadata.extension}`),
        mimeType: plan.metadata.mimeType,
        size: plan.metadata.size,
      });
    }
    await rm(rawDirectory, { recursive: true, force: true }).catch(() => undefined);
    await syncDirectory(readyDirectory);
    await syncDirectory(stagingDirectory);

    const bundleDigest = createHash("sha256")
      .update("inertia-recovery-bundle-v4\0", "utf8")
      .update(archive.bundleSha256, "utf8")
      .update("\0", "utf8")
      .update(options.authorizedRoot, "utf8")
      .digest("hex");

    const readyIds = [...readyPlan.keys()];

    const rollbackPublished = async (publishedIds: readonly string[]): Promise<void> => {
      await assertAttachmentRootAuthority(rootAuthority).catch(() => undefined);
      for (const id of publishedIds) {
        if (!RECOVERY_ATTACHMENT_UUID_V4.test(id)) continue;
        const target = join(rootAuthority.path, id);
        if (!isContained(rootAuthority.path, target)) continue;
        await rm(target, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 25,
        }).catch(() => undefined);
      }
      await removeStaging();
    };

    return {
      bundleDigest,
      recovery,
      attachmentsByMessageKey,
      includedCount: readyIds.length,
      missingCount: missingIds.size,
      publishedAttachments,
      publish: async (publishOptions = {}): Promise<string[]> => {
        const published: string[] = [];
        try {
          for (const id of readyIds) {
            await assertAttachmentRootAuthority(rootAuthority);
            publishOptions.beforePublishAttachment?.(id);
            const sourceDir = join(readyDirectory, id);
            const destinationDir = join(rootAuthority.path, id);
            await assertContainedPath(readyDirectory, sourceDir);
            await rename(sourceDir, destinationDir);
            published.push(id);
          }
          await syncDirectory(rootAuthority.path);
          await removeStaging();
          return published;
        } catch (error) {
          await rollbackPublished(published);
          throw error;
        }
      },
      rollbackPublished,
      cleanup: removeStaging,
    };
  } catch (error) {
    await removeStaging();
    throw error;
  }
}

export async function importDatabaseRecoveryBundle(options: {
  readonly database: Database.Database;
  readonly dataDirectory: string;
  readonly bundlePath: string;
  readonly authorizedRoot: string;
  readonly writers: DatabaseRecoveryImportWriters;
  readonly importOptions?: DatabaseRecoveryImportOptions;
  readonly maxExportBytes?: number;
}): Promise<DatabaseRecoveryImportResult> {
  const {
    database,
    dataDirectory,
    bundlePath,
    authorizedRoot,
    writers,
    importOptions = {},
    maxExportBytes,
  } = options;
  if (!isAbsolute(authorizedRoot) || authorizedRoot.includes("\0")) {
    throw new Error("The recovery import destination is invalid.");
  }
  const rootMetadata = lstatSync(authorizedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("The recovery import destination is not a local directory.");
  }
  const resolvedRoot = resolve(realpathSync(authorizedRoot));
  const operationId = importOptions.operationId ?? randomUUID();
  const staged = await stageRecoveryBundleImport({
    bundlePath,
    dataDirectory,
    authorizedRoot: resolvedRoot,
    operationId,
    maxExportBytes,
    maxAttachments: importOptions.maxAttachments,
    maxAttachmentBytes: importOptions.maxAttachmentBytes,
    maxTotalAttachmentBytes: importOptions.maxTotalAttachmentBytes,
    signal: importOptions.signal,
  });
  let committed: Awaited<ReturnType<typeof importPreparedDatabaseRecovery>> | null = null;
  try {
    committed = await importPreparedDatabaseRecovery({
      database,
      recovery: staged.recovery,
      digest: staged.bundleDigest,
      resolvedRoot,
      writers,
      importOptions: { ...importOptions, operationId },
      attachmentsByMessageKey: staged.attachmentsByMessageKey,
    });
  } catch (error) {
    await staged.cleanup();
    throw error;
  }
  if (committed.summary.alreadyImported) {
    await staged.cleanup();
    return committed.summary;
  }
  try {
    await staged.publish({
      beforePublishAttachment: importOptions.operations?.beforePublishAttachment,
    });
  } catch (publishError) {
    const deleteConversation = database.prepare("DELETE FROM conversations WHERE id = ?");
    const deleteProject = database.prepare("DELETE FROM projects WHERE id = ?");
    const deleteReceipt = database.prepare("DELETE FROM recovery_import_receipts WHERE digest = ?");
    const rootIdentity = lstatSync(resolvedRoot, { bigint: true });
    database.transaction(() => {
      for (const conversationId of committed.createdConversationIds) {
        deleteConversation.run(conversationId);
      }
      for (const projectId of committed.createdProjectIds) {
        deleteProject.run(projectId);
      }
      deleteReceipt.run(staged.bundleDigest);
      if (committed.placeholderProjectCount > 0) {
        database.prepare(`
          INSERT OR REPLACE INTO recovery_import_journals (
            singleton, operation_id, digest, authorized_root,
            authorized_root_device, authorized_root_inode, projects, created_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          committed.operationId,
          staged.bundleDigest,
          resolvedRoot,
          rootIdentity.dev.toString(),
          rootIdentity.ino.toString(),
          committed.placeholderProjectCount,
          new Date().toISOString(),
        );
      }
    })();
    if (committed.placeholderProjectCount > 0) {
      reconcileRecoveryImportJournal(database);
    }
    throw publishError;
  }
  return {
    ...committed.summary,
    attachments: staged.includedCount,
    missingAttachments: staged.missingCount,
  };
}

export async function importDatabaseRecoveryFile(options: {
  readonly database: Database.Database;
  readonly dataDirectory: string;
  readonly recoveryPath: string;
  readonly authorizedRoot: string;
  readonly writers: DatabaseRecoveryImportWriters;
  readonly importOptions?: DatabaseRecoveryImportOptions;
  readonly maxExportBytes?: number;
}): Promise<DatabaseRecoveryImportResult> {
  const format = await detectRecoveryFileFormat(
    options.recoveryPath,
    options.importOptions?.signal,
  );
  if (format === "json") {
    const serialized = await readDatabaseRecoveryExportFile(options.recoveryPath, {
      signal: options.importOptions?.signal,
    });
    return importDatabaseRecoveryData(
      options.database,
      serialized,
      options.authorizedRoot,
      options.writers,
      options.importOptions,
    );
  }
  return importDatabaseRecoveryBundle({
    database: options.database,
    dataDirectory: options.dataDirectory,
    bundlePath: options.recoveryPath,
    authorizedRoot: options.authorizedRoot,
    writers: options.writers,
    importOptions: options.importOptions,
    maxExportBytes: options.maxExportBytes,
  });
}
