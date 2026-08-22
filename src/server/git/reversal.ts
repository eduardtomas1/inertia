import { randomUUID } from "node:crypto";
import type {
  DiffLine,
  DiffReversalPlan,
  DiffReversalValidation,
} from "../../shared/contracts";
import { parseUnifiedDiff, sha256 } from "../../shared/diff-review";
import type {
  ReversalOperationRecord,
  ReversalRegistryController,
} from "../reversal-registry";
import {
  MAX_DIFF_BYTES,
  MAX_DIFF_FILES,
} from "./constants";
import {
  GitError,
  type GitDiffReversalResult,
  type GitDiffSelection,
  type GitUnifiedDiff,
} from "./types";
import {
  repositoryRoot,
  validatedPaths,
} from "./paths";
import {
  runGit,
} from "./runner";
import {
  getRepositoryStatus,
  hasHead,
} from "./status";
import { getUnifiedDiff } from "./diff";
import {
  bufferHash,
  fileStateMatches,
  hashObject,
  type IndexEntry,
  readIndexEntry,
  textBuffer,
  updateIndexEntry,
  writeAtomic,
} from "./reversal-files";
import {
  maintainReversalOperations,
  registryOperation,
  reversalController,
} from "./reversal-registry-adapter";
import { withReversalRepositoryLock } from "./reversal-lock";
import type {
  RuntimeSecureFileBroker,
  SecureFileRootCapability,
} from "../secure-files";

interface ReversalState {
  root: string;
  plan: DiffReversalPlan;
  headContent: Buffer;
  worktreeMode: number;
  worktreeContent: Buffer;
  index: IndexEntry;
  selectedWorktreeLines: DiffLine[];
  selectedIndexLines: DiffLine[];
}

async function completeRepositoryDiff(
  root: string,
  ignoreWhitespace = false,
  paths?: string[],
  secureFiles?: RuntimeSecureFileBroker,
  secureRoot?: SecureFileRootCapability,
): Promise<GitUnifiedDiff> {
  const diff = await getUnifiedDiff(root, {
    maxBytes: MAX_DIFF_BYTES,
    maxFiles: MAX_DIFF_FILES,
    ignoreWhitespace,
    paths,
  }, undefined, secureFiles, secureRoot);
  if (diff.truncated) {
    throw new GitError("output-limit", "The complete repository diff is too large to reverse safely. Narrow the change set first.");
  }
  return diff;
}

async function completeLayerPatch(root: string, layer: "index" | "worktree", path?: string, ignoreWhitespace = false): Promise<string> {
  const args = [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--full-index",
    "--unified=3",
    ...(ignoreWhitespace ? ["--ignore-all-space"] : []),
    ...(layer === "index" ? ["--cached", "HEAD"] : []),
    "--",
    ...(path ? [path] : []),
  ];
  try {
    const result = await runGit(root, args, {
      maxOutputBytes: MAX_DIFF_BYTES,
      failureMessage: `Unable to inspect the ${layer === "index" ? "Git index" : "working tree"}.`,
    });
    return result.stdout.toString("utf8");
  } catch (error) {
    if (error instanceof GitError && error.code === "output-limit") {
      throw new GitError("output-limit", "The staged or unstaged diff is too large to reverse safely. Narrow the change set first.");
    }
    throw error;
  }
}

async function repositoryStateFingerprint(
  root: string,
  secureFiles: RuntimeSecureFileBroker,
  secureRoot: SecureFileRootCapability,
): Promise<string> {
  const [combined, staged, unstaged, status] = await Promise.all([
    completeRepositoryDiff(
      root,
      false,
      undefined,
      secureFiles,
      secureRoot,
    ),
    completeLayerPatch(root, "index"),
    completeLayerPatch(root, "worktree"),
    runGit(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"], {
      maxOutputBytes: MAX_DIFF_BYTES,
      failureMessage: "Unable to validate the repository state.",
    }),
  ]);
  return sha256([
    combined.text,
    staged,
    unstaged,
    status.stdout.toString("utf8"),
  ].join("\0"));
}

function selectedLineSignature(line: DiffLine): string {
  if (line.kind === "deletion") return `deletion\0${line.oldLineNumber ?? -1}\0${line.content}`;
  return `addition\0${line.oldInsertionIndex}\0${line.content}`;
}

interface ReversalTextLine {
  content: string;
  ending: "" | "\n" | "\r\n";
}

function reversalTextLines(text: string): ReversalTextLine[] {
  const lines: ReversalTextLine[] = [];
  let start = 0;
  while (true) {
    const newline = text.indexOf("\n", start);
    if (newline < 0) break;
    const raw = text.slice(start, newline);
    const crlf = raw.endsWith("\r");
    lines.push({
      content: crlf ? raw.slice(0, -1) : raw,
      ending: crlf ? "\r\n" : "\n",
    });
    start = newline + 1;
  }
  if (start < text.length) lines.push({ content: text.slice(start), ending: "" });
  return lines;
}

function adjacentLineEnding(
  lines: readonly ReversalTextLine[],
  index: number,
): "\n" | "\r\n" {
  const next = lines[index]?.ending;
  if (next) return next;
  const previous = lines[index - 1]?.ending;
  return previous || "\n";
}

function deletedLineEnding(
  original: readonly ReversalTextLine[],
  line: DiffLine,
  current: readonly ReversalTextLine[],
  insertionIndex: number,
): "" | "\n" | "\r\n" {
  if (line.noFinalNewline) return "";
  const originalLine = line.oldLineNumber === null
    ? undefined
    : original[line.oldLineNumber - 1];
  if (originalLine?.content === line.content && originalLine.ending) {
    return originalLine.ending;
  }
  return adjacentLineEnding(current, insertionIndex);
}

function reversalText(
  source: Buffer,
  selected: readonly DiffLine[],
  originalSource: Buffer = source,
): Buffer {
  const text = textBuffer(source);
  if (text.includes("\0")) throw new GitError("invalid-input", "Binary files cannot be reverted by selection.");
  const fileLines = reversalTextLines(text);
  const originalLines = reversalTextLines(textBuffer(originalSource));

  const ordered = selected
    .map((line, order) => ({
      line,
      order,
      position: line.kind === "addition" ? (line.newLineNumber ?? 1) - 1 : line.newInsertionIndex,
    }))
    .sort((left, right) => left.position - right.position || left.order - right.order)
    .map(({ line }) => line);
  for (const line of ordered.reverse()) {
    if (line.kind === "addition") {
      const index = (line.newLineNumber ?? 0) - 1;
      if (
        index < 0
        || index >= fileLines.length
        || fileLines[index]?.content !== line.content
      ) {
        throw new GitError("conflict", "The selected lines no longer match the file or Git layer. Refresh the diff and try again.");
      }
      fileLines.splice(index, 1);
    } else if (line.kind === "deletion") {
      const index = Math.max(0, Math.min(line.newInsertionIndex, fileLines.length));
      const ending = deletedLineEnding(
        originalLines,
        line,
        fileLines,
        index,
      );
      if (index === fileLines.length && fileLines.at(-1)?.ending === "") {
        fileLines.at(-1)!.ending = adjacentLineEnding(fileLines, index);
      }
      fileLines.splice(index, 0, { content: line.content, ending });
    }
  }
  const next = fileLines.map(({ content, ending }) => `${content}${ending}`).join("");
  return Buffer.from(next, "utf8");
}

async function headFileContent(root: string, path: string): Promise<Buffer> {
  try {
    return (await runGit(root, ["show", `HEAD:${path}`], {
      maxOutputBytes: MAX_DIFF_BYTES,
      failureMessage: "Unable to inspect the committed file.",
    })).stdout;
  } catch (error) {
    if (error instanceof GitError && error.code !== "output-limit") {
      return Buffer.alloc(0);
    }
    throw error;
  }
}

function hunkFingerprint(header: string, lines: readonly DiffLine[]): string {
  return sha256(JSON.stringify({
    header,
    lines: lines.map((line) => ({
      id: line.id,
      kind: line.kind,
      content: line.content,
      patchLine: line.patchLine,
      oldLineNumber: line.oldLineNumber,
      newLineNumber: line.newLineNumber,
      oldInsertionIndex: line.oldInsertionIndex,
      newInsertionIndex: line.newInsertionIndex,
      noFinalNewline: line.noFinalNewline ?? false,
    })),
  }));
}

async function buildReversalState(
  root: string,
  selection: GitDiffSelection,
  secureFiles: RuntimeSecureFileBroker,
  secureRoot: SecureFileRootCapability,
): Promise<ReversalState> {
  if (!(await hasHead(root))) throw new GitError("invalid-input", "Selective reversal requires a repository with an initial commit.");
  const status = await getRepositoryStatus(root);
  if (status.truncated) throw new GitError("output-limit", "The complete Git status is too large to validate safely.");
  const statusFile = status.files.find((candidate) => candidate.path === selection.filePath);
  if (!statusFile) throw new GitError("not-found", "The selected file is no longer changed.");
  if (statusFile.status === "unmerged") throw new GitError("conflict", "Resolve this file's Git conflict before selectively reverting it.");
  if (statusFile.status === "renamed" || statusFile.status === "copied") {
    throw new GitError("invalid-input", "Renamed and copied files must be reverted as a whole so both paths remain consistent.");
  }
  if (statusFile.status === "deleted") throw new GitError("invalid-input", "Deleted files must be restored as a whole from source control.");
  if (statusFile.status === "untracked" || statusFile.status === "added") {
    throw new GitError("invalid-input", "New and untracked files must be removed or edited directly; selective Git reversal is unavailable.");
  }
  if (statusFile.status === "type-changed") {
    throw new GitError("invalid-input", "Type-changed files must be restored as a whole from source control.");
  }
  if (statusFile.status !== "modified" || ![".", "M"].includes(statusFile.indexStatus) || ![".", "M"].includes(statusFile.worktreeStatus)) {
    throw new GitError("invalid-input", "This file's Git state is not supported for selective reversal.");
  }

  const stateBefore = await repositoryStateFingerprint(
    root,
    secureFiles,
    secureRoot,
  );
  let current = await completeRepositoryDiff(
    root,
    selection.ignoreWhitespace,
    [selection.filePath],
    secureFiles,
    secureRoot,
  );
  let structured = parseUnifiedDiff(current.text);
  if (structured.fingerprint !== selection.fingerprint) {
    current = await completeRepositoryDiff(
      root,
      selection.ignoreWhitespace,
      undefined,
      secureFiles,
      secureRoot,
    );
    structured = parseUnifiedDiff(current.text);
  }
  if (structured.fingerprint !== selection.fingerprint) {
    throw new GitError("conflict", "The complete diff changed since this selection was made. Refresh the diff and try again.");
  }
  const file = structured.files.find((candidate) => candidate.path === selection.filePath);
  const hunk = file?.hunks.find((candidate) => candidate.id === selection.hunkId);
  if (!file || !hunk) throw new GitError("not-found", "The selected diff hunk is no longer available.");
  const selectedIds = new Set(selection.lineIds);
  if (selectedIds.size !== selection.lineIds.length || hunk.lines.filter((line) => selectedIds.has(line.id)).length !== selectedIds.size) {
    throw new GitError("conflict", "The selected line range no longer matches the complete current hunk.");
  }
  const selectedAll = hunk.lines.filter((line) => selectedIds.has(line.id));
  const selectedWorktreeLines = selectedAll.filter((line) => line.kind === "addition" || line.kind === "deletion");
  if (selectedWorktreeLines.length === 0) throw new GitError("invalid-input", "Select at least one added or removed line to revert.");

  const validated = await validatedPaths(root, [file.path]);
  const worktree = await secureFiles.read(
    secureRoot,
    validated[0]!,
    MAX_DIFF_BYTES,
  );

  const [index, stagedPatch, headContent] = await Promise.all([
    readIndexEntry(root, file.path),
    completeLayerPatch(root, "index", file.path, selection.ignoreWhitespace),
    headFileContent(root, file.path),
  ]);
  const worktreeContent = worktree.content;
  textBuffer(worktreeContent);
  textBuffer(index.content);
  const stagedFile = parseUnifiedDiff(stagedPatch).files.find((candidate) => candidate.path === file.path);
  const stagedCandidates = stagedFile?.hunks.flatMap((candidate) => candidate.lines)
    .filter((line) => line.kind === "addition" || line.kind === "deletion") ?? [];
  const fullCandidates = file.hunks.flatMap((candidate) => candidate.lines)
    .filter((line) => line.kind === "addition" || line.kind === "deletion");
  const usedStaged = new Set<string>();
  const stagedByFullId = new Map<string, DiffLine>();
  for (const line of fullCandidates) {
    const signature = selectedLineSignature(line);
    const match = stagedCandidates.find((candidate) => !usedStaged.has(candidate.id) && selectedLineSignature(candidate) === signature);
    if (match) {
      usedStaged.add(match.id);
      stagedByFullId.set(line.id, match);
    }
  }
  const anchors = new Set(fullCandidates.filter((line) => line.kind === "addition").map((line) => line.oldInsertionIndex));
  for (const anchor of anchors) {
    const unmatchedFull = fullCandidates.filter((line) => line.kind === "addition" && line.oldInsertionIndex === anchor && !stagedByFullId.has(line.id));
    const unmatchedStaged = stagedCandidates.filter((line) => line.kind === "addition" && line.oldInsertionIndex === anchor && !usedStaged.has(line.id));
    if (unmatchedFull.length === unmatchedStaged.length) {
      unmatchedFull.forEach((line, index) => {
        const staged = unmatchedStaged[index];
        if (staged) {
          stagedByFullId.set(line.id, staged);
          usedStaged.add(staged.id);
        }
      });
    } else if (
      unmatchedStaged.length > 0
      && unmatchedFull.some((line) => selectedWorktreeLines.some((selected) => selected.id === line.id))
    ) {
      throw new GitError("invalid-input", "This selected addition overlaps differently staged content and cannot be reversed without risking unrelated index changes.");
    }
  }
  const selectedIndexLines = selectedWorktreeLines.flatMap((line) => {
    const staged = stagedByFullId.get(line.id);
    return staged ? [staged] : [];
  });
  // Validate both transformations before exposing the plan.
  reversalText(worktreeContent, selectedWorktreeLines, headContent);
  if (selectedIndexLines.length > 0) {
    reversalText(index.content, selectedIndexLines, headContent);
  }

  const stateAfter = await repositoryStateFingerprint(
    root,
    secureFiles,
    secureRoot,
  );
  if (stateAfter !== stateBefore) throw new GitError("conflict", "The repository changed while the reversal was being inspected. Refresh and try again.");
  const affectedLayers: Array<"index" | "worktree"> = [
    ...(selectedIndexLines.length > 0 ? ["index" as const] : []),
    "worktree",
  ];
  const validation: DiffReversalValidation = {
    diffFingerprint: structured.fingerprint,
    fileFingerprint: bufferHash(worktreeContent),
    hunkFingerprint: hunkFingerprint(hunk.header, hunk.lines),
    selectionFingerprint: sha256(JSON.stringify(selectedAll.map((line) => ({
      id: line.id,
      kind: line.kind,
      content: line.content,
      patchLine: line.patchLine,
    })))),
    gitStateFingerprint: stateAfter,
  };
  return {
    root,
    headContent,
    worktreeMode: worktree.mode,
    worktreeContent,
    index,
    selectedWorktreeLines,
    selectedIndexLines,
    plan: {
      filePath: file.path,
      hunkId: hunk.id,
      hunkHeader: hunk.header,
      selectedLineCount: selectedAll.length,
      changedLineCount: selectedWorktreeLines.length,
      affectedLayers,
      validation,
    },
  };
}

function sameValidation(left: DiffReversalValidation, right: DiffReversalValidation): boolean {
  return left.diffFingerprint === right.diffFingerprint
    && left.fileFingerprint === right.fileFingerprint
    && left.hunkFingerprint === right.hunkFingerprint
    && left.selectionFingerprint === right.selectionFingerprint
    && left.gitStateFingerprint === right.gitStateFingerprint;
}

export async function inspectDiffSelection(
  repositoryPath: string,
  selection: GitDiffSelection,
  secureFiles: RuntimeSecureFileBroker,
  retainedRoot?: SecureFileRootCapability,
): Promise<DiffReversalPlan> {
  const root = retainedRoot?.root ?? await repositoryRoot(repositoryPath);
  return withReversalRepositoryLock(root, () =>
    inspectDiffSelectionLocked(
      root,
      selection,
      secureFiles,
      retainedRoot,
    ));
}

async function inspectDiffSelectionLocked(
  root: string,
  selection: GitDiffSelection,
  secureFiles: RuntimeSecureFileBroker,
  retainedRoot?: SecureFileRootCapability,
): Promise<DiffReversalPlan> {
  const secureRoot = retainedRoot ?? await secureFiles.authorizeRoot(root);
  await secureFiles.verifyRoot(secureRoot);
  const controller = await reversalController(root);
  await maintainReversalOperations(
    root,
    controller,
    secureFiles,
    secureRoot,
  );
  const plan = (
    await buildReversalState(root, selection, secureFiles, secureRoot)
  ).plan;
  await secureFiles.verifyRoot(secureRoot);
  return plan;
}

/** Failure hooks are deliberately per-call so tests never alter process-global Git behavior. */
export interface ReversalTestHooks {
  afterBackupCreated?: (operation: ReversalOperationRecord) => void | Promise<void>;
  afterIndexUpdated?: (operation: ReversalOperationRecord) => void | Promise<void>;
}

async function failReversalOperation(
  controller: ReversalRegistryController,
  operation: ReversalOperationRecord,
  retainBackups: boolean,
): Promise<void> {
  const failed = retainBackups
    ? await registryOperation(controller.markRecoveryRequired(operation.operationId))
    : await registryOperation(controller.markFailed(operation.operationId));
  if (!retainBackups) await registryOperation(controller.deleteBackups(failed));
}

export async function revertDiffSelection(
  repositoryPath: string,
  selection: GitDiffSelection,
  secureFiles: RuntimeSecureFileBroker,
  testHooks?: ReversalTestHooks,
  retainedRoot?: SecureFileRootCapability,
): Promise<GitDiffReversalResult> {
  const root = retainedRoot?.root ?? await repositoryRoot(repositoryPath);
  return withReversalRepositoryLock(root, () =>
    revertDiffSelectionLocked(
      root,
      selection,
      secureFiles,
      testHooks,
      retainedRoot,
    ));
}

async function revertDiffSelectionLocked(
  root: string,
  selection: GitDiffSelection,
  secureFiles: RuntimeSecureFileBroker,
  testHooks?: ReversalTestHooks,
  retainedRoot?: SecureFileRootCapability,
): Promise<GitDiffReversalResult> {
  const secureRoot = retainedRoot ?? await secureFiles.authorizeRoot(root);
  await secureFiles.verifyRoot(secureRoot);
  const controller = await reversalController(root);
  await maintainReversalOperations(
    root,
    controller,
    secureFiles,
    secureRoot,
  );
  if (!selection.expected) throw new GitError("invalid-input", "Inspect the selected reversal before applying it.");
  const state = await buildReversalState(
    root,
    selection,
    secureFiles,
    secureRoot,
  );
  if (!sameValidation(state.plan.validation, selection.expected)) {
    throw new GitError("conflict", "The diff, file, hunk, selected lines, or staged state changed after confirmation. Refresh and try again.");
  }
  const nextWorktree = reversalText(
    state.worktreeContent,
    state.selectedWorktreeLines,
    state.headContent,
  );
  const nextIndex = state.selectedIndexLines.length > 0
    ? reversalText(
        state.index.content,
        state.selectedIndexLines,
        state.headContent,
      )
    : state.index.content;
  const operationId = randomUUID();
  const [preWorktreeOid, postWorktreeOid, nextIndexOid] = await Promise.all([
    hashObject(root, state.worktreeContent),
    hashObject(root, nextWorktree),
    state.selectedIndexLines.length > 0 ? hashObject(root, nextIndex) : Promise.resolve(state.index.oid),
  ]);
  const operation = await registryOperation(controller.prepare({
    operationId,
    filePath: state.plan.filePath,
    affectedLayers: state.plan.affectedLayers,
    selectedLineCount: state.plan.selectedLineCount,
    preWorktreeOid,
    preWorktreeMode: state.worktreeMode,
    preIndexOid: state.index.oid,
    preIndexMode: state.index.mode,
    postWorktreeOid,
    postWorktreeMode: state.worktreeMode,
    postIndexOid: nextIndexOid,
    postIndexMode: state.index.mode,
  }));
  let indexUpdated = false;
  let worktreeUpdated = false;
  let enteredApplying = false;
  try {
    await testHooks?.afterBackupCreated?.(operation);
    if (
      (await repositoryStateFingerprint(root, secureFiles, secureRoot))
      !== state.plan.validation.gitStateFingerprint
    ) {
      throw new GitError("conflict", "The repository changed immediately before the reversal. No files were changed.");
    }
    await registryOperation(controller.markApplying(operation.operationId));
    enteredApplying = true;
    if (!(await fileStateMatches(
      root,
      state.plan.filePath,
      operation.preWorktreeOid,
      operation.preWorktreeMode,
      operation.preIndexOid,
      operation.preIndexMode,
      secureFiles,
      secureRoot,
    ))) {
      throw new GitError("conflict", "The selected file or staged state changed immediately before the reversal. No changes were applied.");
    }
    if (state.selectedIndexLines.length > 0) {
      await updateIndexEntry(root, state.plan.filePath, state.index.mode, nextIndexOid);
      indexUpdated = true;
      await testHooks?.afterIndexUpdated?.(operation);
    }
    await writeAtomic(
      root,
      state.plan.filePath,
      nextWorktree,
      state.worktreeMode,
      state.worktreeContent,
      secureFiles,
      secureRoot,
    );
    worktreeUpdated = true;
    if (!(await fileStateMatches(
      root,
      state.plan.filePath,
      operation.postWorktreeOid,
      operation.postWorktreeMode,
      operation.postIndexOid,
      operation.postIndexMode,
      secureFiles,
      secureRoot,
    ))) {
      throw new GitError("conflict", "Git could not verify the completed reversal; the original file state was restored.");
    }
    const diff = await completeRepositoryDiff(
      root,
      selection.ignoreWhitespace,
      undefined,
      secureFiles,
      secureRoot,
    );
    const applied = await registryOperation(controller.markApplied(operation.operationId));
    await secureFiles.verifyRoot(secureRoot);
    return {
      diff,
      operation: {
        id: applied.operationId,
        filePath: applied.filePath,
        selectedLineCount: applied.selectedLineCount,
        affectedLayers: applied.affectedLayers,
        createdAt: applied.createdAt,
      },
    };
  } catch (error) {
    if (indexUpdated) await updateIndexEntry(root, state.plan.filePath, state.index.mode, state.index.oid).catch(() => undefined);
    if (worktreeUpdated) {
      await writeAtomic(
        root,
        state.plan.filePath,
        state.worktreeContent,
        state.worktreeMode,
        nextWorktree,
        secureFiles,
        secureRoot,
      ).catch(() => undefined);
    }
    const restored = await fileStateMatches(
      root,
      state.plan.filePath,
      operation.preWorktreeOid,
      operation.preWorktreeMode,
      operation.preIndexOid,
      operation.preIndexMode,
      secureFiles,
      secureRoot,
    );
    await failReversalOperation(
      controller,
      operation,
      enteredApplying && !restored,
    );
    throw error;
  }
}

export async function undoDiffSelection(
  repositoryPath: string,
  operationId: string,
  secureFiles: RuntimeSecureFileBroker,
  retainedRoot?: SecureFileRootCapability,
): Promise<GitUnifiedDiff> {
  const root = retainedRoot?.root ?? await repositoryRoot(repositoryPath);
  return withReversalRepositoryLock(root, () =>
    undoDiffSelectionLocked(
      root,
      operationId,
      secureFiles,
      retainedRoot,
    ));
}

async function undoDiffSelectionLocked(
  root: string,
  operationId: string,
  secureFiles: RuntimeSecureFileBroker,
  retainedRoot?: SecureFileRootCapability,
): Promise<GitUnifiedDiff> {
  const secureRoot = retainedRoot ?? await secureFiles.authorizeRoot(root);
  await secureFiles.verifyRoot(secureRoot);
  const controller = await reversalController(root);
  await maintainReversalOperations(
    root,
    controller,
    secureFiles,
    secureRoot,
  );
  const operation = await registryOperation(controller.get(operationId));
  await registryOperation(Promise.resolve().then(() => controller.assertCurrentIdentity(operation)));
  if (operation.status !== "applied") {
    throw new GitError("not-found", operation.status === "expired"
      ? "This reversal backup expired and is no longer available."
      : "This reversal backup is no longer available for Undo.");
  }
  const [path] = await validatedPaths(root, [operation.filePath]);
  if (!(await fileStateMatches(
    root,
    path!,
    operation.postWorktreeOid,
    operation.postWorktreeMode,
    operation.postIndexOid,
    operation.postIndexMode,
    secureFiles,
    secureRoot,
  ))) {
    throw new GitError("conflict", "This file or its staged state changed after the reversal, so Undo was not applied.");
  }
  const [worktree, postWorktree] = await Promise.all([
    registryOperation(controller.readBackup(operation, "pre-worktree")),
    registryOperation(controller.readBackup(operation, "post-worktree")),
  ]);
  await registryOperation(controller.markUndoing(operation.operationId));
  if (!(await fileStateMatches(
    root,
    path!,
    operation.postWorktreeOid,
    operation.postWorktreeMode,
    operation.postIndexOid,
    operation.postIndexMode,
    secureFiles,
    secureRoot,
  ))) {
    await registryOperation(controller.markApplied(operation.operationId));
    throw new GitError("conflict", "This file or its staged state changed before Undo could start, so Undo was not applied.");
  }
  let indexUpdated = false;
  let worktreeUpdated = false;
  let diff: GitUnifiedDiff;
  try {
    if (operation.affectedLayers.includes("index")) {
      await updateIndexEntry(root, path!, operation.preIndexMode, operation.preIndexOid);
      indexUpdated = true;
    }
    await writeAtomic(
      root,
      path!,
      worktree,
      operation.preWorktreeMode,
      postWorktree,
      secureFiles,
      secureRoot,
    );
    worktreeUpdated = true;
    if (!(await fileStateMatches(
      root,
      path!,
      operation.preWorktreeOid,
      operation.preWorktreeMode,
      operation.preIndexOid,
      operation.preIndexMode,
      secureFiles,
      secureRoot,
    ))) {
      throw new GitError("conflict", "Git could not verify the restored reversal backup.");
    }
    diff = await completeRepositoryDiff(
      root,
      false,
      undefined,
      secureFiles,
      secureRoot,
    );
  } catch (error) {
    if (indexUpdated) await updateIndexEntry(root, path!, operation.postIndexMode, operation.postIndexOid).catch(() => undefined);
    if (worktreeUpdated) {
      await writeAtomic(
        root,
        path!,
        postWorktree,
        operation.postWorktreeMode,
        worktree,
        secureFiles,
        secureRoot,
      ).catch(() => undefined);
    }
    const restored = await fileStateMatches(
      root,
      path!,
      operation.postWorktreeOid,
      operation.postWorktreeMode,
      operation.postIndexOid,
      operation.postIndexMode,
      secureFiles,
      secureRoot,
    );
    if (restored) await registryOperation(controller.markApplied(operation.operationId));
    else await registryOperation(controller.markRecoveryRequired(operation.operationId));
    throw error;
  }
  let undone: ReversalOperationRecord;
  try {
    undone = await registryOperation(controller.markUndone(operation.operationId));
  } catch (error) {
    if (operation.affectedLayers.includes("index")) {
      await updateIndexEntry(root, path!, operation.postIndexMode, operation.postIndexOid).catch(() => undefined);
    }
    await writeAtomic(
      root,
      path!,
      postWorktree,
      operation.postWorktreeMode,
      worktree,
      secureFiles,
      secureRoot,
    ).catch(() => undefined);
    const restored = await fileStateMatches(
      root,
      path!,
      operation.postWorktreeOid,
      operation.postWorktreeMode,
      operation.postIndexOid,
      operation.postIndexMode,
      secureFiles,
      secureRoot,
    );
    if (restored) await registryOperation(controller.markApplied(operation.operationId));
    else await registryOperation(controller.markRecoveryRequired(operation.operationId));
    throw error;
  }
  await registryOperation(controller.deleteBackups(undone));
  await secureFiles.verifyRoot(secureRoot);
  return diff;
}
