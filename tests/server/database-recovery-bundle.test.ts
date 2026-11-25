import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConversationAttachmentStore } from "../../src/node/conversation-attachment-store";
import { RuntimeStore } from "../../src/server/database";
import {
  DATABASE_RECOVERY_BUNDLE_FORMAT,
  DATABASE_RECOVERY_BUNDLE_VERSION,
  DATABASE_RECOVERY_EXPORT_VERSION,
  parseDatabaseRecoveryExport,
  parseRecoveryBundleManifest,
} from "../../src/server/persistence/database-export";
import {
  reconcileRecoveryAttachmentStaging,
  stageRecoveryBundleImport,
} from "../../src/server/persistence/database-recovery-bundle";
import {
  streamRecoveryTarEntries,
  TAR_BLOCK_BYTES,
} from "../../src/server/persistence/recovery-tar";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-recovery-bundle-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeRawTarEntry(name: string, payload: Buffer, typeflag = "0"): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  header.write(name, 0, 100, "ascii");
  header.write("0000600\0", 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${payload.byteLength.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write("00000000000\0", 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = typeflag.charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (let index = 0; index < TAR_BLOCK_BYTES; index += 1) {
    checksum += header[index]!;
  }
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const remainder = payload.byteLength % TAR_BLOCK_BYTES;
  const padding = remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(TAR_BLOCK_BYTES - remainder);
  return Buffer.concat([header, payload, padding]);
}

function buildRawTar(entries: ReadonlyArray<{ name: string; payload: Buffer; typeflag?: string }>): Buffer {
  return Buffer.concat([
    ...entries.map((entry) => writeRawTarEntry(entry.name, entry.payload, entry.typeflag)),
    Buffer.alloc(TAR_BLOCK_BYTES * 2),
  ]);
}

async function readBundleEntries(bundlePath: string): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();
  await streamRecoveryTarEntries(
    bundlePath,
    {
      maxArchiveBytes: 64 * 1024 * 1024,
      maxEntries: 100,
      maxEntryBytes: 32 * 1024 * 1024,
      maxTotalPayloadBytes: 64 * 1024 * 1024,
    },
    async (entry) => {
      const pieces: Buffer[] = [];
      for await (const chunk of entry.chunks()) {
        pieces.push(chunk);
      }
      entries.set(entry.name, Buffer.concat(pieces));
    },
  );
  return entries;
}

describe("portable recovery bundles with attachments", () => {
  it("round-trips retained attachments into a fresh database and attachment store under new ids", async () => {
    const sourceDir = temporaryDirectory();
    const destDir = temporaryDirectory();
    const authorizedRoot = temporaryDirectory();
    const bundlePath = join(temporaryDirectory(), "recovery.tar");

    const sourceStore = new RuntimeStore(
      join(sourceDir, "inertia.sqlite"),
      sourceDir,
      { recoverInterruptedRuns: false },
    );
    const sourceAttachments = await ConversationAttachmentStore.open(sourceDir);
    const project = sourceStore.createProject("Bundle project", sourceDir);
    const conversation = sourceStore.createConversation(project.id, "Bundle chat", {
      providerId: "claude",
      model: "claude-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "full",
    });

    const noteBytes = Buffer.from("Architecture notes with unicode: \u00e9\u2603\n", "utf8");
    const jsonBytes = Buffer.from(JSON.stringify({ ok: true, count: 7 }), "utf8");
    const noteId = randomUUID();
    const jsonId = randomUUID();
    const retentionId = randomUUID();
    const retained = await sourceAttachments.retain(
      [
        {
          attachment: {
            id: noteId,
            name: "notes.txt",
            path: noteId,
            mimeType: "text/plain",
            size: noteBytes.byteLength,
          },
          bytes: noteBytes,
        },
        {
          attachment: {
            id: jsonId,
            name: "config.json",
            path: jsonId,
            mimeType: "application/json",
            size: jsonBytes.byteLength,
          },
          bytes: jsonBytes,
        },
      ],
      undefined,
      retentionId,
    );
    sourceAttachments.acceptRetention(retentionId);

    const userMessage = sourceStore.createMessage(
      conversation.id,
      "Please inspect both files.",
      "user",
      retained,
      null,
      "2026-06-01T10:00:00.000Z",
    );
    sourceStore.createMessage(
      conversation.id,
      "Both files look good.",
      "assistant",
      [],
      null,
      "2026-06-01T10:00:05.000Z",
    );

    const exportSummary = await sourceStore.exportRecoveryBundle(bundlePath);
    expect(exportSummary).toEqual({
      includeAttachments: true,
      attachments: 2,
      missingAttachments: 0,
    });

    const entries = await readBundleEntries(bundlePath);
    const rawExport = JSON.parse(entries.get("export.json")!.toString("utf8")) as {
      version: number;
    };
    expect(rawExport.version).toBe(DATABASE_RECOVERY_BUNDLE_VERSION);
    const manifest = parseRecoveryBundleManifest(entries.get("manifest.json")!.toString("utf8"));
    expect(manifest.format).toBe(DATABASE_RECOVERY_BUNDLE_FORMAT);
    expect(manifest.version).toBe(DATABASE_RECOVERY_BUNDLE_VERSION);
    expect(manifest.attachments).toHaveLength(2);
    expect(manifest.attachments[0]).toMatchObject({
      id: noteId,
      conversationId: conversation.id,
      messageReference: {
        projectIndex: 0,
        conversationIndex: 0,
        messageOrdinal: 0,
        messageId: userMessage.id,
      },
      name: "notes.txt",
      mimeType: "text/plain",
      size: noteBytes.byteLength,
      sha256: createHash("sha256").update(noteBytes).digest("hex"),
      status: "included",
      entryPath: `attachments/${noteId}.txt`,
    });

    await sourceAttachments.close();
    sourceStore.close();

    const destStore = new RuntimeStore(
      join(destDir, "inertia.sqlite"),
      destDir,
      { recoverInterruptedRuns: false },
    );
    const importResult = await destStore.importRecoveryFile(bundlePath, authorizedRoot);
    expect(importResult).toEqual({
      projects: 1,
      conversations: 1,
      messages: 2,
      alreadyImported: false,
      attachments: 2,
      missingAttachments: 0,
    });

    const snapshot = destStore.shellSnapshot();
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]!.id).not.toBe(project.id);
    const importedConversation = snapshot.conversations[0]!;
    expect(importedConversation.id).not.toBe(conversation.id);
    expect(importedConversation.accessMode).toBe("supervised");

    const detail = destStore.conversationDetail(importedConversation.id)!;
    expect(detail.messages).toHaveLength(2);
    const importedAttachments = detail.messages[0]!.attachments;
    expect(importedAttachments).toHaveLength(2);
    expect(importedAttachments.map(({ id }) => id)).not.toContain(noteId);
    expect(importedAttachments.map(({ id }) => id)).not.toContain(jsonId);

    const destAttachments = await ConversationAttachmentStore.open(destDir);
    await destAttachments.reconcile(destStore.attachments());
    const resolvedNote = await destAttachments.preview(importedAttachments[0]!.id);
    const resolvedJson = await destAttachments.preview(importedAttachments[1]!.id);
    expect(resolvedNote?.bytes).toEqual(noteBytes);
    expect(resolvedNote?.attachment.name).toBe("notes.txt");
    expect(resolvedJson?.bytes).toEqual(jsonBytes);
    expect(resolvedJson?.attachment.name).toBe("config.json");

    const duplicate = await destStore.importRecoveryFile(bundlePath, authorizedRoot);
    expect(duplicate).toEqual({
      projects: 1,
      conversations: 1,
      messages: 2,
      alreadyImported: true,
    });

    await destAttachments.close();
    destStore.close();
  });

  it("lists already-missing attachments in the manifest and omits broken links on import", async () => {
    const sourceDir = temporaryDirectory();
    const destDir = temporaryDirectory();
    const authorizedRoot = temporaryDirectory();
    const bundlePath = join(temporaryDirectory(), "missing-attachments.tar");

    const sourceStore = new RuntimeStore(
      join(sourceDir, "inertia.sqlite"),
      sourceDir,
      { recoverInterruptedRuns: false },
    );
    const sourceAttachments = await ConversationAttachmentStore.open(sourceDir);
    const project = sourceStore.createProject("Partial project", sourceDir);
    const conversation = sourceStore.createConversation(project.id, "Partial chat");

    const presentBytes = Buffer.from("Present file content", "utf8");
    const presentId = randomUUID();
    const missingId = randomUUID();
    const retentionId = randomUUID();
    const [presentAttachment] = await sourceAttachments.retain(
      [{
        attachment: {
          id: presentId,
          name: "present.txt",
          path: presentId,
          mimeType: "text/plain",
          size: presentBytes.byteLength,
        },
        bytes: presentBytes,
      }],
      undefined,
      retentionId,
    );
    sourceAttachments.acceptRetention(retentionId);

    sourceStore.createMessage(
      conversation.id,
      "One available and one evicted file.",
      "user",
      [
        presentAttachment!,
        {
          id: missingId,
          name: "evicted.txt",
          path: missingId,
          mimeType: "text/plain",
          size: 128,
        },
      ],
      null,
      "2026-06-02T10:00:00.000Z",
    );

    const exportSummary = await sourceStore.exportRecoveryBundle(bundlePath);
    expect(exportSummary).toEqual({
      includeAttachments: true,
      attachments: 1,
      missingAttachments: 1,
    });

    const entries = await readBundleEntries(bundlePath);
    const manifest = parseRecoveryBundleManifest(entries.get("manifest.json")!.toString("utf8"));
    expect(manifest.attachments).toHaveLength(2);
    expect(manifest.attachments.find(({ id }) => id === presentId)?.status).toBe("included");
    expect(manifest.attachments.find(({ id }) => id === missingId)).toMatchObject({
      id: missingId,
      name: "evicted.txt",
      status: "missing",
      sha256: null,
      entryPath: null,
    });

    await sourceAttachments.close();
    sourceStore.close();

    const destStore = new RuntimeStore(
      join(destDir, "inertia.sqlite"),
      destDir,
      { recoverInterruptedRuns: false },
    );
    const importResult = await destStore.importRecoveryFile(bundlePath, authorizedRoot);
    expect(importResult).toEqual({
      projects: 1,
      conversations: 1,
      messages: 1,
      alreadyImported: false,
      attachments: 1,
      missingAttachments: 1,
    });
    const detail = destStore.conversationDetail(destStore.shellSnapshot().conversations[0]!.id)!;
    expect(detail.messages[0]!.attachments).toHaveLength(1);
    expect(detail.messages[0]!.attachments[0]!.name).toBe("present.txt");

    const destAttachments = await ConversationAttachmentStore.open(destDir);
    const preview = await destAttachments.preview(detail.messages[0]!.attachments[0]!.id);
    expect(preview?.bytes).toEqual(presentBytes);

    await destAttachments.close();
    destStore.close();
  });

  it("refuses corrupted hash, oversize files, traversal names, symlinks, and truncated bundles with no partial state", async () => {
    const sourceDir = temporaryDirectory();
    const bundlePath = join(temporaryDirectory(), "valid.tar");

    const sourceStore = new RuntimeStore(
      join(sourceDir, "inertia.sqlite"),
      sourceDir,
      { recoverInterruptedRuns: false },
    );
    const sourceAttachments = await ConversationAttachmentStore.open(sourceDir);
    const project = sourceStore.createProject("Security project", sourceDir);
    const conversation = sourceStore.createConversation(project.id, "Security chat");
    const content = Buffer.from("verified attachment payload", "utf8");
    const attachmentId = randomUUID();
    const retentionId = randomUUID();
    const [retained] = await sourceAttachments.retain(
      [{
        attachment: {
          id: attachmentId,
          name: "report.txt",
          path: attachmentId,
          mimeType: "text/plain",
          size: content.byteLength,
        },
        bytes: content,
      }],
      undefined,
      retentionId,
    );
    sourceAttachments.acceptRetention(retentionId);
    sourceStore.createMessage(conversation.id, "Check file", "user", [retained!]);
    await sourceStore.exportRecoveryBundle(bundlePath);
    await sourceAttachments.close();
    sourceStore.close();

    const validEntries = await readBundleEntries(bundlePath);
    const exportBytes = validEntries.get("export.json")!;
    const manifestBytes = validEntries.get("manifest.json")!;
    const entryName = `attachments/${attachmentId}.txt`;
    const attachmentBytes = validEntries.get(entryName)!;

    const verifyRejectedCleanly = async (
      badBundle: Buffer,
      pattern: RegExp,
      importOptions?: Parameters<RuntimeStore["importRecoveryFile"]>[2],
    ): Promise<void> => {
      const destDir = temporaryDirectory();
      const authorizedRoot = temporaryDirectory();
      const badPath = join(temporaryDirectory(), "bad.tar");
      writeFileSync(badPath, badBundle);
      const destStore = new RuntimeStore(
        join(destDir, "inertia.sqlite"),
        destDir,
        { recoverInterruptedRuns: false },
      );
      try {
        await expect(
          destStore.importRecoveryFile(badPath, authorizedRoot, importOptions),
        ).rejects.toThrow(pattern);
        expect(destStore.shellSnapshot().projects).toHaveLength(0);
        expect(destStore.shellSnapshot().conversations).toHaveLength(0);
        expect(destStore.attachments()).toHaveLength(0);
        expect(readdirSync(authorizedRoot)).toEqual([]);
        const attachmentDir = join(destDir, "conversation-attachments");
        if (existsSync(attachmentDir)) {
          expect(readdirSync(attachmentDir)).toEqual([]);
        }
      } finally {
        destStore.close();
      }
    };

    const tamperedPayload = Buffer.from(attachmentBytes);
    tamperedPayload[0] = tamperedPayload[0]! ^ 0xff;
    await verifyRejectedCleanly(
      buildRawTar([
        { name: "export.json", payload: exportBytes },
        { name: entryName, payload: tamperedPayload },
        { name: "manifest.json", payload: manifestBytes },
      ]),
      /checksum/u,
    );

    await verifyRejectedCleanly(
      readFileSync(bundlePath),
      /maximum allowed size/u,
      { maxAttachmentBytes: 8 },
    );

    await verifyRejectedCleanly(
      readFileSync(bundlePath),
      /maximum total attachment size|maximum allowed total size/u,
      { maxTotalAttachmentBytes: 8 },
    );

    await verifyRejectedCleanly(
      buildRawTar([
        { name: "export.json", payload: exportBytes },
        { name: "../escape.txt", payload: attachmentBytes },
        { name: "manifest.json", payload: manifestBytes },
      ]),
      /unsafe entry path/u,
    );

    const parsedManifest = JSON.parse(manifestBytes.toString("utf8")) as {
      attachments: Array<{ name: string }>;
    };
    const traversalManifest = Buffer.from(
      JSON.stringify({
        ...parsedManifest,
        attachments: parsedManifest.attachments.map((item) => ({
          ...item,
          name: "../evil.txt",
        })),
      }),
      "utf8",
    );
    await verifyRejectedCleanly(
      buildRawTar([
        { name: "export.json", payload: exportBytes },
        { name: entryName, payload: attachmentBytes },
        { name: "manifest.json", payload: traversalManifest },
      ]),
      /manifest does not match/u,
    );

    await verifyRejectedCleanly(
      buildRawTar([
        { name: "export.json", payload: exportBytes },
        { name: entryName, payload: Buffer.alloc(0), typeflag: "2" },
        { name: "manifest.json", payload: manifestBytes },
      ]),
      /unsupported entry type/u,
    );

    const fullBytes = readFileSync(bundlePath);
    await verifyRejectedCleanly(
      fullBytes.subarray(0, fullBytes.byteLength - 600),
      /truncated/u,
    );
    await verifyRejectedCleanly(
      fullBytes.subarray(0, TAR_BLOCK_BYTES * 2),
      /truncated/u,
    );

    const parsedExport = JSON.parse(exportBytes.toString("utf8")) as {
      projects: Array<{ conversations: Array<{ messages: Array<Record<string, unknown>> }> }>;
    };
    const secondPayload = Buffer.from("%PDF-1.4\nconflicting payload\n", "utf8");
    const secondSha256 = createHash("sha256").update(secondPayload).digest("hex");
    const secondEntryName = `attachments/${attachmentId}.pdf`;
    const firstMsg = parsedExport.projects[0]!.conversations[0]!.messages[0]!;
    const collidingExport = Buffer.from(
      JSON.stringify({
        ...parsedExport,
        projects: [{
          ...parsedExport.projects[0]!,
          conversations: [{
            ...parsedExport.projects[0]!.conversations[0]!,
            messages: [firstMsg, { ...firstMsg, ordinal: 1, content: "Second message" }],
          }],
        }],
      }),
      "utf8",
    );
    const fullManifest = JSON.parse(manifestBytes.toString("utf8")) as {
      attachments: Array<{ messageReference: Record<string, unknown> } & Record<string, unknown>>;
    };
    const firstAttachment = fullManifest.attachments[0]!;
    const collidingManifest = Buffer.from(
      JSON.stringify({
        ...fullManifest,
        exportSize: collidingExport.byteLength,
        exportSha256: createHash("sha256").update(collidingExport).digest("hex"),
        attachments: [
          firstAttachment,
          {
            ...firstAttachment,
            messageReference: {
              ...firstAttachment.messageReference,
              messageOrdinal: 1,
            },
            name: "spoofed.pdf",
            mimeType: "application/pdf",
            size: secondPayload.byteLength,
            sha256: secondSha256,
            entryPath: secondEntryName,
          },
        ],
      }),
      "utf8",
    );
    await verifyRejectedCleanly(
      buildRawTar([
        { name: "export.json", payload: collidingExport },
        { name: entryName, payload: attachmentBytes },
        { name: secondEntryName, payload: secondPayload },
        { name: "manifest.json", payload: collidingManifest },
      ]),
      /conflicting attachment definitions/u,
    );
  });

  it("cleans up staging on interrupted import and reconciles leftover staging on next start", async () => {
    const sourceDir = temporaryDirectory();
    const bundlePath = join(temporaryDirectory(), "interrupt.tar");
    const sourceStore = new RuntimeStore(
      join(sourceDir, "inertia.sqlite"),
      sourceDir,
      { recoverInterruptedRuns: false },
    );
    const sourceAttachments = await ConversationAttachmentStore.open(sourceDir);
    const project = sourceStore.createProject("Interrupt project", sourceDir);
    const conversation = sourceStore.createConversation(project.id, "Interrupt chat");
    const fileA = Buffer.from("attachment alpha", "utf8");
    const fileB = Buffer.from("attachment beta", "utf8");
    const idA = randomUUID();
    const idB = randomUUID();
    const retentionId = randomUUID();
    const retained = await sourceAttachments.retain(
      [
        {
          attachment: { id: idA, name: "alpha.txt", path: idA, mimeType: "text/plain", size: fileA.byteLength },
          bytes: fileA,
        },
        {
          attachment: { id: idB, name: "beta.txt", path: idB, mimeType: "text/plain", size: fileB.byteLength },
          bytes: fileB,
        },
      ],
      undefined,
      retentionId,
    );
    sourceAttachments.acceptRetention(retentionId);
    sourceStore.createMessage(conversation.id, "Two files", "user", retained);
    await sourceStore.exportRecoveryBundle(bundlePath);
    await sourceAttachments.close();
    sourceStore.close();

    const destDir1 = temporaryDirectory();
    const authorizedRoot1 = temporaryDirectory();
    const destStore1 = new RuntimeStore(
      join(destDir1, "inertia.sqlite"),
      destDir1,
      { recoverInterruptedRuns: false },
    );
    await expect(
      destStore1.importRecoveryFile(bundlePath, authorizedRoot1, {
        operations: {
          afterMessageCreate: () => {
            throw new Error("Simulated interruption before SQLite commit");
          },
        },
      }),
    ).rejects.toThrow("Simulated interruption before SQLite commit");
    expect(destStore1.shellSnapshot().projects).toHaveLength(0);
    expect(destStore1.attachments()).toHaveLength(0);
    expect(readdirSync(join(destDir1, "conversation-attachments"))).toEqual([]);
    expect(readdirSync(authorizedRoot1)).toEqual([]);
    destStore1.close();

    const destDir2 = temporaryDirectory();
    const authorizedRoot2 = temporaryDirectory();
    const destStore2 = new RuntimeStore(
      join(destDir2, "inertia.sqlite"),
      destDir2,
      { recoverInterruptedRuns: false },
    );
    let publishCalls = 0;
    await expect(
      destStore2.importRecoveryFile(bundlePath, authorizedRoot2, {
        operations: {
          beforePublishAttachment: () => {
            publishCalls += 1;
            if (publishCalls === 2) {
              throw new Error("Simulated publish failure after SQLite commit");
            }
          },
        },
      }),
    ).rejects.toThrow("Simulated publish failure after SQLite commit");
    expect(destStore2.shellSnapshot().projects).toHaveLength(0);
    expect(destStore2.shellSnapshot().conversations).toHaveLength(0);
    expect(destStore2.attachments()).toHaveLength(0);
    expect(readdirSync(join(destDir2, "conversation-attachments"))).toEqual([]);
    expect(readdirSync(authorizedRoot2)).toEqual([]);
    destStore2.close();

    const crashDir = temporaryDirectory();
    const crashAuthorized = temporaryDirectory();
    const operationId = randomUUID();
    await stageRecoveryBundleImport({
      bundlePath,
      dataDirectory: crashDir,
      authorizedRoot: crashAuthorized,
      operationId,
    });
    const storeRoot = join(crashDir, "conversation-attachments");
    expect(readdirSync(storeRoot)).toEqual([`.recovery-import-${operationId}.partial`]);
    await reconcileRecoveryAttachmentStaging(crashDir, []);
    expect(readdirSync(storeRoot)).toEqual([]);

    const postCommitDir = temporaryDirectory();
    const postCommitAuthorized = temporaryDirectory();
    const postCommitOpId = randomUUID();
    const postCommitStaged = await stageRecoveryBundleImport({
      bundlePath,
      dataDirectory: postCommitDir,
      authorizedRoot: postCommitAuthorized,
      operationId: postCommitOpId,
    });
    const postCommitStore = new RuntimeStore(
      join(postCommitDir, "inertia.sqlite"),
      postCommitDir,
      { recoverInterruptedRuns: false },
    );
    const recoveredProject = postCommitStore.createProject("Committed", postCommitAuthorized);
    const recoveredChat = postCommitStore.createConversation(recoveredProject.id, "Committed chat");
    postCommitStore.createMessage(
      recoveredChat.id,
      "Committed before publish",
      "user",
      [...postCommitStaged.publishedAttachments],
    );
    await reconcileRecoveryAttachmentStaging(postCommitDir, postCommitStore.attachments());
    const postCommitRoot = join(postCommitDir, "conversation-attachments");
    expect(readdirSync(postCommitRoot).sort()).toEqual(
      postCommitStaged.publishedAttachments.map(({ id }) => id).sort(),
    );
    const reopenedAttachments = await ConversationAttachmentStore.open(postCommitDir);
    await reopenedAttachments.reconcile(postCommitStore.attachments());
    await reopenedAttachments.syncImportedReferences(postCommitStore.attachments());
    const recoveredAlpha = await reopenedAttachments.preview(
      postCommitStaged.publishedAttachments.find(({ name }) => name === "alpha.txt")!.id,
    );
    expect(recoveredAlpha?.bytes).toEqual(fileA);
    await reopenedAttachments.close();
    postCommitStore.close();
  });

  it("keeps older text-only JSON exports unchanged and readable", async () => {
    const sourceDir = temporaryDirectory();
    const destDir = temporaryDirectory();
    const authorizedRoot = temporaryDirectory();
    const jsonPath = join(temporaryDirectory(), "legacy.json");

    const sourceStore = new RuntimeStore(
      join(sourceDir, "inertia.sqlite"),
      sourceDir,
      { recoverInterruptedRuns: false },
    );
    const project = sourceStore.createProject("Text only", sourceDir);
    const conversation = sourceStore.createConversation(project.id, "Text chat");
    sourceStore.createMessage(conversation.id, "Hello legacy", "user", [], null, "2026-06-03T10:00:00.000Z");
    const serialized = sourceStore.exportRecoveryData();
    const parsed = parseDatabaseRecoveryExport(serialized);
    expect(parsed.version).toBe(DATABASE_RECOVERY_EXPORT_VERSION);
    writeFileSync(jsonPath, serialized, "utf8");
    sourceStore.close();

    const destStore = new RuntimeStore(
      join(destDir, "inertia.sqlite"),
      destDir,
      { recoverInterruptedRuns: false },
    );
    const result = await destStore.importRecoveryFile(jsonPath, authorizedRoot);
    expect(result).toEqual({
      projects: 1,
      conversations: 1,
      messages: 1,
      alreadyImported: false,
    });

    const v1Path = join(temporaryDirectory(), "v1.json");
    writeFileSync(
      v1Path,
      JSON.stringify({
        format: "inertia-recovery-export",
        version: 1,
        exportedAt: "2026-01-01T00:00:00.000Z",
        projects: [{
          name: "Old v1",
          path: "/old/v1",
          conversations: [{
            title: "V1 chat",
            providerId: "codex",
            model: "gpt-5",
            reasoningEffort: "medium",
            interactionMode: "build",
            accessMode: "full",
            messages: [{ role: "user", content: "V1 message", createdAt: "2026-01-01T00:00:01.000Z" }],
          }],
        }],
      }),
      "utf8",
    );
    const v1Result = await destStore.importRecoveryFile(v1Path, authorizedRoot);
    expect(v1Result).toEqual({
      projects: 1,
      conversations: 1,
      messages: 1,
      alreadyImported: false,
    });
    expect(existsSync(join(destDir, "conversation-attachments"))).toBe(false);
    destStore.close();
  });

  it("preserves previewAnnotation metadata on PNG attachments across recovery bundle export and import", async () => {
    const sourceDir = temporaryDirectory();
    const destDir = temporaryDirectory();
    const authorizedRoot = temporaryDirectory();
    const bundlePath = join(temporaryDirectory(), "annotated.tar");

    const sourceStore = new RuntimeStore(
      join(sourceDir, "inertia.sqlite"),
      sourceDir,
      { recoverInterruptedRuns: false },
    );
    const sourceAttachments = await ConversationAttachmentStore.open(sourceDir);
    const project = sourceStore.createProject("Annotated project", sourceDir);
    const conversation = sourceStore.createConversation(project.id, "Annotated chat");
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    const attachmentId = randomUUID();
    const retentionId = randomUUID();
    const previewAnnotation = {
      pageUrl: "http://127.0.0.1:4173/dashboard",
      selector: "button#save",
      role: "button",
      name: "Save",
      bounds: { x: 4, y: 8, width: 80, height: 28 },
      html: "<button id=\"save\">Save</button>",
      comment: "Increase contrast",
      capturedAt: "2026-11-25T06:00:00.000Z",
    };
    const [retained] = await sourceAttachments.retain(
      [{
        attachment: {
          id: attachmentId,
          name: "annotation.png",
          path: attachmentId,
          mimeType: "image/png",
          size: pngBytes.byteLength,
        },
        bytes: pngBytes,
      }],
      undefined,
      retentionId,
    );
    sourceAttachments.acceptRetention(retentionId);
    sourceStore.createMessage(conversation.id, "Check element", "user", [{ ...retained!, previewAnnotation }]);
    await sourceStore.exportRecoveryBundle(bundlePath);
    await sourceAttachments.close();
    sourceStore.close();

    const destStore = new RuntimeStore(
      join(destDir, "inertia.sqlite"),
      destDir,
      { recoverInterruptedRuns: false },
    );
    await destStore.importRecoveryFile(bundlePath, authorizedRoot);
    const importedConversation = destStore.shellSnapshot().conversations[0]!;
    const importedDetail = destStore.conversationDetail(importedConversation.id)!;
    expect(importedDetail.messages[0]?.attachments[0]?.previewAnnotation).toEqual(previewAnnotation);
    destStore.close();
  });
});
