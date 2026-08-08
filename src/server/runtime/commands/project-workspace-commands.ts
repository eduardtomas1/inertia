import type WebSocket from "ws";

import type { ServerEvent } from "../../../shared/contracts";
import { restoreCheckpoint } from "../../checkpoints";
import type { RuntimeStore } from "../../database";
import { inspectProjectIdentity } from "../../project-identity";
import { requireRuntimeDirectory } from "../../runtime-commands";
import { RuntimeRequestError } from "../../runtime-errors";
import type { TerminalManager } from "../../terminal";
import type { RuntimeSecureFileBroker } from "../../secure-files";
import type { SecureFileAuthorityRegistry } from "../secure-file-authorities";
import {
  listWorkspaceEntries,
  readWorkspaceTextFile,
  searchWorkspaceEntries,
  writeWorkspaceTextFile,
} from "../../workspace";
import type { WorkspaceRunController } from "../workspace-run-controller";
import {
  defineRuntimeCommandHandler,
  type RuntimeCommandHandler,
} from "./command-router";

export interface ProjectWorkspaceCommandDependencies {
  store: RuntimeStore;
  workspaceRuns: WorkspaceRunController<WebSocket>;
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
        ) {
          throw new RuntimeRequestError(
            "Stop the active run or review before restoring a checkpoint.",
          );
        }
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
