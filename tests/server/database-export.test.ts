import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import {
  readDatabaseRecoveryExportFile,
  writeDatabaseRecoveryExportFile,
} from "../../src/server/persistence/database-export-file";

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

describe("safe database recovery exports", () => {
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

  it("round-trips projects and messages under fresh identities", () => {
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
    const result = destination.importRecoveryData(serialized, authorizedRoot);
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
    expect(dirname(importedProject!.path)).toBe(realpathSync(authorizedRoot));
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
    const duplicate = destination.importRecoveryData(serialized, authorizedRoot);
    expect(duplicate).toEqual({
      projects: 1,
      conversations: 1,
      messages: 2,
      alreadyImported: true,
    });
    expect(destination.shellSnapshot().projects).toHaveLength(2);
    destination.close();
  });

  it("rejects malformed or extended exports before changing the database", () => {
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
    expect(() => store.importRecoveryData(JSON.stringify({
      ...valid,
      unexpected: "must be rejected",
    }), directory)).toThrow(/supported format/u);
    expect(() => store.importRecoveryData(JSON.stringify({
      ...valid,
      exportedAt: "not-an-iso-timestamp",
    }), directory)).toThrow(/supported format/u);
    expect(() => store.importRecoveryData(JSON.stringify({
      ...valid,
      projects: [{
        name: "unsafe path",
        path: "relative/project",
        conversations: [],
      }],
    }), directory)).toThrow(/supported format/u);
    expect(store.shellSnapshot()).toEqual(before);
    store.close();
  });

  it("removes newly created project directories when the database import rolls back", () => {
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

    expect(() => store.importRecoveryData(serialized, authorizedRoot))
      .toThrow("injected recovery import failure");
    expect(store.shellSnapshot().projects).toHaveLength(0);
    expect(readdirSync(authorizedRoot)).toEqual([]);
    store.close();
  });

  it("ignores hostile exported paths and full-access grants after folder authorization", () => {
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

    store.importRecoveryData(serialized, authorizedRoot);
    const snapshot = store.shellSnapshot();
    expect(snapshot.projects).toHaveLength(2);
    for (const project of snapshot.projects) {
      expect(dirname(project.path)).toBe(realpathSync(authorizedRoot));
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
