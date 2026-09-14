import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { getUnifiedDiff } from "../../src/server/git";
import { assembleReadOnlyReviewRequest, selectedReviewContext } from "../../src/server/runtime/commands/review-support";
import type { RuntimeSecureFileBroker } from "../../src/server/secure-files";
import { parseUnifiedDiff } from "../../src/shared/diff-review";
import { turnRequestContextSchema } from "../../src/shared/contracts/client-command/common";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("selected review context", () => {
  it("stops before repository inspection when the selection is cancelled", async () => {
    const root = mkdtempSync(join(tmpdir(), "inertia-review-cancel-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const data = join(root, "data");
    mkdirSync(workspace);
    mkdirSync(data);
    const store = new RuntimeStore(join(data, "inertia.sqlite"), workspace);
    const project = store.createProject("Review project", workspace);
    const conversation = store.createConversation(project.id, "Review");
    const controller = new AbortController();
    controller.abort();

    await expect(selectedReviewContext(store, {
      projectId: project.id,
      conversationId: conversation.id,
      repositoryPath: ".",
      fingerprint: "a".repeat(64),
      filePath: "src/example.ts",
      hunkId: "hunk-1",
      lineIds: ["line-1"],
    }, "ask", {} as RuntimeSecureFileBroker, controller.signal))
      .rejects.toMatchObject({ code: "timeout" });
    store.close();
  });

  it.each([".", "app"])("validates a selection from workspace %s while retaining the full repository revision audit patch", async (workspaceFolder) => {
    const root = mkdtempSync(join(tmpdir(), "inertia-review-support-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const data = join(root, "data");
    mkdirSync(workspace);
    mkdirSync(data);
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "review@example.invalid"], {
      cwd: workspace,
    });
    execFileSync("git", ["config", "user.name", "Review Test"], {
      cwd: workspace,
    });
    writeFileSync(join(workspace, "existing.ts"), "export const existing = 1;\n");
    execFileSync("git", ["add", "existing.ts"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });
    const projectFolder = join(workspace, workspaceFolder);
    mkdirSync(projectFolder, { recursive: true });
    const selectedPath = workspaceFolder === "." ? "selected.ts" : `${workspaceFolder}/selected.ts`;
    writeFileSync(join(projectFolder, "selected.ts"), "export const selected = 2;\n");
    writeFileSync(join(workspace, "existing.ts"), "export const existing = 2;\n");
    const secureReads: string[] = [];
    const secureFiles: RuntimeSecureFileBroker = {
      authorizeRoot: (trustedRoot) => Promise.resolve({
        root: trustedRoot,
        identity: { dev: "1", ino: "1" },
        birthtimeNs: "1",
      }),
      verifyRoot: () => Promise.resolve(),
      read: (trustedRoot, path, maxBytes) => {
        const content = readFileSync(join(trustedRoot.root, path));
        expect(content.byteLength).toBeLessThanOrEqual(maxBytes);
        secureReads.push(path);
        return Promise.resolve({
          content,
          digest: "test-digest",
          size: content.byteLength,
          modifiedAt: new Date(0).toISOString(),
          mode: 0o100644,
        });
      },
      replace: () => Promise.reject(
        new Error("Unexpected secure file replace."),
      ),
    };

    const store = new RuntimeStore(join(data, "inertia.sqlite"), workspace);
    const project = store.createProject("Review project", projectFolder);
    const conversation = store.createConversation(project.id, "Review");
    const selectedDiff = parseUnifiedDiff((await getUnifiedDiff(workspace, {
      paths: [selectedPath],
    }, undefined, secureFiles)).text);
    const file = selectedDiff.files[0]!;
    const hunk = file.hunks[0]!;
    const context = await selectedReviewContext(store, {
      projectId: project.id,
      conversationId: conversation.id,
      repositoryPath: ".",
      fingerprint: selectedDiff.fingerprint,
      filePath: file.path,
      hunkId: hunk.id,
      lineIds: hunk.lines
        .filter(({ kind }) => kind === "addition" || kind === "deletion")
        .map(({ id }) => id),
    }, "revision", secureFiles);

    expect(context.fingerprint).toBe(selectedDiff.fingerprint);
    expect(parseUnifiedDiff(context.patch).files.map(({ path }) => path).sort())
      .toEqual(["existing.ts", selectedPath].sort());
    expect(context.requestContext.diffSelections?.[0]?.path).toBe("selected.ts");
    expect(secureReads).toEqual([
      selectedPath,
      selectedPath,
      selectedPath,
    ]);
    if (workspaceFolder !== ".") {
      const outside = parseUnifiedDiff((await getUnifiedDiff(workspace, { paths: ["existing.ts"] })).text);
      const outsideFile = outside.files[0]!;
      const outsideHunk = outsideFile.hunks[0]!;
      const selection = {
        projectId: project.id, conversationId: conversation.id, repositoryPath: ".",
        fingerprint: outside.fingerprint, filePath: outsideFile.path, hunkId: outsideHunk.id,
        lineIds: outsideHunk.lines.filter(({ kind }) => kind === "addition").map(({ id }) => id),
      };
      await expect(selectedReviewContext(store, selection, "revision", secureFiles))
        .rejects.toThrow("inside the project folder");
      const question = await selectedReviewContext(store, selection, "ask", secureFiles);
      expect(question.requestContext.diffSelections?.[0]?.path).toBe("../existing.ts");
      expect(question.requestContext.fileReferences).toBeUndefined();
      const context = turnRequestContextSchema.parse(question.requestContext);
      // Selected diff context contains captured text, not authority to read this path.
      rmSync(join(workspace, "existing.ts"));
      expect(assembleReadOnlyReviewRequest(projectFolder, question.visibleContent, context).executionPrompt)
        .toContain("../existing.ts");
    }
    store.close();
  });
});
