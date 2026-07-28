import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeStore } from "../../src/server/database";
import { getUnifiedDiff } from "../../src/server/git";
import { selectedReviewContext } from "../../src/server/runtime/commands/review-support";
import { parseUnifiedDiff } from "../../src/shared/diff-review";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("selected review context", () => {
  it("validates a file-scoped selection while retaining the full revision audit patch", async () => {
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
    writeFileSync(join(workspace, "selected.ts"), "export const selected = 1;\n");
    writeFileSync(join(workspace, "existing.ts"), "export const existing = 1;\n");
    execFileSync("git", ["add", "selected.ts", "existing.ts"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace });
    writeFileSync(join(workspace, "selected.ts"), "export const selected = 2;\n");
    writeFileSync(join(workspace, "existing.ts"), "export const existing = 2;\n");

    const store = new RuntimeStore(join(data, "inertia.sqlite"), workspace);
    const project = store.createProject("Review project", workspace);
    const conversation = store.createConversation(project.id, "Review");
    const selectedDiff = parseUnifiedDiff((await getUnifiedDiff(workspace, {
      paths: ["selected.ts"],
    })).text);
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
    }, "revision");

    expect(context.fingerprint).toBe(selectedDiff.fingerprint);
    expect(parseUnifiedDiff(context.patch).files.map(({ path }) => path).sort())
      .toEqual(["existing.ts", "selected.ts"]);
    expect(context.requestContext.diffSelections?.[0]?.path).toBe("selected.ts");
    store.close();
  });
});
