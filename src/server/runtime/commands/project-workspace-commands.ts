import WebSocket from "ws";

import type { ServerEvent } from "../../../shared/contracts";
import {
  hasNativeProviderTerminalSession,
  isProviderTerminalSessionId,
} from "../../../shared/provider-terminal-resume";
import { restoreCheckpoint } from "../../checkpoints";
import type { RuntimeStore } from "../../database";
import { inspectProjectIdentity } from "../../project-identity";
import { requireRuntimeDirectory } from "../../runtime-commands";
import { RuntimeRequestError } from "../../runtime-errors";
import type { TerminalManager } from "../../terminal";
import { PROVIDER_INFO, type ProviderManager } from "../../providers";
import type { ProviderTerminalResumeRegistry } from "../../provider/terminal-resume";
import type { RuntimeSecureFileBroker } from "../../secure-files";
import type { SecureFileAuthorityRegistry } from "../secure-file-authorities";
import {
  listWorkspaceEntries,
  readWorkspaceTextFile,
  searchWorkspaceEntries,
  writeWorkspaceTextFile,
} from "../../workspace";
import type { WorkspaceRunController } from "../workspace-run-controller";
import type { TurnController } from "../turns/turn-controller";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface ProjectWorkspaceCommandDependencies {
  store: RuntimeStore;
  workspaceRuns: WorkspaceRunController<WebSocket>;
  turns: TurnController;
  providers: ProviderManager;
  providerTerminalResumes: ProviderTerminalResumeRegistry;
  terminals: TerminalManager;
  secureFiles: RuntimeSecureFileBroker;
  secureFileAuthorities: SecureFileAuthorityRegistry;
  workspacePath(projectId: string, conversationId?: string): string;
  rememberDeletedConversation(conversationId: string): void;
  forgetRemoteTranscript(conversationId: string): void;
  broadcastSnapshot(): void;
  send(socket: WebSocket, event: ServerEvent): void;
}

export function createProjectWorkspaceCommandHandler(
  dependencies: ProjectWorkspaceCommandDependencies,
): RuntimeCommandHandler {
  return defineRuntimeCommandHandler([
    "project.create",
    "project.select",
    "project.remove",
    "project.update",
    "workspace.entries",
    "workspace.file.read",
    "workspace.file.write",
    "project.actions",
    "project.action.run",
    "checkpoint.revert",
    "terminal.create",
    "terminal.provider.resume",
    "terminal.input",
    "terminal.resize",
    "terminal.close",
  ], async (socket, command) => {
    switch (command.type) {
      case "project.create": {
        const path = requireRuntimeDirectory(command.payload.path);
        const identity = await inspectProjectIdentity(path);
        const project = dependencies.store.createProject(
          command.payload.name,
          path,
          identity,
        );
        dependencies.broadcastSnapshot();
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "project.created", projectId: project.id },
        });
        return "handled";
      }
      case "project.select":
        dependencies.store.selectProject(command.payload.projectId);
        return "mutation";
      case "project.remove":
        if (
          dependencies.store.hasActiveWorkspaceRunForProject(
            command.payload.projectId,
          )
        ) {
          throw new RuntimeRequestError(
            "Stop active work for this project before removing it.",
          );
        }
        try {
          dependencies.store.assertProjectDeletionAllowed(
            command.payload.projectId,
          );
        } catch (error) {
          if (
            error instanceof Error
            && error.message.includes("Cancel the active Duo launch")
          ) throw new RuntimeRequestError(error.message);
          throw error;
        }
        if (dependencies.store.shellSnapshot().conversations.some((conversation) => (
          conversation.projectId === command.payload.projectId
          && dependencies.providerTerminalResumes.isActive(conversation.id)
        ))) {
          throw new RuntimeRequestError(
            "End resumed provider terminals for this project before removing it.",
          );
        }
        const removedConversationIds = dependencies.store.shellSnapshot()
          .conversations
          .filter((conversation) => (
            conversation.projectId === command.payload.projectId
          ))
          .map(({ id }) => id);
        dependencies.store.removeProject(command.payload.projectId);
        for (const conversationId of removedConversationIds) {
          dependencies.rememberDeletedConversation(conversationId);
          dependencies.forgetRemoteTranscript(conversationId);
        }
        return "mutation";
      case "project.update": {
        const { projectId, ...update } = command.payload;
        dependencies.store.updateProject(projectId, update);
        return "mutation";
      }
      case "workspace.entries": {
        const path = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        const result = command.payload.query
          ? await searchWorkspaceEntries(path, command.payload.query)
          : await listWorkspaceEntries(path, command.payload.directory);
        const entries = result.entries
          .filter((entry) => (
            entry.kind === "file" || entry.kind === "directory"
          ))
          .map((entry) => ({
            path: entry.path,
            kind: entry.kind as "file" | "directory",
          }));
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "workspace.entries",
            directory: "directory" in result ? result.directory : "",
            entries,
            truncated: result.truncated,
          },
        });
        return "handled";
      }
      case "workspace.file.read": {
        const workspacePath = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        const secureRoot = await dependencies.secureFiles.authorizeRoot(
          workspacePath,
        );
        const file = await readWorkspaceTextFile(
          workspacePath,
          command.payload.path,
          {
            secureFiles: dependencies.secureFiles,
            secureRoot,
          },
        );
        const authorityRef = await dependencies.secureFileAuthorities.issue(
          socket,
          "workspace-save",
          [
            command.payload.projectId,
            command.payload.conversationId ?? "",
            workspacePath,
            file.path,
            file.contentDigest,
          ],
          secureRoot,
        );
        const extension = file.path.split(".").pop()?.toLowerCase() ?? "text";
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "workspace.file",
            file: {
              path: file.path,
              content: file.content,
              truncated: false,
              language: extension,
              contentDigest: file.contentDigest,
              modifiedAt: file.modifiedAt,
              authorityRef,
            },
          },
        });
        return "handled";
      }
      case "workspace.file.write": {
        const workspacePath = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        const secureRoot = await dependencies.secureFileAuthorities.resolve(
          socket,
          command.payload.authorityRef,
          "workspace-save",
          [
            command.payload.projectId,
            command.payload.conversationId ?? "",
            workspacePath,
            command.payload.path,
            command.payload.expectedDigest,
          ],
          { consume: true },
        );
        const file = await writeWorkspaceTextFile(
          workspacePath,
          command.payload.path,
          command.payload.content,
          command.payload.expectedDigest,
          {
            secureFiles: dependencies.secureFiles,
            secureRoot,
          },
        );
        const authorityRef = await dependencies.secureFileAuthorities.issue(
          socket,
          "workspace-save",
          [
            command.payload.projectId,
            command.payload.conversationId ?? "",
            workspacePath,
            file.path,
            file.contentDigest,
          ],
          secureRoot,
        );
        const extension = file.path.split(".").pop()?.toLowerCase() ?? "text";
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: {
            kind: "workspace.file",
            file: {
              path: file.path,
              content: file.content,
              truncated: false,
              language: extension,
              contentDigest: file.contentDigest,
              modifiedAt: file.modifiedAt,
              authorityRef,
            },
          },
        });
        return "handled";
      }
      case "project.actions": {
        const actions = await dependencies.workspaceRuns.listActions(
          dependencies.workspacePath(
            command.payload.projectId,
            command.payload.conversationId,
          ),
        );
        dependencies.send(socket, {
          type: "request.result",
          requestId: command.requestId,
          result: { kind: "project.actions", actions },
        });
        return "handled";
      }
      case "project.action.run": {
        const cwd = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        await dependencies.workspaceRuns.startAction({
          owner: socket,
          cwd,
          projectId: command.payload.projectId,
          conversationId: command.payload.conversationId,
          actionId: command.payload.actionId,
          cols: command.payload.cols,
          rows: command.payload.rows,
          onStarted: (terminalId) => {
            dependencies.send(socket, {
              type: "terminal.created",
              requestId: command.requestId,
              terminalId,
            });
          },
        });
        return "handled";
      }
      case "checkpoint.revert": {
        const checkpoint = dependencies.store.checkpoint(
          command.payload.checkpointId,
        );
        if (checkpoint.conversationId !== command.payload.conversationId) {
          throw new RuntimeRequestError(
            "The checkpoint does not belong to this thread.",
          );
        }
        if (
          dependencies.store.hasActiveWorkspaceRunForConversation(
            command.payload.conversationId,
          )
          || !dependencies.providerTerminalResumes.acquire(
            command.payload.conversationId,
          )
        ) {
          throw new RuntimeRequestError(
            "Stop active work, reviews, or resumed terminals before restoring a checkpoint.",
          );
        }
        try {
          await restoreCheckpoint(
            dependencies.store.conversationPath(checkpoint.conversationId),
            checkpoint.ref,
            checkpoint.conversationId,
          );
          dependencies.send(socket, {
            type: "request.ok",
            requestId: command.requestId,
          });
          dependencies.broadcastSnapshot();
          return "handled";
        } finally {
          dependencies.providerTerminalResumes.release(
            command.payload.conversationId,
          );
        }
      }
      case "terminal.create": {
        const cwd = dependencies.workspacePath(
          command.payload.projectId,
          command.payload.conversationId,
        );
        const terminalId = dependencies.terminals.create(
          socket,
          cwd,
          command.payload.cols,
          command.payload.rows,
        );
        dependencies.send(socket, {
          type: "terminal.created",
          requestId: command.requestId,
          terminalId,
        });
        return "handled";
      }
      case "terminal.provider.resume": {
        const conversation = dependencies.store.conversation(
          command.payload.conversationId,
        );
        if (conversation.projectId !== command.payload.projectId) {
          throw new RuntimeRequestError(
            "The conversation does not belong to this project.",
          );
        }
        if (!conversation.providerSessionId) {
          throw new RuntimeRequestError(
            "No resumable provider CLI session is stored for this chat. It may be new or the saved session may be stale.",
          );
        }
        if (!isProviderTerminalSessionId(conversation.providerSessionId)) {
          throw new RuntimeRequestError(
            "The saved provider session identifier is invalid or stale.",
          );
        }
        if (!hasNativeProviderTerminalSession(conversation)) {
          throw new RuntimeRequestError(
            "This chat does not use the provider's native CLI session store, so Inertia cannot resume it truthfully in a terminal.",
          );
        }
        const cwd = dependencies.workspacePath(
          command.payload.projectId,
          conversation.id,
        );
        if (
          dependencies.providers.isRunning(conversation.id)
          || dependencies.turns.isActive(conversation.id)
          || dependencies.turns.hasActiveCheckout(cwd)
          || dependencies.store.hasActiveWorkspaceRunForConversation(conversation.id)
          || dependencies.providerTerminalResumes.isActive(conversation.id)
        ) {
          throw new RuntimeRequestError(
            "Stop the active provider session for this chat before resuming it in another terminal.",
          );
        }
        if (!dependencies.providerTerminalResumes.acquire(conversation.id)) {
          throw new RuntimeRequestError(
            "Stop the active provider session for this chat before resuming it in another terminal.",
          );
        }
        try {
          const launch = await dependencies.providers.terminalResumeLaunch(
            conversation.providerId,
            conversation.providerSessionId,
            cwd,
          );
          if (
            socket.readyState !== WebSocket.OPEN
            || dependencies.providers.isRunning(conversation.id)
            || dependencies.turns.isActive(conversation.id)
            || dependencies.turns.hasActiveCheckout(cwd)
            || dependencies.store.hasRecordedActiveWorkspaceRunForConversation(conversation.id)
          ) {
            throw new RuntimeRequestError(
              socket.readyState !== WebSocket.OPEN
                ? "The terminal connection closed before the provider session could start."
                : "Stop the active provider session for this chat before resuming it in another terminal.",
            );
          }
          const terminalId = await dependencies.terminals.replaceProcess(
            socket,
            command.payload.terminalId,
            cwd,
            launch.executable,
            launch.args,
            launch.env,
            command.payload.cols,
            command.payload.rows,
            () => dependencies.providerTerminalResumes.release(conversation.id),
          );
          dependencies.send(socket, {
            type: "terminal.created",
            requestId: command.requestId,
            terminalId,
            providerResume: {
              providerId: conversation.providerId,
              providerLabel: PROVIDER_INFO[conversation.providerId].name,
              sessionId: conversation.providerSessionId,
            },
          });
        } catch (error) {
          dependencies.providerTerminalResumes.release(conversation.id);
          throw error;
        }
        return "handled";
      }
      case "terminal.input":
        dependencies.terminals.input(
          socket,
          command.payload.terminalId,
          command.payload.data,
        );
        dependencies.send(socket, {
          type: "request.ok",
          requestId: command.requestId,
        });
        return "handled";
      case "terminal.resize":
        dependencies.terminals.resize(
          socket,
          command.payload.terminalId,
          command.payload.cols,
          command.payload.rows,
        );
        dependencies.send(socket, {
          type: "request.ok",
          requestId: command.requestId,
        });
        return "handled";
      case "terminal.close":
        dependencies.terminals.close(socket, command.payload.terminalId);
        dependencies.send(socket, {
          type: "request.ok",
          requestId: command.requestId,
        });
        return "handled";
      default:
        return "not-handled";
    }
  });
}
