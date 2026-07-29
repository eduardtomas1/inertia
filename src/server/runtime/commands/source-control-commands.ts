import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type WebSocket from "ws";

import type {
  GitStatusSnapshot,
  ServerEvent,
} from "../../../shared/contracts";
import type { RuntimeStore } from "../../database";
import {
  commitChanges,
  createBranch,
  createWorktree,
  getPullRequestCreateUrl,
  getRepositoryStatus,
  getUnifiedDiff,
  GitError,
  listBranches,
  pullRepository,
  pushCurrentBranch,
  switchBranch,
} from "../../git";
import { RuntimeRequestError } from "../../runtime-errors";
import {
  changedFiles,
  emptyGitStatusSnapshot,
  gitStatusSnapshot,
} from "../../runtime-snapshots";
import {
  TurnGitArtifactError,
  type TurnGitArtifactManager,
} from "../../turn-git-artifacts";
import type { RuntimeSecureFileBroker } from "../../secure-files";
import { repositoryRoot } from "../../git/paths";
import { discoverWorkspaceGitRepositories } from "../../workspace-git";
import type { SecureFileAuthorityRegistry } from "../secure-file-authorities";
import type { WorkspaceRunController } from "../workspace-run-controller";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";
import { reconcileReviews } from "./review-support";

export interface SourceControlCommandDependencies {
  store: RuntimeStore;
  workspaceRuns: WorkspaceRunController<WebSocket>;
  turnGitArtifacts: TurnGitArtifactManager;
  secureFiles: RuntimeSecureFileBroker;
  secureFileAuthorities: SecureFileAuthorityRegistry;
  dataDirectory: string;
  workspacePath(projectId: string, conversationId?: string): string;
  broadcastSnapshot(): void;
  send(socket: WebSocket, event: ServerEvent): void;
}

export function createSourceControlCommandHandler(
  dependencies: SourceControlCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "git.refresh",
    "git.diff",
    "git.workspace.refresh",
    "git.workspace.diff",
    "git.turn.diff",
    "git.turn.compare",
    "git.branches",
    "git.branch.create",
    "git.branch.switch",
    "git.worktree.create",
    "git.pull",
    "git.commit",
    "git.push",
    "git.pr.open",
  ], async (socket, command) => {
    switch (command.type) {
      case "git.refresh": {
        const path = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        let status: GitStatusSnapshot;
        try {
          const root = await repositoryRoot(path);
          const secureRoot = await dependencies.secureFiles.authorizeRoot(root);
          const inspected = await getRepositoryStatus(secureRoot.root);
          await dependencies.secureFiles.verifyRoot(secureRoot);
          const authorityRef =
            await dependencies.secureFileAuthorities.issue(
              socket,
              "git-diff",
              [
                command.payload.projectId,
                command.payload.conversationId ?? "",
                path,
                ".",
              ],
              secureRoot,
            );
          status = gitStatusSnapshot(inspected, authorityRef);
        } catch (error) {
          if (
            !(error instanceof GitError && error.code === "not-repository")
          ) {
            throw error;
          }
          status = emptyGitStatusSnapshot();
        }
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "git.status", status },
        });
        return "handled";
      }
      case "git.diff": {
        const path = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        const secureRoot = await dependencies.secureFileAuthorities.resolve(
          socket,
          command.payload.authorityRef,
          "git-diff",
          [
            command.payload.projectId,
            command.payload.conversationId ?? "",
            path,
            ".",
          ],
        );
        const [diff, status] = await Promise.all([
          getUnifiedDiff(secureRoot.root, {
            ...(
              command.payload.path
                ? { paths: [command.payload.path] }
                : {}
            ),
            ignoreWhitespace: command.payload.ignoreWhitespace,
          }, undefined, dependencies.secureFiles, secureRoot),
          getRepositoryStatus(secureRoot.root),
        ]);
        await dependencies.secureFiles.verifyRoot(secureRoot);
        if (
          command.payload.conversationId
          && !command.payload.path
          && !diff.truncated
        ) {
          reconcileReviews(
            dependencies.store,
            command.payload.conversationId,
            diff.text,
          );
        }
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
        if (
          command.payload.conversationId
          && !command.payload.path
          && !diff.truncated
        ) {
          dependencies.broadcastSnapshot();
        }
        return "handled";
      }
      case "git.workspace.refresh": {
        const path = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        const secureRoots = new Map<string, Awaited<
          ReturnType<RuntimeSecureFileBroker["authorizeRoot"]>
        >>();
        const discovered = await discoverWorkspaceGitRepositories(path, {
          maxRepositories: dependencies.store
            .project(command.payload.projectId).gitRepositoryLimit,
          secureFiles: dependencies.secureFiles,
          onRepositoryAuthorized: (repositoryPath, secureRoot) => {
            secureRoots.set(repositoryPath, secureRoot);
          },
        });
        const status = {
          ...discovered,
          repositories: await Promise.all(
            discovered.repositories.map(async (repository) => {
              const secureRoot = secureRoots.get(repository.repositoryPath);
              if (!secureRoot || repository.state !== "ready") {
                return { ...repository, authorityRef: null };
              }
              const authorityRef =
                await dependencies.secureFileAuthorities.issue(
                  socket,
                  "git-diff",
                  [
                    command.payload.projectId,
                    command.payload.conversationId ?? "",
                    path,
                    repository.repositoryPath,
                  ],
                  secureRoot,
                );
              return { ...repository, authorityRef };
            }),
          ),
        };
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "git.workspace.status", status },
        });
        return "handled";
      }
      case "git.workspace.diff": {
        const path = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        const secureRoot = await dependencies.secureFileAuthorities.resolve(
          socket,
          command.payload.authorityRef,
          "git-diff",
          [
            command.payload.projectId,
            command.payload.conversationId ?? "",
            path,
            command.payload.repositoryPath,
          ],
        );
        const [diff, repositoryStatus] = await Promise.all([
          getUnifiedDiff(secureRoot.root, {
            ...(
              command.payload.path
                ? { paths: [command.payload.path] }
                : {}
            ),
            ignoreWhitespace: command.payload.ignoreWhitespace,
          }, undefined, dependencies.secureFiles, secureRoot),
          getRepositoryStatus(secureRoot.root),
        ]);
        await dependencies.secureFiles.verifyRoot(secureRoot);
        const reviewMetadataChanged = Boolean(
          command.payload.conversationId
          && !diff.truncated
          && reconcileReviews(
            dependencies.store,
            command.payload.conversationId!,
            diff.text,
            command.payload.repositoryPath,
            command.payload.path,
          ),
        );
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "git.workspace.diff",
            diff: {
              repositoryPath: command.payload.repositoryPath,
              reviewMetadataChanged,
              patch: diff.text,
              truncated: diff.truncated,
              files: changedFiles(repositoryStatus),
            },
          },
        });
        if (reviewMetadataChanged) {
          dependencies.broadcastSnapshot();
        }
        return "handled";
      }
      case "git.turn.diff": {
        const conversation = dependencies.store.conversation(
          command.payload.conversationId,
        );
        if (conversation.projectId !== command.payload.projectId) {
          throw new RuntimeRequestError(
            "The thread does not belong to this project.",
          );
        }
        const turn = dependencies.store.agentTurn(command.payload.turnId);
        if (turn.conversationId !== conversation.id) {
          throw new RuntimeRequestError(
            "The Git artifact does not belong to this thread.",
          );
        }
        try {
          const diff = await dependencies.turnGitArtifacts.turnDiff(
            turn.id,
            command.payload.path,
          );
          dependencies.send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: { kind: "git.turn.diff", diff },
          });
        } catch (error) {
          if (error instanceof TurnGitArtifactError) {
            throw new RuntimeRequestError(error.message);
          }
          throw error;
        }
        return "handled";
      }
      case "git.turn.compare": {
        const conversation = dependencies.store.conversation(
          command.payload.conversationId,
        );
        if (conversation.projectId !== command.payload.projectId) {
          throw new RuntimeRequestError(
            "The thread does not belong to this project.",
          );
        }
        const earlier = dependencies.store.agentTurn(
          command.payload.earlierTurnId,
        );
        const later = dependencies.store.agentTurn(
          command.payload.laterTurnId,
        );
        if (
          earlier.conversationId !== conversation.id
          || later.conversationId !== conversation.id
        ) {
          throw new RuntimeRequestError(
            "Both Git artifacts must belong to this thread.",
          );
        }
        try {
          const diff = await dependencies.turnGitArtifacts.compare(
            earlier.id,
            later.id,
            command.payload.path,
          );
          dependencies.send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: { kind: "git.turn.diff", diff },
          });
        } catch (error) {
          if (error instanceof TurnGitArtifactError) {
            throw new RuntimeRequestError(error.message);
          }
          throw error;
        }
        return "handled";
      }
      case "git.branches": {
        const branches = await listBranches(
          dependencies.workspacePath(command.payload.projectId),
        );
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "git.branches",
            branches: [...branches.local, ...branches.remote].map(
              (branch) => ({
                name: branch.name,
                current: branch.current,
                remote: branch.kind === "remote",
                worktreePath: null,
              }),
            ),
          },
        });
        return "handled";
      }
      case "git.branch.create": {
        const result = await dependencies.workspaceRuns.trackSourceControl(
          "Create branch",
          command.payload.projectId,
          undefined,
          async () => await createBranch(
            dependencies.workspacePath(command.payload.projectId),
            command.payload.name,
          ),
        );
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "git.action",
            message:
              `Created ${result.status.branch ?? command.payload.name}.`,
          },
        });
        return "handled";
      }
      case "git.branch.switch": {
        const result = await dependencies.workspaceRuns.trackSourceControl(
          "Switch branch",
          command.payload.projectId,
          undefined,
          async () => await switchBranch(
            dependencies.workspacePath(command.payload.projectId),
            command.payload.name,
          ),
        );
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "git.action",
            message:
              `Switched to ${result.status.branch ?? command.payload.name}.`,
          },
        });
        return "handled";
      }
      case "git.worktree.create": {
        const conversation = dependencies.store.conversation(
          command.payload.conversationId,
        );
        if (conversation.projectId !== command.payload.projectId) {
          throw new RuntimeRequestError(
            "The thread does not belong to this project.",
          );
        }
        if (conversation.worktreePath) {
          throw new RuntimeRequestError(
            "This thread already has a worktree.",
          );
        }
        const target = join(
          dependencies.dataDirectory,
          "worktrees",
          conversation.id,
        );
        mkdirSync(resolve(target, ".."), {
          recursive: true,
          mode: 0o700,
        });
        await dependencies.workspaceRuns.trackSourceControl(
          "Create worktree",
          command.payload.projectId,
          command.payload.conversationId,
          async () => await createWorktree(
            dependencies.store.projectPath(command.payload.projectId),
            target,
            {
              branch: command.payload.branch,
              createBranch: true,
              startPoint: command.payload.baseBranch,
            },
          ),
        );
        dependencies.store.updateConversation(conversation.id, {
          worktreePath: target,
          branch: command.payload.branch,
        });
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "worktree.created",
            path: target,
            branch: command.payload.branch,
          },
        });
        dependencies.broadcastSnapshot();
        return "handled";
      }
      case "git.pull":
        await dependencies.workspaceRuns.trackSourceControl(
          "Pull changes",
          command.payload.projectId,
          command.payload.conversationId,
          async () => await pullRepository(
            dependencies.workspacePath(
              command.payload.projectId,
              command.payload.conversationId,
            ),
          ),
        );
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "git.action",
            message: "Pulled the latest changes.",
          },
        });
        return "handled";
      case "git.commit": {
        const path = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        const result = await dependencies.workspaceRuns.trackSourceControl(
          "Commit changes",
          command.payload.projectId,
          command.payload.conversationId,
          async () => await commitChanges(
            path,
            command.payload.message,
            command.payload.paths,
          ),
        );
        if (command.payload.conversationId) {
          const current = await getUnifiedDiff(
            path,
            {},
            undefined,
            dependencies.secureFiles,
          );
          if (!current.truncated) {
            reconcileReviews(
              dependencies.store,
              command.payload.conversationId,
              current.text,
            );
          }
        }
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "git.action",
            message: `Committed ${result.commit.slice(0, 7)}.`,
          },
        });
        dependencies.broadcastSnapshot();
        return "handled";
      }
      case "git.push":
        await dependencies.workspaceRuns.trackSourceControl(
          "Push branch",
          command.payload.projectId,
          command.payload.conversationId,
          async () => await pushCurrentBranch(
            dependencies.workspacePath(
              command.payload.projectId,
              command.payload.conversationId,
            ),
          ),
        );
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "git.action",
            message: "Pushed the current branch.",
          },
        });
        return "handled";
      case "git.pr.open": {
        const url = await dependencies.workspaceRuns.trackSourceControl(
          "Prepare pull request",
          command.payload.projectId,
          command.payload.conversationId,
          async () => await getPullRequestCreateUrl(
            dependencies.workspacePath(
              command.payload.projectId,
              command.payload.conversationId,
            ),
          ),
        );
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "external.url",
            url,
            label: "Open pull request",
          },
        });
        return "handled";
      }
      default:
        return "not-handled";
    }
  });
}
