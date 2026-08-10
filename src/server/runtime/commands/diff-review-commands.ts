import type WebSocket from "ws";

import type {
  DiffReversalValidation,
  ServerEvent,
} from "../../../shared/contracts";
import {
  diffFileFingerprint,
  diffHunkFingerprint,
  parseUnifiedDiff,
  selectedLineFingerprint,
} from "../../../shared/diff-review";
import type { RuntimeStore } from "../../database";
import {
  getRepositoryStatus,
  getUnifiedDiff,
  inspectDiffSelection,
  revertDiffSelection,
  undoDiffSelection,
} from "../../git";
import { RuntimeRequestError } from "../../runtime-errors";
import type { RuntimeSecureFileBroker } from "../../secure-files";
import { changedFiles } from "../../runtime-snapshots";
import {
  resolveWorkspaceGitRepository,
  workspaceGitFilePath,
} from "../../workspace-git";
import type { WorkspaceRunController } from "../workspace-run-controller";
import type { SecureFileAuthorityRegistry } from "../secure-file-authorities";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface DiffReviewCommandDependencies {
  store: RuntimeStore;
  workspaceRuns: WorkspaceRunController<WebSocket>;
  secureFiles: RuntimeSecureFileBroker;
  secureFileAuthorities: SecureFileAuthorityRegistry;
  workspacePath(projectId: string, conversationId?: string): string;
  broadcastSnapshot(): void;
  send(socket: WebSocket, event: ServerEvent): void;
}

function reversalApplyBinding(
  projectId: string,
  conversationId: string | undefined,
  workspaceRoot: string,
  repositoryPath: string,
  selection: {
    fingerprint: string;
    filePath: string;
    hunkId: string;
    lineIds: readonly string[];
    ignoreWhitespace?: boolean;
  },
  validation: DiffReversalValidation,
): string[] {
  return [
    projectId,
    conversationId ?? "",
    workspaceRoot,
    repositoryPath,
    selection.fingerprint,
    selection.filePath,
    selection.hunkId,
    JSON.stringify(selection.lineIds),
    selection.ignoreWhitespace ? "1" : "0",
    validation.diffFingerprint,
    validation.fileFingerprint,
    validation.hunkFingerprint,
    validation.selectionFingerprint,
    validation.gitStateFingerprint,
  ];
}

function reversalUndoBinding(
  projectId: string,
  conversationId: string | undefined,
  workspaceRoot: string,
  repositoryPath: string,
  operationId: string,
): string[] {
  return [
    projectId,
    conversationId ?? "",
    workspaceRoot,
    repositoryPath,
    operationId,
  ];
}

export function createDiffReviewCommandHandler(
  dependencies: DiffReviewCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "git.selection.revert",
    "git.selection.inspect",
    "git.selection.undo",
    "review.state.set",
    "review.note.create",
    "review.note.update",
    "review.note.delete",
  ], async (socket, command) => {
    switch (command.type) {
      case "git.selection.revert": {
        if (
          command.payload.conversationId
          && dependencies.store.hasActiveWorkspaceRunForConversation(
            command.payload.conversationId,
          )
        ) {
          throw new RuntimeRequestError(
            "Stop the active run or review before reverting selected changes.",
          );
        }
        const workspaceRoot = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        const repositoryPath = command.payload.repositoryPath ?? ".";
        const secureRoot = await dependencies.secureFileAuthorities.resolve(
          socket,
          command.payload.authorityRef,
          "reversal-apply",
          reversalApplyBinding(
            command.payload.projectId,
            command.payload.conversationId,
            workspaceRoot,
            repositoryPath,
            command.payload,
            command.payload.expected,
          ),
          { consume: true },
        );
        const reversed = await dependencies.workspaceRuns.trackSourceControl(
          `Revert ${command.payload.lineIds.length} selected ${command.payload.lineIds.length === 1 ? "line" : "lines"} · ${workspaceGitFilePath(repositoryPath, command.payload.filePath)}`,
          command.payload.projectId,
          command.payload.conversationId,
          workspaceRoot,
          command.requestId,
          async () => await revertDiffSelection(
            secureRoot.root,
            {
              fingerprint: command.payload.fingerprint,
              filePath: command.payload.filePath,
              hunkId: command.payload.hunkId,
              lineIds: command.payload.lineIds,
              expected: command.payload.expected,
              ignoreWhitespace: command.payload.ignoreWhitespace,
            },
            dependencies.secureFiles,
            undefined,
            secureRoot,
          ),
          { serializationRoot: secureRoot.root },
        );
        if (command.payload.comment && command.payload.conversationId) {
          dependencies.store.createMessage(
            command.payload.conversationId,
            `Reverted selected changes in ${workspaceGitFilePath(repositoryPath, command.payload.filePath)}. Note: ${command.payload.comment}`,
            "system",
          );
        }
        const status = await getRepositoryStatus(secureRoot.root);
        await dependencies.secureFiles.verifyRoot(secureRoot);
        const authorityRef = await dependencies.secureFileAuthorities.issue(
          socket,
          "reversal-undo",
          reversalUndoBinding(
            command.payload.projectId,
            command.payload.conversationId,
            workspaceRoot,
            repositoryPath,
            reversed.operation.id,
          ),
          secureRoot,
        );
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "git.reversal",
            diff: {
              patch: reversed.diff.text,
              truncated: reversed.diff.truncated,
              files: changedFiles(status),
            },
            operation: {
              ...reversed.operation,
              repositoryPath,
              authorityRef,
            },
          },
        });
        dependencies.broadcastSnapshot();
        return "handled";
      }
      case "git.selection.inspect": {
        const workspaceRoot = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        const repository = await resolveWorkspaceGitRepository(
          workspaceRoot,
          command.payload.repositoryPath ?? ".",
          dependencies.secureFiles,
        );
        if (!repository.secureRoot) {
          throw new RuntimeRequestError(
            "Secure repository access is unavailable.",
          );
        }
        const plan = await inspectDiffSelection(
          repository.root,
          {
            fingerprint: command.payload.fingerprint,
            filePath: command.payload.filePath,
            hunkId: command.payload.hunkId,
            lineIds: command.payload.lineIds,
            ignoreWhitespace: command.payload.ignoreWhitespace,
          },
          dependencies.secureFiles,
          repository.secureRoot,
        );
        const repositoryPath = command.payload.repositoryPath ?? ".";
        const authorityRef = await dependencies.secureFileAuthorities.issue(
          socket,
          "reversal-apply",
          reversalApplyBinding(
            command.payload.projectId,
            command.payload.conversationId,
            workspaceRoot,
            repositoryPath,
            command.payload,
            plan.validation,
          ),
          repository.secureRoot,
        );
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "git.reversal.plan",
            plan: { ...plan, authorityRef },
          },
        });
        return "handled";
      }
      case "git.selection.undo": {
        if (
          command.payload.conversationId
          && dependencies.store.hasActiveWorkspaceRunForConversation(
            command.payload.conversationId,
          )
        ) {
          throw new RuntimeRequestError(
            "Stop the active run or review before restoring the selective-revert backup.",
          );
        }
        const workspaceRoot = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        const repositoryPath = command.payload.repositoryPath ?? ".";
        const secureRoot = await dependencies.secureFileAuthorities.resolve(
          socket,
          command.payload.authorityRef,
          "reversal-undo",
          reversalUndoBinding(
            command.payload.projectId,
            command.payload.conversationId,
            workspaceRoot,
            repositoryPath,
            command.payload.operationId,
          ),
          { consume: true },
        );
        const diff = await dependencies.workspaceRuns.trackSourceControl(
          "Undo selective reversal",
          command.payload.projectId,
          command.payload.conversationId,
          workspaceRoot,
          command.requestId,
          async () => await undoDiffSelection(
            secureRoot.root,
            command.payload.operationId,
            dependencies.secureFiles,
            secureRoot,
          ),
          { serializationRoot: secureRoot.root },
        );
        const status = await getRepositoryStatus(secureRoot.root);
        await dependencies.secureFiles.verifyRoot(secureRoot);
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "git.diff",
            diff: {
              patch: diff.text,
              truncated: diff.truncated,
              files: changedFiles(status),
            },
          },
        });
        dependencies.broadcastSnapshot();
        return "handled";
      }
      case "review.state.set": {
        const conversation = dependencies.store.conversation(
          command.payload.conversationId,
        );
        const repositoryPath = command.payload.repositoryPath ?? ".";
        const repository = await resolveWorkspaceGitRepository(
          dependencies.store.conversationPath(conversation.id),
          repositoryPath,
        );
        const current = await getUnifiedDiff(
          repository.root,
          {
            paths: [command.payload.path],
            ignoreWhitespace: command.payload.ignoreWhitespace,
          },
          undefined,
          dependencies.secureFiles,
        );
        if (current.truncated) {
          throw new RuntimeRequestError(
            "The complete diff is required before changing review state.",
          );
        }
        const structured = parseUnifiedDiff(current.text);
        const file = structured.files.find(
          (candidate) => candidate.path === command.payload.path,
        );
        const hunk = file?.hunks.find(
          (candidate) => candidate.id === command.payload.hunkId,
        );
        const actualFingerprint = command.payload.scope === "file"
          ? file && diffFileFingerprint(file)
          : file && hunk && diffHunkFingerprint(file, hunk);
        if (
          !actualFingerprint
          || actualFingerprint !== command.payload.targetFingerprint
        ) {
          throw new RuntimeRequestError(
            "This review target changed. Refresh the diff before marking it reviewed.",
          );
        }
        const { ignoreWhitespace: _ignoreWhitespace, ...state } =
          command.payload;
        dependencies.store.setReviewState({
          ...state,
          repositoryPath,
        });
        return "mutation";
      }
      case "review.note.create": {
        const conversation = dependencies.store.conversation(
          command.payload.conversationId,
        );
        const repositoryPath = command.payload.repositoryPath ?? ".";
        const repository = await resolveWorkspaceGitRepository(
          dependencies.store.conversationPath(conversation.id),
          repositoryPath,
        );
        const current = await getUnifiedDiff(
          repository.root,
          {
            paths: [command.payload.path],
            ignoreWhitespace: command.payload.ignoreWhitespace,
          },
          undefined,
          dependencies.secureFiles,
        );
        if (current.truncated) {
          throw new RuntimeRequestError(
            "The complete diff is required before saving a targeted note.",
          );
        }
        const structured = parseUnifiedDiff(current.text);
        const file = structured.files.find(
          (candidate) => candidate.path === command.payload.path,
        );
        const hunk = file?.hunks.find(
          (candidate) => candidate.id === command.payload.hunkId,
        );
        let actualFingerprint: string | null = null;
        if (command.payload.lineIds.length > 0) {
          if (
            !file
            || !hunk
            || !command.payload.lineIds.every(
              (id) => hunk.lines.some((line) => line.id === id),
            )
          ) {
            throw new RuntimeRequestError(
              "The selected note range changed. Refresh the diff.",
            );
          }
          actualFingerprint = selectedLineFingerprint(
            file,
            hunk,
            command.payload.lineIds,
          );
        } else if (file && hunk) {
          actualFingerprint = diffHunkFingerprint(file, hunk);
        } else if (file && command.payload.hunkId === null) {
          actualFingerprint = diffFileFingerprint(file);
        }
        if (
          !actualFingerprint
          || actualFingerprint !== command.payload.targetFingerprint
        ) {
          throw new RuntimeRequestError(
            "This note target changed. Refresh the diff before saving it.",
          );
        }
        const { ignoreWhitespace: _ignoreWhitespace, ...note } =
          command.payload;
        dependencies.store.createReviewNote({
          ...note,
          repositoryPath,
        });
        return "mutation";
      }
      case "review.note.update":
        dependencies.store.updateReviewNote(
          command.payload.conversationId,
          command.payload.noteId,
          command.payload.body,
        );
        return "mutation";
      case "review.note.delete":
        dependencies.store.deleteReviewNote(
          command.payload.conversationId,
          command.payload.noteId,
        );
        return "mutation";
      default:
        return "not-handled";
    }
  });
}
