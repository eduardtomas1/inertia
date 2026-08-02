import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
});
