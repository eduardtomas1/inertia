import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  readDatabaseRecoveryExportFile,
  writeDatabaseRecoveryExportFile,
} from "../../src/server/persistence/database-export-file";
import { reconcileRecoveryImportJournal } from "../../src/server/persistence/database-recovery-import";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "inertia-database-export-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function seedInterruptedRecoveryImport(options: {
  authorizedRoot: string;
  databasePath: string;
  digest: string;
  operationId: string;
  phase: "staging" | "final";
  projects?: number;
}): string {
  const projects = options.projects ?? 2;
  const canonicalRoot = realpathSync(options.authorizedRoot);
  const rootMetadata = lstatSync(canonicalRoot, { bigint: true });
  const database = new Database(options.databasePath);
  database.prepare(`
    INSERT INTO recovery_import_journals (
      singleton, operation_id, digest, authorized_root,
      authorized_root_device, authorized_root_inode, projects, created_at
    ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    options.operationId,
    options.digest,
    canonicalRoot,
    rootMetadata.dev.toString(),
    rootMetadata.ino.toString(),
    projects,
    new Date().toISOString(),
  );
  database.close();
  const root = options.phase === "staging"
    ? join(options.authorizedRoot, `.inertia-recovery-${options.operationId}.partial`)
    : join(options.authorizedRoot, `recovered-${options.operationId}`);
  mkdirSync(root, { mode: 0o700 });
  for (let ordinal = 1; ordinal <= projects; ordinal += 1) {
    mkdirSync(join(root, `project-${String(ordinal).padStart(5, "0")}`), {
      mode: 0o700,
    });
  }
  return root;
}

function recoveryImportJournalCount(databasePath: string): number {
  const database = new Database(databasePath, { readonly: true });
  const result = (database.prepare(
    "SELECT COUNT(*) AS count FROM recovery_import_journals",
  ).get() as { count: number }).count;
  database.close();
  return result;
}

describe("safe database recovery exports", () => {
  it("revalidates the authorized root at every destructive cleanup boundary", () => {
    const dataDirectory = temporaryDirectory();
    const authorizedRoot = temporaryDirectory();
    const replacementRoot = join(dirname(authorizedRoot), `${Date.now()}-replacement`);
    const originalRoot = join(dirname(authorizedRoot), `${Date.now()}-original`);
    directories.push(replacementRoot, originalRoot);
    const databasePath = join(dataDirectory, "inertia.sqlite");
    const initialized = new RuntimeStore(databasePath, dataDirectory, {
      recoverInterruptedRuns: false,
    });
    initialized.close();
    const operationId = "66666666-6666-4666-8666-666666666666";
    seedInterruptedRecoveryImport({
      authorizedRoot,
      databasePath,
      digest: "d".repeat(64),
      operationId,
      phase: "final",
    });
    const database = new Database(databasePath);
    let raced = false;
    let replacementBlocked = false;
    let reconciliationError: unknown;
    try {
      reconcileRecoveryImportJournal(database, {
        operations: {
          beforeDelete: () => {
            if (raced) return;
            raced = true;
            try {
              renameSync(authorizedRoot, originalRoot);
            } catch (error) {
              replacementBlocked = true;
              throw new Error(
                "The pinned recovery root blocked pathname replacement.",
                { cause: error },
              );
            }
            mkdirSync(join(
              replacementRoot,
              `recovered-${operationId}`,
              "project-00001",
            ), { recursive: true, mode: 0o700 });
            writeFileSync(join(replacementRoot, "must-not-be-touched"), "external\n");
            renameSync(replacementRoot, authorizedRoot);
          },
        },
      });
    } catch (error) {
      reconciliationError = error;
    }
    expect(reconciliationError).toBeInstanceOf(Error);
    expect((reconciliationError as Error).message).toMatch(
      replacementBlocked
        ? /pinned recovery root blocked/u
        : /destination changed.*remains pending/u,
    );
    if (replacementBlocked) {
      expect(existsSync(join(
        authorizedRoot,
        `recovered-${operationId}`,
        "project-00001",
      ))).toBe(true);
    } else {
      expect(readdirSync(authorizedRoot).sort()).toEqual([
        "must-not-be-touched",
        `recovered-${operationId}`,
      ].sort());
      expect(existsSync(join(
        authorizedRoot,
        `recovered-${operationId}`,
        "project-00001",
      ))).toBe(true);
      expect(existsSync(join(originalRoot, `recovered-${operationId}`))).toBe(false);
    }
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM recovery_import_journals",
    ).get() as { count: number }).count).toBe(1);

    if (!replacementBlocked) {
      renameSync(authorizedRoot, replacementRoot);
      renameSync(originalRoot, authorizedRoot);
    }
    reconcileRecoveryImportJournal(database);
    expect(readdirSync(authorizedRoot)).toEqual([]);
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM recovery_import_journals",
    ).get() as { count: number }).count).toBe(0);
    if (!replacementBlocked) {
      expect(readdirSync(replacementRoot).sort()).toEqual([
        "must-not-be-touched",
        `recovered-${operationId}`,
      ].sort());
    }
    database.close();
  });

  it("rejects reconstructed stream chunks in the bounded preflight", () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const source = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
      recoveryExportMaxBytes: 8_000,
    });
    const project = source.createProject("Chunked export", directory);
    const conversation = source.createConversation(project.id, "Chunked export");
    const message = source.createMessage(
      conversation.id,
      "prefix:",
      "assistant",
    );
    source.appendMessageContent(message.id, "a".repeat(1_200));
    source.appendMessageContent(message.id, "😀".repeat(400));

    expect(() => source.exportRecoveryData()).toThrow(/safe size limit/u);
    source.close();

    const reopened = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    const exported = JSON.parse(reopened.exportRecoveryData()) as {
      projects: Array<{
        conversations: Array<{
          messages: Array<{ content: string }>;
        }>;
      }>;
    };
    expect(exported.projects[0]?.conversations[0]?.messages[0]?.content)
      .toBe(`prefix:${"a".repeat(1_200)}${"😀".repeat(400)}`);
    reopened.close();
  });

  it("round-trips projects and messages under fresh identities", async () => {
    const sourceDirectory = temporaryDirectory();
    const source = new RuntimeStore(
      join(sourceDirectory, "inertia.sqlite"),
      sourceDirectory,
      { recoverInterruptedRuns: false },
    );
    const project = source.createProject("Exported project", sourceDirectory);
    const conversation = source.createConversation(project.id, "Exported chat", {
      providerId: "claude",
      model: "claude-test",
      reasoningEffort: "high",
      interactionMode: "plan",
      accessMode: "full",
    });
    source.createMessage(
      conversation.id,
      "Inspect recovery.",
      "user",
      [{
        id: "11111111-1111-4111-8111-111111111111",
        name: "private.pdf",
        path: "/private/attachment/private.pdf",
        mimeType: "application/pdf",
        size: 42,
      }],
      null,
      "2026-01-02T03:04:05.000Z",
    );
    source.createMessage(
      conversation.id,
      "Recovery is ready.",
      "assistant",
      [],
      null,
      "2026-01-02T03:04:06.000Z",
    );
    const detail = vi.spyOn(source, "conversationDetail");
    const serialized = source.exportRecoveryData();
    expect(detail).not.toHaveBeenCalled();
    source.close();

    expect(serialized).not.toContain("private.pdf");
    expect(serialized).not.toContain("11111111-1111-4111-8111-111111111111");
    expect(serialized).not.toContain("providerSessionId");
    expect(serialized).not.toContain("secretReference");
    expect(serialized).not.toContain("credential");

    const destinationDirectory = temporaryDirectory();
    const destination = new RuntimeStore(
      join(destinationDirectory, "inertia.sqlite"),
      destinationDirectory,
      { recoverInterruptedRuns: false },
    );
    const existingProject = destination.createProject(
      "Existing project",
      destinationDirectory,
    );
    const existingConversation = destination.createConversation(
      existingProject.id,
      "Existing chat",
    );
    const authorizedRoot = temporaryDirectory();
    const result = await destination.importRecoveryData(serialized, authorizedRoot);
    expect(result).toEqual({
      projects: 1,
      conversations: 1,
      messages: 2,
      alreadyImported: false,
    });
    const snapshot = destination.shellSnapshot();
    expect(snapshot.activeProjectId).toBe(existingProject.id);
    expect(snapshot.activeConversationId).toBe(existingConversation.id);
    const importedProject = snapshot.projects.find(
      ({ name }) => name === "Exported project",
    );
    const importedConversation = snapshot.conversations.find(
      ({ title }) => title === "Exported chat",
    );
    expect(importedProject?.id).not.toBe(project.id);
    expect(dirname(dirname(importedProject!.path))).toBe(realpathSync(authorizedRoot));
    expect(realpathSync(importedProject!.path)).toBe(importedProject!.path);
    expect(importedProject?.path).not.toBe(sourceDirectory);
    expect(importedConversation?.id).not.toBe(conversation.id);
    expect(importedConversation).toMatchObject({
      projectId: importedProject?.id,
      providerId: "claude",
      model: "claude-test",
      reasoningEffort: "high",
      interactionMode: "plan",
      accessMode: "supervised",
    });
    expect(destination.conversationDetail(importedConversation!.id)?.messages)
      .toMatchObject([
        {
          role: "user",
          content: "Inspect recovery.",
          attachments: [],
          createdAt: "2026-01-02T03:04:05.000Z",
        },
        {
          role: "assistant",
          content: "Recovery is ready.",
          attachments: [],
          createdAt: "2026-01-02T03:04:06.000Z",
        },
      ]);
    const duplicate = await destination.importRecoveryData(serialized, authorizedRoot);
    expect(duplicate).toEqual({
      projects: 1,
      conversations: 1,
      messages: 2,
      alreadyImported: true,
    });
    expect(destination.shellSnapshot().projects).toHaveLength(2);
    destination.close();
  });

  it("rejects malformed or extended exports before changing the database", async () => {
    const directory = temporaryDirectory();
    const store = new RuntimeStore(
      join(directory, "inertia.sqlite"),
      directory,
      { recoverInterruptedRuns: false },
    );
    const before = store.shellSnapshot();
    const valid = {
      format: "inertia-recovery-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: [],
    };
    await expect(store.importRecoveryData(JSON.stringify({
      ...valid,
      unexpected: "must be rejected",
    }), directory)).rejects.toThrow(/supported format/u);
    await expect(store.importRecoveryData(JSON.stringify({
      ...valid,
      exportedAt: "not-an-iso-timestamp",
    }), directory)).rejects.toThrow(/supported format/u);
    await expect(store.importRecoveryData(JSON.stringify({
      ...valid,
      projects: [{
        name: "unsafe path identity",
        path: "relative/\0project",
        conversations: [],
      }],
    }), directory)).rejects.toThrow(/supported format/u);
    expect(store.shellSnapshot()).toEqual(before);
    store.close();
  });

  it.each([
    ["Windows", "C:\\Users\\Alice\\portable-project"],
    ["POSIX", "/home/alice/portable-project"],
  ])("imports %s source paths as unused informational identity", async (_sourceOs, sourcePath) => {
    const dataDirectory = temporaryDirectory();
    const authorizedRoot = temporaryDirectory();
    const store = new RuntimeStore(
      join(dataDirectory, "inertia.sqlite"),
      dataDirectory,
      { recoverInterruptedRuns: false },
    );
    const serialized = JSON.stringify({
      format: "inertia-recovery-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: [{
        name: "Portable source",
        path: sourcePath,
        conversations: [],
      }],
    });

    await store.importRecoveryData(serialized, authorizedRoot);
    const importedPath = store.shellSnapshot().projects[0]!.path;
    expect(dirname(dirname(importedPath))).toBe(realpathSync(authorizedRoot));
    expect(importedPath).not.toBe(sourcePath);
    expect(existsSync(importedPath)).toBe(true);
    store.close();
  });

  it("rejects imports into an FK-invalid database and rolls back created records and folders", async () => {
    const dataDirectory = temporaryDirectory();
    const authorizedRoot = temporaryDirectory();
    const databasePath = join(dataDirectory, "inertia.sqlite");
    const store = new RuntimeStore(databasePath, dataDirectory, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Existing", dataDirectory);
    const conversation = store.createConversation(project.id, "Existing");
    store.createMessage(conversation.id, "orphaned", "user");
    const tamper = new Database(databasePath);
    tamper.pragma("foreign_keys = OFF");
    tamper.prepare(
      "UPDATE messages SET conversation_id = 'missing-conversation'",
    ).run();
    tamper.close();
    const serialized = JSON.stringify({
      format: "inertia-recovery-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: [{
        name: "Must roll back",
        path: "C:\\informational\\source",
        conversations: [],
      }],
    });

    await expect(store.importRecoveryData(serialized, authorizedRoot))
      .rejects.toThrow(/invalid relationships/u);
    expect(store.shellSnapshot().projects.map(({ name }) => name))
      .toEqual(["Existing"]);
    expect(readdirSync(authorizedRoot)).toEqual([]);
    store.close();
  });

  it.each([
    ["project", "DELETE FROM projects"],
    ["conversation", "DELETE FROM conversations"],
    ["message", "UPDATE messages SET conversation_id = 'missing-conversation'"],
  ])("rejects exports containing an orphaned %s relationship", (_kind, statement) => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, "inertia.sqlite");
    const store = new RuntimeStore(databasePath, directory, {
      recoverInterruptedRuns: false,
    });
    const project = store.createProject("Orphan source", directory);
    const conversation = store.createConversation(project.id, "Orphan source");
    store.createMessage(conversation.id, "must not disappear", "user");
    const tamper = new Database(databasePath);
    tamper.pragma("foreign_keys = OFF");
    tamper.exec(statement);
    tamper.close();

    expect(() => store.exportRecoveryData()).toThrow(/invalid relationships/u);
    store.close();
  });

  it("removes newly created project directories when the database import rolls back", async () => {
    const dataDirectory = temporaryDirectory();
    const authorizedRoot = temporaryDirectory();
    const databasePath = join(dataDirectory, "inertia.sqlite");
    const store = new RuntimeStore(databasePath, dataDirectory, {
      recoverInterruptedRuns: false,
    });
    const injected = new Database(databasePath);
    injected.exec(`
      CREATE TRIGGER fail_recovery_project_insert
      BEFORE INSERT ON projects
      BEGIN
        SELECT RAISE(ABORT, 'injected recovery import failure');
      END;
    `);
    injected.close();
    const serialized = JSON.stringify({
      format: "inertia-recovery-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: [{
        name: "Rollback project",
        path: process.platform === "win32" ? "C:\\source" : "/source",
        conversations: [],
      }],
    });

    await expect(store.importRecoveryData(serialized, authorizedRoot))
      .rejects.toThrow("injected recovery import failure");
    expect(store.shellSnapshot().projects).toHaveLength(0);
    expect(readdirSync(authorizedRoot)).toEqual([]);
    store.close();
  });

  it("reconciles staged directories after forced worker death before retrying", async () => {
    const dataDirectory = temporaryDirectory();
    const authorizedRoot = temporaryDirectory();
    const databasePath = join(dataDirectory, "inertia.sqlite");
    const initialized = new RuntimeStore(databasePath, dataDirectory, {
      recoverInterruptedRuns: false,
    });
    initialized.close();
    const operationId = "11111111-1111-4111-8111-111111111111";
    const digest = "a".repeat(64);
    const script = `
      const Database = require("better-sqlite3");
      const { lstatSync, mkdirSync } = require("node:fs");
      const { join } = require("node:path");
      const [databasePath, authorizedRoot, operationId, digest] = process.argv.slice(1);
      const database = new Database(databasePath);
      const rootMetadata = lstatSync(authorizedRoot, { bigint: true });
      database.prepare(\`
        INSERT INTO recovery_import_journals (
          singleton, operation_id, digest, authorized_root,
          authorized_root_device, authorized_root_inode, projects, created_at
        ) VALUES (1, ?, ?, ?, ?, ?, 3, ?)
      \`).run(
        operationId,
        digest,
        authorizedRoot,
        rootMetadata.dev.toString(),
        rootMetadata.ino.toString(),
        new Date().toISOString(),
      );
      const staging = join(authorizedRoot, \`.inertia-recovery-\${operationId}.partial\`);
      mkdirSync(staging, { mode: 0o700 });
      for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
        mkdirSync(join(staging, \`project-\${String(ordinal).padStart(5, "0")}\`), {
          mode: 0o700,
        });
      }
      process.stdout.write("staged\\n");
      setInterval(() => {}, 1000);
    `;
    const child = spawn(
      process.execPath,
      ["-e", script, databasePath, realpathSync(authorizedRoot), operationId, digest],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout!.once("data", () => resolve());
    });
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(readdirSync(authorizedRoot)).toEqual([
      `.inertia-recovery-${operationId}.partial`,
    ]);

    const restarted = new RuntimeStore(databasePath, dataDirectory, {
      recoverInterruptedRuns: false,
    });
    expect(readdirSync(authorizedRoot)).toEqual([]);
    const serialized = JSON.stringify({
      format: "inertia-recovery-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: Array.from({ length: 3 }, (_unused, index) => ({
        name: `Recovered ${index + 1}`,
        path: `/informational/project-${index + 1}`,
        conversations: [],
      })),
    });
    const result = await restarted.importRecoveryData(
      serialized,
      authorizedRoot,
      { operationId: "22222222-2222-4222-8222-222222222222" },
    );
    expect(result).toMatchObject({ projects: 3, alreadyImported: false });
    expect(restarted.shellSnapshot().projects.every(
      ({ path }) => existsSync(path),
    )).toBe(true);
    expect(readdirSync(authorizedRoot)).toEqual([
      "recovered-22222222-2222-4222-8222-222222222222",
    ]);
    restarted.close();
    const database = new Database(databasePath, { readonly: true });
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM recovery_import_journals",
    ).get() as { count: number }).count).toBe(0);
    database.close();
  });

  it("retains an interrupted import journal while its canonical root is missing", () => {
    const dataDirectory = temporaryDirectory();
    const destinationContainer = temporaryDirectory();
    const authorizedRoot = join(destinationContainer, "authorized");
    const unavailableRoot = join(destinationContainer, "authorized-unavailable");
    mkdirSync(authorizedRoot, { mode: 0o700 });
    const databasePath = join(dataDirectory, "inertia.sqlite");
    const initialized = new RuntimeStore(databasePath, dataDirectory, {
      recoverInterruptedRuns: false,
    });
    initialized.close();
    const operationId = "44444444-4444-4444-8444-444444444444";
    const interruptedRoot = seedInterruptedRecoveryImport({
      authorizedRoot,
      databasePath,
      digest: "b".repeat(64),
      operationId,
      phase: "staging",
    });
    renameSync(authorizedRoot, unavailableRoot);

    expect(() => new RuntimeStore(databasePath, dataDirectory, {
      recoverInterruptedRuns: false,
    })).toThrow(/destination is unavailable.*remains pending/u);
    expect(recoveryImportJournalCount(databasePath)).toBe(1);
    expect(existsSync(interruptedRoot)).toBe(false);
    expect(existsSync(join(
      unavailableRoot,
      `.inertia-recovery-${operationId}.partial`,
    ))).toBe(true);

    renameSync(unavailableRoot, authorizedRoot);
    const restarted = new RuntimeStore(databasePath, dataDirectory, {
      recoverInterruptedRuns: false,
    });
    expect(readdirSync(authorizedRoot)).toEqual([]);
    expect(recoveryImportJournalCount(databasePath)).toBe(0);
    restarted.close();
  });

  it("retains an interrupted import journal for a same-path root replacement", () => {
    const dataDirectory = temporaryDirectory();
    const destinationContainer = temporaryDirectory();
    const authorizedRoot = join(destinationContainer, "authorized");
    const originalRoot = join(destinationContainer, "authorized-original");
    mkdirSync(authorizedRoot, { mode: 0o700 });
    const databasePath = join(dataDirectory, "inertia.sqlite");
    const initialized = new RuntimeStore(databasePath, dataDirectory, {
      recoverInterruptedRuns: false,
    });
    initialized.close();
    const operationId = "66666666-6666-4666-8666-666666666666";
    seedInterruptedRecoveryImport({
      authorizedRoot,
      databasePath,
      digest: "d".repeat(64),
      operationId,
      phase: "staging",
    });
    renameSync(authorizedRoot, originalRoot);
    mkdirSync(authorizedRoot, { mode: 0o700 });
    writeFileSync(join(authorizedRoot, "underlying-mount-marker"), "external\n");

    expect(() => new RuntimeStore(databasePath, dataDirectory, {
      recoverInterruptedRuns: false,
    })).toThrow(/destination changed.*remains pending/u);
    expect(recoveryImportJournalCount(databasePath)).toBe(1);
    expect(readdirSync(authorizedRoot)).toEqual(["underlying-mount-marker"]);
    expect(existsSync(join(
      originalRoot,
      `.inertia-recovery-${operationId}.partial`,
    ))).toBe(true);

    rmSync(authorizedRoot, { recursive: true });
    renameSync(originalRoot, authorizedRoot);
    const restarted = new RuntimeStore(databasePath, dataDirectory, {
      recoverInterruptedRuns: false,
    });
    expect(readdirSync(authorizedRoot)).toEqual([]);
    expect(recoveryImportJournalCount(databasePath)).toBe(0);
    restarted.close();
  });

  it("retains an interrupted import journal across a symlink replacement", () => {
    const dataDirectory = temporaryDirectory();
    const destinationContainer = temporaryDirectory();
    const authorizedRoot = join(destinationContainer, "authorized");
    const originalRoot = join(destinationContainer, "authorized-original");
    const replacementRoot = join(destinationContainer, "replacement");
    mkdirSync(authorizedRoot, { mode: 0o700 });
    mkdirSync(replacementRoot, { mode: 0o700 });
    writeFileSync(join(replacementRoot, "must-not-be-touched"), "external\n");
    const databasePath = join(dataDirectory, "inertia.sqlite");
    const initialized = new RuntimeStore(databasePath, dataDirectory, {
      recoverInterruptedRuns: false,
    });
    initialized.close();
    const operationId = "55555555-5555-4555-8555-555555555555";
    seedInterruptedRecoveryImport({
      authorizedRoot,
      databasePath,
      digest: "c".repeat(64),
      operationId,
      phase: "final",
    });
    renameSync(authorizedRoot, originalRoot);
    symlinkSync(
      replacementRoot,
      authorizedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(() => new RuntimeStore(databasePath, dataDirectory, {
      recoverInterruptedRuns: false,
    })).toThrow(/destination changed.*remains pending/u);
    expect(recoveryImportJournalCount(databasePath)).toBe(1);
    expect(readdirSync(replacementRoot)).toEqual(["must-not-be-touched"]);
    expect(existsSync(join(originalRoot, `recovered-${operationId}`))).toBe(true);

    unlinkSync(authorizedRoot);
    renameSync(originalRoot, authorizedRoot);
    const restarted = new RuntimeStore(databasePath, dataDirectory, {
      recoverInterruptedRuns: false,
    });
    expect(readdirSync(authorizedRoot)).toEqual([]);
    expect(recoveryImportJournalCount(databasePath)).toBe(0);
    expect(readdirSync(replacementRoot)).toEqual(["must-not-be-touched"]);
    restarted.close();
  });

  it("cancels asynchronous directory staging and removes the durable journal", async () => {
    const dataDirectory = temporaryDirectory();
    const authorizedRoot = temporaryDirectory();
    const databasePath = join(dataDirectory, "inertia.sqlite");
    const store = new RuntimeStore(databasePath, dataDirectory, {
      recoverInterruptedRuns: false,
    });
    const controller = new AbortController();
    let stagingStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      stagingStarted = resolve;
    });
    const injectedMkdir = (async (
      path: Parameters<typeof mkdir>[0],
      options: Parameters<typeof mkdir>[1],
    ) => {
      const result = await mkdir(path, options);
      if (String(path).endsWith("project-00001")) {
        stagingStarted();
        await new Promise<void>((_resolve, reject) => {
          const cancel = () => reject(controller.signal.reason);
          if (controller.signal.aborted) cancel();
          else controller.signal.addEventListener("abort", cancel, { once: true });
        });
      }
      return result;
    }) as typeof mkdir;
    const serialized = JSON.stringify({
      format: "inertia-recovery-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: Array.from({ length: 20 }, (_unused, index) => ({
        name: `Cancelled ${index + 1}`,
        path: `/informational/cancelled-${index + 1}`,
        conversations: [],
      })),
    });
    const pending = store.importRecoveryData(serialized, authorizedRoot, {
      signal: controller.signal,
      operationId: "33333333-3333-4333-8333-333333333333",
      operations: { mkdir: injectedMkdir },
    });
    await started;
    controller.abort(new Error("cancel staged import"));

    await expect(pending).rejects.toThrow("cancel staged import");
    expect(store.shellSnapshot().projects).toHaveLength(0);
    expect(readdirSync(authorizedRoot)).toEqual([]);
    store.close();
    const database = new Database(databasePath, { readonly: true });
    expect((database.prepare(
      "SELECT COUNT(*) AS count FROM recovery_import_journals",
    ).get() as { count: number }).count).toBe(0);
    database.close();
  });

  it("ignores hostile exported paths and full-access grants after folder authorization", async () => {
    const dataDirectory = temporaryDirectory();
    const authorizedRoot = temporaryDirectory();
    const store = new RuntimeStore(
      join(dataDirectory, "inertia.sqlite"),
      dataDirectory,
      { recoverInterruptedRuns: false },
    );
    const conversation = {
      title: "Untrusted authority",
      providerId: "codex",
      model: "gpt-test",
      reasoningEffort: "high",
      interactionMode: "build",
      accessMode: "full",
      messages: [],
    } as const;
    const serialized = JSON.stringify({
      format: "inertia-recovery-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      projects: [
        {
          name: "Filesystem root",
          path: process.platform === "win32" ? "C:\\" : "/",
          conversations: [conversation],
        },
        {
          name: "Application data",
          path: dataDirectory,
          conversations: [conversation],
        },
      ],
    });

    await store.importRecoveryData(serialized, authorizedRoot);
    const snapshot = store.shellSnapshot();
    expect(snapshot.projects).toHaveLength(2);
    for (const project of snapshot.projects) {
      expect(dirname(dirname(project.path))).toBe(realpathSync(authorizedRoot));
      expect(project.path).not.toBe(dataDirectory);
      expect(project.path).not.toBe(process.platform === "win32" ? "C:\\" : "/");
    }
    expect(snapshot.conversations.every(
      ({ accessMode }) => accessMode === "supervised",
    )).toBe(true);
    store.close();
  });

  it("writes atomically and rejects symlink import/export targets", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "recovery.json");
    const content = "{\"safe\":true}\n";
    await writeDatabaseRecoveryExportFile(path, content);
    expect(await readDatabaseRecoveryExportFile(path)).toBe(content);
    expect(readFileSync(path, "utf8")).toBe(content);

    const target = join(directory, "target.json");
    const link = join(directory, "link.json");
    writeFileSync(target, content);
    symlinkSync(target, link);
    await expect(readDatabaseRecoveryExportFile(link))
      .rejects.toThrow(/unavailable/u);
    await expect(writeDatabaseRecoveryExportFile(link, content))
      .rejects.toThrow(/not a local file/u);
  });

  it("cancels an in-flight recovery import read before any database mutation", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "recovery.json");
    writeFileSync(path, "{\"projects\":[]}");
    const controller = new AbortController();
    let reading = false;
    const injectedReadFile = ((_path: unknown, options: { signal?: AbortSignal }) => {
      reading = true;
      return new Promise<string>((_resolve, reject) => {
        options.signal?.addEventListener(
          "abort",
          () => reject(options.signal!.reason),
          { once: true },
        );
      });
    }) as typeof readFile;
    const readingFile = readDatabaseRecoveryExportFile(path, {
      signal: controller.signal,
      operations: { readFile: injectedReadFile },
    });
    await vi.waitFor(() => expect(reading).toBe(true));
    controller.abort(new Error("cancel import read"));

    await expect(readingFile).rejects.toThrow("cancel import read");
  });

  it.each(["writeFile", "sync", "close"] as const)(
    "removes transcript partials after an injected %s failure",
    async (phase) => {
      const directory = temporaryDirectory();
      const path = join(directory, "recovery.json");
      const injectedOpen = (async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        return new Proxy(handle, {
          get(target, property, receiver) {
            if (property !== phase) {
              const value = Reflect.get(target, property, receiver);
              return typeof value === "function" ? value.bind(target) : value;
            }
            if (phase === "close") {
              return async () => {
                await target.close();
                throw new Error(`injected ${phase} failure`);
              };
            }
            return async () => {
              throw new Error(`injected ${phase} failure`);
            };
          },
        });
      }) as typeof open;

      await expect(writeDatabaseRecoveryExportFile(path, "secret transcript", {
        operations: { open: injectedOpen },
      })).rejects.toThrow(`injected ${phase} failure`);
      expect(existsSync(path)).toBe(false);
      expect(readdirSync(directory).filter((entry) => entry.endsWith(".partial")))
        .toEqual([]);
    },
  );

  it("removes a partial when an active export is cancelled", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "recovery.json");
    const cancellation = new AbortController();
    const injectedOpen = (async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property !== "writeFile") {
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async () => new Promise<void>((_resolve, reject) => {
            cancellation.signal.addEventListener(
              "abort",
              () => reject(cancellation.signal.reason),
              { once: true },
            );
          });
        },
      });
    }) as typeof open;
    const writing = writeDatabaseRecoveryExportFile(path, "secret transcript", {
      signal: cancellation.signal,
      operations: { open: injectedOpen },
    });
    await vi.waitFor(() => expect(
      readdirSync(directory).some((entry) => entry.endsWith(".partial")),
    ).toBe(true));
    cancellation.abort(new Error("injected shutdown cancellation"));

    await expect(writing).rejects.toThrow("injected shutdown cancellation");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(directory).filter((entry) => entry.endsWith(".partial")))
      .toEqual([]);
  });
});
