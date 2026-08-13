import type {
  ServerEvent,
  WorkspaceFilePreview,
} from "@shared/contracts";
import {
  resultEvent,
  type CommandWithoutId,
} from "../../lib/runtimeCommands";
import {
  validatedWorkspaceFileLocation,
  workspaceFileReference,
  type WorkspaceFileLocation,
} from "../../utils/workspaceFileReference";

interface ReadWorkspaceFileSelectionOptions {
  request: (command: CommandWithoutId) => Promise<ServerEvent>;
  projectId: string;
  conversationId?: string;
  path: string;
  requestedLocation?: WorkspaceFileLocation;
  literalPath: boolean;
}

interface WorkspaceFileSelection {
  file: WorkspaceFilePreview;
  location: WorkspaceFileLocation | null;
}

export async function readWorkspaceFileSelection({
  request,
  projectId,
  conversationId,
  path,
  requestedLocation,
  literalPath,
}: ReadWorkspaceFileSelectionOptions): Promise<WorkspaceFileSelection> {
  const fallback = requestedLocation || literalPath
    ? null
    : workspaceFileReference(path);
  const event = resultEvent(await request({
    type: "workspace.file.read",
    payload: {
      projectId,
      conversationId,
      path,
      ...(fallback ? { fallbackPath: fallback.path } : {}),
    },
  }));
  if (event.result.kind !== "workspace.file") {
    throw new Error("Unexpected file response.");
  }
  const location = requestedLocation
    ?? (event.result.usedFallback && fallback ? fallback.location : null);
  return {
    file: event.result.file,
    location: validatedWorkspaceFileLocation(
      location,
      event.result.file.content,
    ),
  };
}
