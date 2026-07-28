import type {
  DiffHunk,
  DiffReviewState,
  StructuredDiff,
} from "@shared/contracts";
import {
  diffFileFingerprint,
  diffHunkFingerprint,
} from "@shared/diff-review";

export function unreviewedCommitHunks(
  diff: StructuredDiff,
  selectedPaths: readonly string[],
  reviewStates: readonly DiffReviewState[],
  repositoryPath: string,
): DiffHunk[] {
  return diff.files
    .filter((file) => selectedPaths.includes(file.path))
    .flatMap((file) => file.hunks.filter((hunk) => {
      const fileFingerprint = diffFileFingerprint(file);
      const fingerprint = diffHunkFingerprint(file, hunk);
      return !reviewStates.some((state) => {
        if (
          (state.repositoryPath ?? ".") !== repositoryPath
          || state.path !== file.path
          || !state.reviewed
          || state.stale
        ) {
          return false;
        }
        if (state.scope === "file") {
          return state.targetFingerprint === fileFingerprint;
        }
        return state.hunkId === hunk.id
          && state.targetFingerprint === fingerprint;
      });
    }));
}
