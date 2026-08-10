import { mkdirSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import WebSocket from "ws";

import type {
  GitStatusSnapshot,
  ServerEvent,
} from "../../../shared/contracts";
import {
  GIT_READ_OPERATION_TIMEOUT_MS,
  WORKSPACE_GIT_DISCOVERY_TIMEOUT_MS,
} from "../../../shared/runtime-command-timeouts";
import type { RuntimeStore } from "../../database";
import {
  commitReviewedChanges,
  createBranch,
  createGitHubPullRequest,
  createWorktree,
  getPullRequestCreateUrl,
  getRepositoryStatus,
  getUnifiedDiff,
  gitCommitReviewFingerprintsEqual,
  gitCommitReviewStatusMatches,
  prepareGitCommitReview,
  renderGitCommitReviewDiff,
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
import {
  repositoryMetadataMarkerIdentity,
  repositoryRoot,
} from "../../git/paths";
import {
  discoverWorkspaceGitRepositories,
  resolveWorkspaceGitRepository,
  resolveWorkspaceGitRepositoryIdentity,
  type WorkspaceGitDiscoveryOptions,
} from "../../workspace-git";
import type { SecureFileAuthorityRegistry } from "../secure-file-authorities";
import type { WorkspaceRunController } from "../workspace-run-controller";
import { issueAuthorityForLiveOwner } from "../live-authority";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";
import { reconcileReviews } from "./review-support";
import {
  mapWithinSourceControlDeadline,
  SourceControlDeadline,
} from "./source-control-deadline";

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

function repositoryAuthorityBinding(
  projectId: string,
  conversationId: string | undefined,
  workspaceRoot: string,
  repositoryPath: string,
  metadataMarkerIdentity: string,
): readonly string[] {
  return [
    projectId,
    conversationId ?? "",
    workspaceRoot,
    repositoryPath,
    metadataMarkerIdentity,
  ];
}

function commitReviewAuthorityBinding(
  projectId: string,
  conversationId: string | undefined,
  workspaceRoot: string,
  repositoryPath: string,
  metadataMarkerIdentity: string,
  fingerprint: string,
): readonly string[] {
  return [
    projectId,
    conversationId ?? "",
    workspaceRoot,
    repositoryPath,
    metadataMarkerIdentity,
    fingerprint,
  ];
}

function sameCanonicalPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US")
      === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

async function sameFilesystemPath(left: string, right: string): Promise<boolean> {
  if (sameCanonicalPath(left, right)) return true;
  try {
    const [canonicalLeft, canonicalRight] = await Promise.all([
      realpath(left),
      realpath(right),
    ]);
    return sameCanonicalPath(canonicalLeft, canonicalRight);
  } catch {
    return false;
  }
}

export function createSourceControlCommandHandler(
  dependencies: SourceControlCommandDependencies,
): RuntimeCommandHandler {
  const resolveCommandRepository = async (socket: WebSocket, payload: {
    projectId: string;
    conversationId?: string;
    repositoryPath?: string;
    authorityRef?: string;
  }) => {
    const workspaceRoot = dependencies.workspacePath(
      payload.projectId,
      payload.conversationId,
    );
    if (!payload.repositoryPath) {
      return {
        workspaceRoot,
        repositoryRoot: workspaceRoot,
        secureRoot: null,
        metadataMarkerIdentity: null,
      };
    }
    if (!payload.authorityRef) {
      throw new RuntimeRequestError(
        "Refresh repository status before changing this nested repository.",
      );
    }
    const repository = await resolveWorkspaceGitRepositoryIdentity(
      workspaceRoot,
      payload.repositoryPath,
      dependencies.secureFiles,
    );
    const issuedRoot = await dependencies.secureFileAuthorities.resolve(
      socket,
      payload.authorityRef,
      "git-repository",
      repositoryAuthorityBinding(
        payload.projectId,
        payload.conversationId,
        workspaceRoot,
        payload.repositoryPath,
        repository.metadataMarkerIdentity,
      ),
    );
    // Windows may report the same directory through case or 8.3 aliases on
    // separate realpath calls. The broker's retained filesystem identity and
    // creation time are the authority; the freshly resolved path is still
    // independently contained and bound to the exact Git metadata marker.
    if (
      !repository.secureRoot
      || repository.secureRoot.identity.dev !== issuedRoot.identity.dev
      || repository.secureRoot.identity.ino !== issuedRoot.identity.ino
      || repository.secureRoot.birthtimeNs !== issuedRoot.birthtimeNs
    ) {
      throw new RuntimeRequestError(
        "This repository changed after its status was loaded. Refresh and try again.",
      );
    }
    return {
      workspaceRoot,
      repositoryRoot: issuedRoot.root,
      secureRoot: issuedRoot,
      metadataMarkerIdentity: repository.metadataMarkerIdentity,
    };
  };
  const verifyCommandRepository = async (
    secureRoot: Awaited<ReturnType<typeof resolveWorkspaceGitRepository>>["secureRoot"] | null,
    metadataMarkerIdentity: string | null,
    options: { deadlineAt?: number; signal?: AbortSignal } = {},
  ): Promise<void> => {
    if (!secureRoot || !metadataMarkerIdentity) return;
    await dependencies.secureFiles.verifyRoot(secureRoot, options.signal);
    if (
      !await sameFilesystemPath(
        await repositoryRoot(secureRoot.root, options),
        secureRoot.root,
      )
      || await repositoryMetadataMarkerIdentity(secureRoot.root, options)
        !== metadataMarkerIdentity
    ) {
      throw new RuntimeRequestError(
        "This repository changed after its status was loaded. Refresh and try again.",
      );
    }
  };
  const issueLiveAuthority = async (
    socket: WebSocket,
    purpose: Parameters<SecureFileAuthorityRegistry["issue"]>[1],
    binding: readonly string[],
    root: Parameters<SecureFileAuthorityRegistry["issue"]>[3],
    signal?: AbortSignal,
  ): Promise<string | null> => {
    return await issueAuthorityForLiveOwner(
      () => socket.readyState === WebSocket.OPEN,
      async () => await dependencies.secureFileAuthorities.issue(
        socket,
        purpose,
        binding,
        root,
        { signal },
      ),
      () => dependencies.secureFileAuthorities.clearOwner(socket),
    );
  };

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
    "git.pr.create",
  ], async (socket, command) => {
    switch (command.type) {
      case "git.refresh": {
        const deadlineAt = Date.now() + GIT_READ_OPERATION_TIMEOUT_MS;
        const deadline = new SourceControlDeadline(deadlineAt, "read");
        const path = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        let status: GitStatusSnapshot;
        try {
          const root = await deadline.run(
            async () => await repositoryRoot(path, { deadlineAt }),
          );
          const secureRoot = await deadline.run(
            async (signal) =>
              await dependencies.secureFiles.authorizeRoot(root, signal),
          );
          const metadataMarkerIdentity = await deadline.run(
            async () => await repositoryMetadataMarkerIdentity(root, {
              deadlineAt,
            }),
          );
          const inspected = await deadline.run(
            async () => await getRepositoryStatus(secureRoot.root, {
              deadlineAt,
            }),
          );
          const verifiedMetadataMarkerIdentity = await deadline.run(
            async () => await repositoryMetadataMarkerIdentity(root, {
              deadlineAt,
            }),
          );
          if (metadataMarkerIdentity !== verifiedMetadataMarkerIdentity) {
            throw new GitError(
              "conflict",
              "The Git repository identity changed while it was being inspected.",
            );
          }
          await deadline.run(
            async (signal) =>
              await dependencies.secureFiles.verifyRoot(secureRoot, signal),
          );
          const authorityRef =
            await deadline.run(
              async (signal) => await issueLiveAuthority(
                socket,
                "git-repository",
                repositoryAuthorityBinding(
                  command.payload.projectId,
                  command.payload.conversationId,
                  path,
                  ".",
                  metadataMarkerIdentity,
                ),
                secureRoot,
                signal,
              ),
            );
          if (!authorityRef) return "handled";
          status = gitStatusSnapshot(inspected, authorityRef);
        } catch (error) {
          if (
            !(error instanceof GitError && error.code === "not-repository")
          ) {
            throw error;
          }
          status = emptyGitStatusSnapshot();
        } finally {
          deadline.dispose();
        }
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "git.status", status },
        });
        return "handled";
      }
      case "git.diff": {
        const deadlineAt = Date.now() + GIT_READ_OPERATION_TIMEOUT_MS;
        const deadline = new SourceControlDeadline(deadlineAt, "read");
        const path = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        try {
          const metadataMarkerIdentity = await deadline.run(
            async () => await repositoryMetadataMarkerIdentity(path, {
              deadlineAt,
            }),
          );
          const secureRoot = await deadline.run(
            async (signal) =>
              await dependencies.secureFileAuthorities.resolve(
                socket,
                command.payload.authorityRef,
                "git-repository",
                repositoryAuthorityBinding(
                  command.payload.projectId,
                  command.payload.conversationId,
                  path,
                  ".",
                  metadataMarkerIdentity,
                ),
                { signal },
              ),
          );
          await deadline.run(
            async (signal) => await verifyCommandRepository(
              secureRoot,
              metadataMarkerIdentity,
              { deadlineAt, signal },
            ),
          );
          let commitReview: { authorityRef: string; fingerprint: string } | null = null;
          let diff;
          let status;
          if (command.payload.commitReview && !command.payload.path) {
            const before = await deadline.run(
              async () => await prepareGitCommitReview(
                secureRoot.root,
                { deadlineAt },
              ),
            );
            try {
              const text = await deadline.run(
                async () => await renderGitCommitReviewDiff(
                  secureRoot.root,
                  before,
                  { deadlineAt },
                ),
              );
              const after = await deadline.run(
                async () => await prepareGitCommitReview(
                  secureRoot.root,
                  { deadlineAt },
                ),
              );
              try {
                status = before.capture.status;
                diff = { text, truncated: false };
                if (
                  gitCommitReviewFingerprintsEqual(
                    before.capture.fingerprint,
                    after.capture.fingerprint,
                  )
                  && gitCommitReviewStatusMatches(before.capture, status)
                  && gitCommitReviewStatusMatches(after.capture, status)
                ) {
                  const authorityRef = await deadline.run(
                    async (signal) => await issueLiveAuthority(
                      socket,
                      "git-commit-review",
                      commitReviewAuthorityBinding(
                        command.payload.projectId,
                        command.payload.conversationId,
                        path,
                        ".",
                        metadataMarkerIdentity,
                        after.capture.fingerprint,
                      ),
                      secureRoot,
                      signal,
                    ),
                  );
                  if (!authorityRef) return "handled";
                  commitReview = {
                    authorityRef,
                    fingerprint: after.capture.fingerprint,
                  };
                }
              } finally {
                await after.selection.dispose().catch(() => undefined);
              }
            } finally {
              await before.selection.dispose().catch(() => undefined);
            }
          } else {
            [diff, status] = await deadline.run(
              async (signal) => await Promise.all([
                getUnifiedDiff(secureRoot.root, {
                  deadlineAt,
                  signal,
                  ...(command.payload.path
                    ? { paths: [command.payload.path] }
                    : {}),
                  ignoreWhitespace: command.payload.ignoreWhitespace,
                }, undefined, dependencies.secureFiles, secureRoot),
                getRepositoryStatus(secureRoot.root, { deadlineAt }),
              ]),
            );
          }
          await deadline.run(
            async (signal) => await verifyCommandRepository(
              secureRoot,
              metadataMarkerIdentity,
              { deadlineAt, signal },
            ),
          );
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
                commitReview,
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
        } finally {
          deadline.dispose();
        }
      }
      case "git.workspace.refresh": {
        const deadlineAt = Date.now() + WORKSPACE_GIT_DISCOVERY_TIMEOUT_MS;
        const deadline = new SourceControlDeadline(
          deadlineAt,
          "workspace-discovery",
        );
        const path = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        const maxRepositories = dependencies.store
          .project(command.payload.projectId).gitRepositoryLimit;
        const issuedAuthorityRefs: string[] = [];
        try {
          const discovered = await discoverFreshWorkspaceGitRepositories(
            path,
            {
              deadlineAt,
              maxRepositories,
              secureFiles: dependencies.secureFiles,
            },
          );
          deadline.requireTime();
          if (socket.readyState !== WebSocket.OPEN) return "handled";
          const repositories = await mapWithinSourceControlDeadline(
            discovered.snapshot.repositories,
            4,
            deadline,
            async (repository, signal) => {
              const authority = discovered.repositoryAuthorities.get(
                repository.repositoryPath,
              );
              if (!authority || repository.state !== "ready") {
                return { ...repository, authorityRef: null };
              }
              const authorityRef =
                await issueLiveAuthority(
                  socket,
                  "git-repository",
                  repositoryAuthorityBinding(
                    command.payload.projectId,
                    command.payload.conversationId,
                    path,
                    repository.repositoryPath,
                    authority.metadataMarkerIdentity,
                  ),
                  authority.secureRoot,
                  signal,
                );
              if (authorityRef) issuedAuthorityRefs.push(authorityRef);
              return { ...repository, authorityRef };
            },
          );
          const status = { ...discovered.snapshot, repositories };
          if (socket.readyState !== WebSocket.OPEN) {
            dependencies.secureFileAuthorities.clearOwner(socket);
            return "handled";
          }
          dependencies.send(socket, {
            type: "request.result",
            requestId: command.requestId,
            result: { kind: "git.workspace.status", status },
          });
          return "handled";
        } catch (error) {
          deadline.cancel();
          for (const reference of issuedAuthorityRefs) {
            dependencies.secureFileAuthorities.revoke(socket, reference);
          }
          throw error;
        } finally {
          deadline.dispose();
        }
      }
      case "git.workspace.diff": {
        const deadlineAt = Date.now() + GIT_READ_OPERATION_TIMEOUT_MS;
        const deadline = new SourceControlDeadline(deadlineAt, "read");
        const path = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        try {
          const repository = await deadline.run(
            async () => await resolveWorkspaceGitRepositoryIdentity(
              path,
              command.payload.repositoryPath,
            ),
          );
          const secureRoot = await deadline.run(
            async (signal) =>
              await dependencies.secureFileAuthorities.resolve(
                socket,
                command.payload.authorityRef,
                "git-repository",
                repositoryAuthorityBinding(
                  command.payload.projectId,
                  command.payload.conversationId,
                  path,
                  command.payload.repositoryPath,
                  repository.metadataMarkerIdentity,
                ),
                { signal },
              ),
          );
          await deadline.run(
            async (signal) => await verifyCommandRepository(
              secureRoot,
              repository.metadataMarkerIdentity,
              { deadlineAt, signal },
            ),
          );
          let commitReview: { authorityRef: string; fingerprint: string } | null = null;
          let diff;
          let repositoryStatus;
          if (command.payload.commitReview && !command.payload.path) {
            const before = await deadline.run(
              async () => await prepareGitCommitReview(
                secureRoot.root,
                { deadlineAt },
              ),
            );
            try {
              const text = await deadline.run(
                async () => await renderGitCommitReviewDiff(
                  secureRoot.root,
                  before,
                  { deadlineAt },
                ),
              );
              const after = await deadline.run(
                async () => await prepareGitCommitReview(
                  secureRoot.root,
                  { deadlineAt },
                ),
              );
              try {
                repositoryStatus = before.capture.status;
                diff = { text, truncated: false };
                if (
                  gitCommitReviewFingerprintsEqual(
                    before.capture.fingerprint,
                    after.capture.fingerprint,
                  )
                  && gitCommitReviewStatusMatches(
                    before.capture,
                    repositoryStatus,
                  )
                  && gitCommitReviewStatusMatches(
                    after.capture,
                    repositoryStatus,
                  )
                ) {
                  const authorityRef = await deadline.run(
                    async (signal) => await issueLiveAuthority(
                      socket,
                      "git-commit-review",
                      commitReviewAuthorityBinding(
                        command.payload.projectId,
                        command.payload.conversationId,
                        path,
                        command.payload.repositoryPath,
                        repository.metadataMarkerIdentity,
                        after.capture.fingerprint,
                      ),
                      secureRoot,
                      signal,
                    ),
                  );
                  if (!authorityRef) return "handled";
                  commitReview = {
                    authorityRef,
                    fingerprint: after.capture.fingerprint,
                  };
                }
              } finally {
                await after.selection.dispose().catch(() => undefined);
              }
            } finally {
              await before.selection.dispose().catch(() => undefined);
            }
          } else {
            [diff, repositoryStatus] = await deadline.run(
              async (signal) => await Promise.all([
                getUnifiedDiff(secureRoot.root, {
                  deadlineAt,
                  signal,
                  ...(command.payload.path
                    ? { paths: [command.payload.path] }
                    : {}),
                  ignoreWhitespace: command.payload.ignoreWhitespace,
                }, undefined, dependencies.secureFiles, secureRoot),
                getRepositoryStatus(secureRoot.root, { deadlineAt }),
              ]),
            );
          }
          await deadline.run(
            async (signal) => await verifyCommandRepository(
              secureRoot,
              repository.metadataMarkerIdentity,
              { deadlineAt, signal },
            ),
          );
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
                commitReview,
              },
            },
          });
          if (reviewMetadataChanged) {
            dependencies.broadcastSnapshot();
          }
          return "handled";
        } finally {
          deadline.dispose();
        }
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
        const deadlineAt = Date.now() + GIT_READ_OPERATION_TIMEOUT_MS;
        const deadline = new SourceControlDeadline(deadlineAt, "read");
        try {
          const diff = await deadline.run(
            async (signal) =>
              await dependencies.turnGitArtifacts.compare(
                earlier.id,
                later.id,
                command.payload.path,
                deadlineAt,
                signal,
              ),
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
        } finally {
          deadline.dispose();
        }
        return "handled";
      }
      case "git.branches": {
        const deadlineAt = Date.now() + GIT_READ_OPERATION_TIMEOUT_MS;
        const branches = await listBranches(
          dependencies.workspacePath(
            command.payload.projectId,
            command.payload.conversationId,
          ),
          { deadlineAt },
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
        const path = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        const result = await dependencies.workspaceRuns.trackSourceControl(
          "Create branch",
          command.payload.projectId,
          command.payload.conversationId,
          path,
          command.requestId,
          async () => await createBranch(
            path,
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
        const path = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        const result = await dependencies.workspaceRuns.trackSourceControl(
          "Switch branch",
          command.payload.projectId,
          command.payload.conversationId,
          path,
          command.requestId,
          async () => await switchBranch(
            path,
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
          dependencies.store.projectPath(command.payload.projectId),
          command.requestId,
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
      case "git.pull": {
        const repository = await resolveCommandRepository(socket, command.payload);
        await dependencies.workspaceRuns.trackSourceControl(
          "Pull changes",
          command.payload.projectId,
          command.payload.conversationId,
          repository.workspaceRoot,
          command.requestId,
          async () => {
            await verifyCommandRepository(
              repository.secureRoot,
              repository.metadataMarkerIdentity,
            );
            const result = await pullRepository(repository.repositoryRoot);
            await verifyCommandRepository(
              repository.secureRoot,
              repository.metadataMarkerIdentity,
            );
            return result;
          },
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
      }
      case "git.commit": {
        const repository = await resolveCommandRepository(socket, command.payload);
        const result = await dependencies.workspaceRuns.trackSourceControl(
          "Commit changes",
          command.payload.projectId,
          command.payload.conversationId,
          repository.workspaceRoot,
          command.requestId,
          async () => {
            await verifyCommandRepository(
              repository.secureRoot,
              repository.metadataMarkerIdentity,
            );
            const metadataMarkerIdentity = await repositoryMetadataMarkerIdentity(
              repository.repositoryRoot,
            );
            const reviewRoot = await dependencies.secureFileAuthorities.resolve(
              socket,
              command.payload.reviewReceipt.authorityRef,
              "git-commit-review",
              commitReviewAuthorityBinding(
                command.payload.projectId,
                command.payload.conversationId,
                repository.workspaceRoot,
                command.payload.repositoryPath ?? ".",
                metadataMarkerIdentity,
                command.payload.reviewReceipt.fingerprint,
              ),
              { consume: true },
            );
            if (
              !await sameFilesystemPath(
                reviewRoot.root,
                await realpath(repository.repositoryRoot),
              )
              || (
                repository.secureRoot
                && (
                  reviewRoot.identity.dev !== repository.secureRoot.identity.dev
                  || reviewRoot.identity.ino !== repository.secureRoot.identity.ino
                  || reviewRoot.birthtimeNs !== repository.secureRoot.birthtimeNs
                )
              )
            ) {
              throw new RuntimeRequestError(
                "This repository changed after its complete diff was reviewed. Refresh and try again.",
              );
            }
            const verifyReviewedRepository = async (
              signal?: AbortSignal,
            ): Promise<void> => {
              await dependencies.secureFiles.verifyRoot(reviewRoot, signal);
              if (
                !await sameFilesystemPath(
                  await repositoryRoot(reviewRoot.root, { signal }),
                  reviewRoot.root,
                )
                || await repositoryMetadataMarkerIdentity(reviewRoot.root, {
                  signal,
                })
                  !== metadataMarkerIdentity
              ) {
                throw new RuntimeRequestError(
                  "This repository changed after its complete diff was reviewed. Refresh and try again.",
                );
              }
            };
            const committed = await commitReviewedChanges(
              reviewRoot.root,
              command.payload.message,
              command.payload.paths ?? [],
              command.payload.reviewReceipt.fingerprint,
              {
                deadlineAt: Date.now() + GIT_READ_OPERATION_TIMEOUT_MS,
                verifyRepositoryIdentity: verifyReviewedRepository,
              },
            );
            try {
              await verifyCommandRepository(
                repository.secureRoot,
                repository.metadataMarkerIdentity,
              );
              await verifyReviewedRepository();
              return committed;
            } catch {
              return {
                ...committed,
                refreshWarning: committed.refreshWarning
                  ?? "The commit was created, but repository identity could not be refreshed yet.",
              };
            }
          },
        );
        let refreshWarning = result.refreshWarning;
        if (command.payload.conversationId) {
          try {
            const current = await getUnifiedDiff(
              repository.repositoryRoot,
              {},
              undefined,
              dependencies.secureFiles,
              repository.secureRoot ?? undefined,
            );
            if (!current.truncated) {
              reconcileReviews(
                dependencies.store,
                command.payload.conversationId,
                current.text,
                command.payload.repositoryPath ?? ".",
              );
            } else {
              refreshWarning ??=
                "The commit was created, but its review state could not be refreshed yet.";
            }
          } catch {
            refreshWarning ??=
              "The commit was created, but its review state could not be refreshed yet.";
          }
        }
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "git.action",
            message: refreshWarning
              ? `Committed ${result.commit.slice(0, 7)}. ${refreshWarning}`
              : `Committed ${result.commit.slice(0, 7)}.`,
          },
        });
        dependencies.broadcastSnapshot();
        return "handled";
      }
      case "git.push": {
        const repository = await resolveCommandRepository(socket, command.payload);
        await dependencies.workspaceRuns.trackSourceControl(
          "Push branch",
          command.payload.projectId,
          command.payload.conversationId,
          repository.workspaceRoot,
          command.requestId,
          async () => {
            await verifyCommandRepository(
              repository.secureRoot,
              repository.metadataMarkerIdentity,
            );
            const result = await pushCurrentBranch(repository.repositoryRoot);
            await verifyCommandRepository(
              repository.secureRoot,
              repository.metadataMarkerIdentity,
            );
            return result;
          },
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
      }
      case "git.pr.open": {
        const repository = await resolveCommandRepository(socket, command.payload);
        const url = await dependencies.workspaceRuns.trackSourceControl(
          "Prepare pull request",
          command.payload.projectId,
          command.payload.conversationId,
          repository.workspaceRoot,
          command.requestId,
          async () => {
            await verifyCommandRepository(
              repository.secureRoot,
              repository.metadataMarkerIdentity,
            );
            const result = await getPullRequestCreateUrl(repository.repositoryRoot);
            await verifyCommandRepository(
              repository.secureRoot,
              repository.metadataMarkerIdentity,
            );
            return result;
          },
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
      case "git.pr.create": {
        const repository = await resolveCommandRepository(socket, command.payload);
        const url = await dependencies.workspaceRuns.trackSourceControl(
          "Create pull request",
          command.payload.projectId,
          command.payload.conversationId,
          repository.workspaceRoot,
          command.requestId,
          async () => {
            await verifyCommandRepository(
              repository.secureRoot,
              repository.metadataMarkerIdentity,
            );
            const result = await createGitHubPullRequest(
              repository.repositoryRoot,
              command.payload,
            );
            await verifyCommandRepository(
              repository.secureRoot,
              repository.metadataMarkerIdentity,
            );
            return result;
          },
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

export async function discoverFreshWorkspaceGitRepositories(
  path: string,
  options: WorkspaceGitDiscoveryOptions,
  discover: typeof discoverWorkspaceGitRepositories =
    discoverWorkspaceGitRepositories,
) {
  const repositoryAuthorities = new Map<string, {
    secureRoot: Awaited<ReturnType<RuntimeSecureFileBroker["authorizeRoot"]>>;
    metadataMarkerIdentity: string;
  }>();
  const snapshot = await discover(path, {
    ...options,
    onRepositoryAuthorized: (
      repositoryPath,
      secureRoot,
      metadataMarkerIdentity,
    ) => {
      repositoryAuthorities.set(repositoryPath, {
        secureRoot,
        metadataMarkerIdentity,
      });
      options.onRepositoryAuthorized?.(
        repositoryPath,
        secureRoot,
        metadataMarkerIdentity,
      );
    },
  });
  return { snapshot, repositoryAuthorities };
}
