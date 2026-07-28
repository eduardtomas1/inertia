import { join } from "node:path";

import type {
  CheckpointSummary,
  ClientCommand,
  TurnRequestContext,
} from "../../../shared/contracts";
import {
  buildDiffContext,
  diffFileFingerprint,
  diffHunkFingerprint,
  DiffContextError,
  parseUnifiedDiff,
  selectedLineFingerprint,
} from "../../../shared/diff-review";
import { createCheckpoint } from "../../checkpoints";
import type { RuntimeStore } from "../../database";
import { getRepositoryStatus, getUnifiedDiff } from "../../git";
import { RuntimeRequestError } from "../../runtime-errors";
import {
  resolveWorkspaceGitRepository,
  workspaceGitFilePath,
} from "../../workspace-git";
import {
  assembleReadOnlyReviewRequest as assembleIsolatedReadOnlyReviewRequest,
} from "../reviews/isolated-run-controller";

const DEFAULT_DIFF_QUESTION =
  "Explain what this selected code does, why it changed, and any risks I should know about.";
const DEFAULT_DIFF_REVISION =
  "Review this selection and improve it while preserving the surrounding behavior.";

export type ReviewSelectionPayload = Extract<
  ClientCommand,
  { type: "review.selection.ask" | "review.selection.revise" }
>["payload"];

export interface SelectedReviewContext {
  visibleContent: string;
  requestContext: TurnRequestContext;
  patch: string;
  fingerprint: string;
  filePath: string;
  hunkId: string;
  hunkHeader: string;
  selectedLineCount: number;
}

export function assembleReadOnlyReviewRequest(
  cwd: string,
  visibleContent: string,
  context: TurnRequestContext,
) {
  return assembleIsolatedReadOnlyReviewRequest(cwd, visibleContent, context);
}

export function reconcileReviews(
  store: RuntimeStore,
  conversationId: string,
  patch: string,
  repositoryPath = ".",
  targetPath?: string,
): boolean {
  const structured = parseUnifiedDiff(patch);
  const files: Record<string, string> = {};
  const hunks: Record<string, string> = {};
  for (const file of structured.files) {
    files[file.path] = diffFileFingerprint(file);
    for (const hunk of file.hunks) {
      hunks[`${file.path}\0${hunk.id}`] = diffHunkFingerprint(file, hunk);
    }
  }
  const notes: Record<string, string | null> = {};
  for (const note of store.reviewNotesFor(conversationId)) {
    if ((note.repositoryPath ?? ".") !== repositoryPath) continue;
    if (targetPath && note.path !== targetPath) continue;
    const file = structured.files.find(
      (candidate) => candidate.path === note.path,
    );
    const hunk = file?.hunks.find(
      (candidate) => candidate.id === note.hunkId,
    );
    if (note.lineIds.length > 0) {
      notes[note.id] = file
        && hunk
        && note.lineIds.every(
          (id) => hunk.lines.some((line) => line.id === id),
        )
        ? selectedLineFingerprint(file, hunk, note.lineIds)
        : null;
    } else if (hunk && file) {
      notes[note.id] = diffHunkFingerprint(file, hunk);
    } else {
      notes[note.id] = file ? diffFileFingerprint(file) : null;
    }
  }
  return store.reconcileReviewTargets(
    conversationId,
    repositoryPath,
    targetPath,
    { files, hunks, notes },
  );
}

export async function selectedReviewContext(
  store: RuntimeStore,
  selection: ReviewSelectionPayload,
  purpose: "ask" | "revision",
): Promise<SelectedReviewContext> {
  const conversation = store.conversation(selection.conversationId);
  if (conversation.projectId !== selection.projectId) {
    throw new RuntimeRequestError(
      "The thread does not belong to this project.",
    );
  }
  const repositoryPath = selection.repositoryPath ?? ".";
  if (purpose === "revision" && repositoryPath !== ".") {
    throw new RuntimeRequestError(
      "Agent revisions are available only for the project-root repository.",
    );
  }
  const workspaceRoot = store.conversationPath(conversation.id);
  const repository = await resolveWorkspaceGitRepository(
    workspaceRoot,
    repositoryPath,
  );
  let selectionDiff = await getUnifiedDiff(repository.root, {
    paths: [selection.filePath],
    ignoreWhitespace: selection.ignoreWhitespace,
  });
  if (selectionDiff.truncated) {
    throw new RuntimeRequestError(
      "The current diff is truncated. Reduce the change set before reviewing a selection.",
    );
  }
  let fullDiff: Awaited<ReturnType<typeof getUnifiedDiff>> | null = null;
  let structured = parseUnifiedDiff(selectionDiff.text);
  if (structured.fingerprint !== selection.fingerprint) {
    fullDiff = await getUnifiedDiff(repository.root, {
      ignoreWhitespace: selection.ignoreWhitespace,
    });
    if (fullDiff.truncated) {
      throw new RuntimeRequestError(
        "The current diff is truncated. Reduce the change set before reviewing a selection.",
      );
    }
    selectionDiff = fullDiff;
    structured = parseUnifiedDiff(fullDiff.text);
  }
  if (structured.fingerprint !== selection.fingerprint) {
    throw new RuntimeRequestError(
      "The diff changed before this review action started. Refresh and select the lines again.",
    );
  }
  const file = structured.files.find(
    (candidate) => candidate.path === selection.filePath,
  );
  const hunk = file?.hunks.find(
    (candidate) => candidate.id === selection.hunkId,
  );
  if (!file || !hunk) {
    throw new RuntimeRequestError(
      "The selected file or hunk is no longer present.",
    );
  }
  let context;
  try {
    context = buildDiffContext(file, hunk, selection.lineIds, {
      purpose: "prompt",
    });
  } catch (error) {
    if (error instanceof DiffContextError) {
      throw new RuntimeRequestError(error.message);
    }
    throw error;
  }
  if (purpose === "revision" && !fullDiff) {
    fullDiff = await getUnifiedDiff(repository.root, {
      ignoreWhitespace: selection.ignoreWhitespace,
    });
    if (fullDiff.truncated) {
      throw new RuntimeRequestError(
        "The complete diff is required to audit a revision for changes outside the selected file.",
      );
    }
  }
  return {
    visibleContent: selection.comment?.trim()
      || (
        purpose === "ask"
          ? DEFAULT_DIFF_QUESTION
          : DEFAULT_DIFF_REVISION
      ),
    requestContext: {
      diffSelections: [{
        path: workspaceGitFilePath(repositoryPath, file.path),
        hunkHeader: hunk.header,
        content: context.text,
        selectedLineCount: context.selectedLineCount,
        truncated: context.truncated,
      }],
    },
    patch: purpose === "revision" ? fullDiff!.text : selectionDiff.text,
    fingerprint: structured.fingerprint,
    filePath: file.path,
    hunkId: hunk.id,
    hunkHeader: hunk.header,
    selectedLineCount: context.selectedLineCount,
  };
}

export async function captureRequiredCheckpoint(
  store: RuntimeStore,
  dataDirectory: string,
  conversationId: string,
  label: string,
  publicError: (error: unknown) => string,
): Promise<CheckpointSummary> {
  const path = store.conversationPath(conversationId);
  const status = await getRepositoryStatus(path);
  let captured: Awaited<ReturnType<typeof createCheckpoint>>;
  try {
    captured = await createCheckpoint(
      path,
      join(dataDirectory, "checkpoint-indexes"),
      conversationId,
    );
  } catch (error) {
    throw new RuntimeRequestError(
      `A recovery checkpoint could not be created, so the revision was not started. ${publicError(error)}`,
    );
  }
  const turnIndex = store.checkpointCount(conversationId) + 1;
  return store.addCheckpoint({
    conversationId,
    ref: captured.ref,
    label,
    turnIndex,
    filesChanged: status.files.length,
    insertions: status.insertions,
    deletions: status.deletions,
  });
}
