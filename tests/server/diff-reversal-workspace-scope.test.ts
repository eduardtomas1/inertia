import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getUnifiedDiff, inspectDiffSelection, revertDiffSelection, undoDiffSelection } from "../../src/server/git";
import type { ReversalWorkspaceScope } from "../../src/server/git/reversal-scope";
import { REVERSAL_REGISTRY_REF } from "../../src/server/reversal-registry";
import { createDiffReviewCommandHandler, type DiffReviewCommandDependencies } from "../../src/server/runtime/commands/diff-review-commands";
import { SecureFileAuthorityRegistry } from "../../src/server/runtime/secure-file-authorities";
import { clientCommandSchema, type DiffReversalOperation, type DiffReversalPlan, type ServerEvent } from "../../src/shared/contracts";
import { parseUnifiedDiff } from "../../src/shared/diff-review";
import { SecureFileTestBroker } from "../support/secure-file-test-broker";

const roots: string[] = [];
const secureFiles = new SecureFileTestBroker();
const projectId = "11111111-1111-4111-8111-111111111111";
const before = "before\n";
const after = "after\n";
const git = (root: string, ...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "inertia-reversal-scope-"));
  roots.push(root);
  const workspace = join(root, "app");
  mkdirSync(workspace);
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Inertia Test");
  git(root, "config", "user.email", "test@inertia.invalid");
  writeFileSync(join(root, "README.md"), before);
  writeFileSync(join(workspace, "README.md"), before);
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  return { root, workspace };
}

async function selectionFor(root: string, filePath: string) {
  const diff = parseUnifiedDiff((await getUnifiedDiff(root)).text);
  const hunk = diff.files.find((file) => file.path === filePath)!.hunks[0]!;
  return {
    fingerprint: diff.fingerprint, filePath, hunkId: hunk.id,
    lineIds: hunk.lines.filter((line) => line.kind === "addition" || line.kind === "deletion").map((line) => line.id),
  };
}

async function scopeFor(workspace: string): Promise<ReversalWorkspaceScope> {
  const root = await secureFiles.authorizeRoot(workspace);
  return { root, verifyContext: () => secureFiles.verifyRoot(root) };
}

function commands(initialWorkspace: string, repositoryPath = ".") {
  let workspace = initialWorkspace;
  const send = vi.fn<(socket: WebSocket, event: ServerEvent) => void>();
  const socket = {} as WebSocket;
  const handler = createDiffReviewCommandHandler({
    store: { hasActiveWorkspaceRunForConversation: () => false },
    workspaceRuns: { trackSourceControl: (_label: string, _id: string, _conversation: string | undefined, _root: string, _request: string, operation: () => Promise<unknown>) => operation() },
    secureFiles,
    secureFileAuthorities: new SecureFileAuthorityRegistry(secureFiles),
    workspacePath: () => workspace,
    broadcastSnapshot: vi.fn(), send,
  } as unknown as DiffReviewCommandDependencies);
  return {
    setWorkspace: (path: string) => { workspace = path; },
    async request(type: "git.selection.inspect" | "git.selection.revert" | "git.selection.undo", payload: Record<string, unknown>) {
      const requestId = randomUUID();
      await handler(socket, clientCommandSchema.parse({ type, requestId, payload: { projectId, repositoryPath, ...payload } }));
      const event = send.mock.calls.find(([, event]) => event.type === "request.result" && event.requestId === requestId)?.[1];
      if (!event || event.type !== "request.result") throw new Error("Expected a command result");
      return event.result;
    },
  };
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("selective reversal workspace authority", () => {
  it("rejects parent-file inspection, application and stored undo without changing parent content", async () => {
    const { root, workspace } = fixture();
    writeFileSync(join(root, "README.md"), after);
    git(root, "add", "README.md");
    const selection = await selectionFor(root, "README.md");
    const command = commands(workspace);
    await expect(command.request("git.selection.inspect", selection)).rejects.toThrow(/inside the project folder/);

    // A plan and a persisted operation created with wider authority must not be
    // reusable by the narrower project, even when their Git state still matches.
    const repository = await secureFiles.authorizeRoot(root);
    const workspaceScope = await scopeFor(workspace);
    const plan = await inspectDiffSelection(root, selection, secureFiles, repository);
    await expect(revertDiffSelection(root, { ...selection, expected: plan.validation }, secureFiles, undefined, repository, workspaceScope))
      .rejects.toThrow(/inside the project folder/);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe(after);
    expect(git(root, "show", ":README.md")).toBe(after);
    const reversed = await revertDiffSelection(root, { ...selection, expected: plan.validation }, secureFiles, undefined, repository);
    await expect(undoDiffSelection(root, reversed.operation.id, secureFiles, repository, workspaceScope))
      .rejects.toThrow(/inside the project folder/);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe(before);
    expect(git(root, "show", ":README.md")).toBe(before);
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe(before);
  });

  it.each(["subfolder", "root", "nested", "linked"] as const)("reverts and undoes an in-project staged selection for a %s repository", async (kind) => {
    const fixturePaths = fixture();
    let { root, workspace } = fixturePaths;
    let repositoryPath = ".";
    if (kind === "root") workspace = root;
    if (kind === "nested") {
      const parent = mkdtempSync(join(tmpdir(), "inertia-reversal-parent-"));
      roots.push(parent);
      renameSync(root, join(parent, "repo"));
      root = join(parent, "repo");
      workspace = parent;
      repositoryPath = "repo";
    }
    if (kind === "linked") {
      const linked = join(root, "linked");
      git(root, "worktree", "add", "-qb", "linked", linked);
      root = linked;
      workspace = join(linked, "app");
    }
    writeFileSync(join(root, "app/README.md"), after);
    writeFileSync(join(root, "README.md"), "parent remains changed\n");
    git(root, "add", "app/README.md");
    const selection = await selectionFor(root, "app/README.md");
    const command = commands(workspace, repositoryPath);
    const inspected = await command.request("git.selection.inspect", selection);
    if (inspected.kind !== "git.reversal.plan") throw new Error("Expected a plan");
    const result = await command.request("git.selection.revert", { ...selection, expected: inspected.plan.validation, authorityRef: inspected.plan.authorityRef });
    if (result.kind !== "git.reversal") throw new Error("Expected a reversal");
    expect(readFileSync(join(root, "app/README.md"), "utf8")).toBe(before);
    expect(git(root, "show", ":app/README.md")).toBe(before);
    await command.request("git.selection.undo", { operationId: result.operation.id, authorityRef: result.operation.authorityRef });
    expect(readFileSync(join(root, "app/README.md"), "utf8")).toBe(after);
    expect(git(root, "show", ":app/README.md")).toBe(after);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("parent remains changed\n");
  });

  it.each(["revert", "undo"] as const)("rejects a retained %s receipt after replacing the project directory at the same path", async (action) => {
    const { root, workspace } = fixture();
    writeFileSync(join(workspace, "README.md"), after);
    const selection = await selectionFor(root, "app/README.md");
    const command = commands(workspace);
    const inspected = await command.request("git.selection.inspect", selection);
    if (inspected.kind !== "git.reversal.plan") throw new Error("Expected a plan");
    const plan: DiffReversalPlan = inspected.plan;
    let operation: DiffReversalOperation | undefined;
    if (action === "undo") {
      const result = await command.request("git.selection.revert", { ...selection, expected: plan.validation, authorityRef: plan.authorityRef });
      if (result.kind !== "git.reversal") throw new Error("Expected a reversal");
      operation = result.operation;
    }
    renameSync(workspace, join(root, "retained-app"));
    mkdirSync(workspace);
    // Identical bytes and Git paths cannot substitute for directory identity.
    const content = action === "undo" ? before : after;
    writeFileSync(join(workspace, "README.md"), content);
    await expect(command.request(action === "undo" ? "git.selection.undo" : "git.selection.revert", operation
      ? { operationId: operation.id, authorityRef: operation.authorityRef }
      : { ...selection, expected: plan.validation, authorityRef: plan.authorityRef }))
      .rejects.toThrow(/authorization expired/);
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe(content);
    expect(readFileSync(join(root, "retained-app/README.md"), "utf8")).toBe(content);
  });

  it("rejects a receipt after switching project context to a same-named sibling file", async () => {
    const { root, workspace } = fixture();
    writeFileSync(join(workspace, "README.md"), after);
    const selection = await selectionFor(root, "app/README.md");
    const command = commands(workspace);
    const inspected = await command.request("git.selection.inspect", selection);
    if (inspected.kind !== "git.reversal.plan") throw new Error("Expected a plan");
    const sibling = join(root, "sibling");
    mkdirSync(sibling);
    writeFileSync(join(sibling, "README.md"), after);
    command.setWorkspace(sibling);
    await expect(command.request("git.selection.revert", { ...selection, expected: inspected.plan.validation, authorityRef: inspected.plan.authorityRef }))
      .rejects.toThrow(/authorization expired/);
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe(after);
    expect(readFileSync(join(sibling, "README.md"), "utf8")).toBe(after);
  });

  it.each(["directory", "symlink"] as const)("does not write through a project %s substituted after backups are prepared", async (replacement) => {
    const { root, workspace } = fixture();
    writeFileSync(join(workspace, "README.md"), after);
    git(root, "add", "app/README.md");
    const selection = await selectionFor(root, "app/README.md");
    const repository = await secureFiles.authorizeRoot(root);
    const workspaceScope = await scopeFor(workspace);
    const plan = await inspectDiffSelection(root, selection, secureFiles, repository, workspaceScope);
    const outside = mkdtempSync(join(tmpdir(), "inertia-reversal-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "README.md"), after);
    await expect(revertDiffSelection(root, { ...selection, expected: plan.validation }, secureFiles, {
      afterBackupCreated: () => {
        renameSync(workspace, join(outside, "retained-app"));
        if (replacement === "symlink") symlinkSync(outside, workspace, process.platform === "win32" ? "junction" : "dir");
        else { mkdirSync(workspace); writeFileSync(join(workspace, "README.md"), after); }
      },
    }, repository, workspaceScope)).rejects.toThrow();
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe(after);
    expect(readFileSync(join(outside, "retained-app/README.md"), "utf8")).toBe(after);
    expect(readFileSync(join(outside, "README.md"), "utf8")).toBe(after);
    expect(git(root, "show", ":app/README.md")).toBe(after);
  });

  it("retains recovery backups instead of writing or rolling back through a replaced project folder", async () => {
    const { root, workspace } = fixture();
    writeFileSync(join(workspace, "README.md"), after);
    git(root, "add", "app/README.md");
    const selection = await selectionFor(root, "app/README.md");
    const repository = await secureFiles.authorizeRoot(root);
    const workspaceScope = await scopeFor(workspace);
    const plan = await inspectDiffSelection(root, selection, secureFiles, repository, workspaceScope);
    const retained = mkdtempSync(join(tmpdir(), "inertia-retained-project-"));
    roots.push(retained);
    await expect(revertDiffSelection(root, { ...selection, expected: plan.validation }, secureFiles, {
      afterIndexUpdated: () => {
        renameSync(workspace, join(retained, "app"));
        mkdirSync(workspace);
        writeFileSync(join(workspace, "README.md"), after);
      },
    }, repository, workspaceScope)).rejects.toThrow();
    expect(readFileSync(join(workspace, "README.md"), "utf8")).toBe(after);
    expect(readFileSync(join(retained, "app/README.md"), "utf8")).toBe(after);
    expect(git(root, "show", ":app/README.md")).toBe(before);
    const registry = JSON.parse(git(root, "cat-file", "blob", REVERSAL_REGISTRY_REF)) as { operations: Array<{ status: string }> };
    expect(registry.operations).toEqual([expect.objectContaining({ status: "recovery-required" })]);
    expect(git(root, "for-each-ref", "--format=%(refname)", "refs/inertia/reversal-backups")).not.toBe("");
  });

  it.each(["into", "out of"] as const)("keeps rename reversal unavailable for moves %s the project", async (direction) => {
    const { root, workspace } = fixture();
    const source = direction === "into" ? "README.md" : "app/README.md";
    const target = direction === "into" ? "app/moved.md" : "moved.md";
    const content = `${Array.from({ length: 25 }, (_, index) => `line ${index}`).join("\n")}\n`;
    writeFileSync(join(root, source), content);
    git(root, "add", source);
    git(root, "commit", "-qm", "rename source");
    git(root, "mv", source, target);
    writeFileSync(join(root, target), `${content}added\n`);
    git(root, "add", target);
    const staged = git(root, "diff", "--cached");
    const selection = await selectionFor(root, target);
    await expect(commands(workspace).request("git.selection.inspect", selection))
      .rejects.toThrow(direction === "into" ? /renamed|copies|copied|existing text/ : /inside the project folder/);
    expect(git(root, "diff", "--cached")).toBe(staged);
    expect(readFileSync(join(root, target), "utf8")).toBe(`${content}added\n`);
  });

  // File symlinks require a Windows privilege; directory-junction races above run everywhere.
  it.skipIf(process.platform === "win32")("rejects an in-project symlink to the changed parent file", async () => {
    const { root, workspace } = fixture();
    writeFileSync(join(root, "README.md"), after);
    const selection = await selectionFor(root, "README.md");
    rmSync(join(workspace, "README.md"));
    symlinkSync(join(root, "README.md"), join(workspace, "README.md"));
    await expect(commands(workspace).request("git.selection.inspect", { ...selection, filePath: "app/README.md" }))
      .rejects.toThrow(/outside|symlink|symbolic link/);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe(after);
  });
});
