import type { Dispatch, SetStateAction } from "react";
import type {
  ServerEvent,
  WorkspaceFilePreview,
} from "@shared/contracts";
import {
  resultEvent,
  type CommandWithoutId,
} from "../../lib/runtimeCommands";
import type { WorkspaceFileLocation } from "../../utils/workspaceFileReference";
import { validatedWorkspaceFileLocation } from "../../utils/workspaceFileReference";
import {
  workspaceFileWriteCommand,
  type WorkspaceFileWriteIdentity,
} from "../../utils/workspaceFileWrite";
import { readWorkspaceFileSelection } from "./readWorkspaceFileSelection";

type SelectWorkspaceFileOptions = readonly [
  path: string,
  requestedLocation: WorkspaceFileLocation | undefined,
  literalPath: boolean,
  request: (command: CommandWithoutId) => Promise<ServerEvent>,
  projectId: string,
  conversationId: string | undefined,
  authorityRef: { current: string },
  authority: string,
  generationRef: { current: number },
  setSelectedFile: Dispatch<SetStateAction<string | null>>,
  setSelectedFileLocation: Dispatch<
    SetStateAction<WorkspaceFileLocation | null>
  >,
  setFilePreview: Dispatch<SetStateAction<WorkspaceFilePreview | null>>,
  setFilePreviewError: Dispatch<SetStateAction<string | null>>,
  setFilePreviewLoading: Dispatch<SetStateAction<boolean>>,
  setActionError: (message: string | null) => void,
];

export async function selectWorkspaceFile([
  path,
  requestedLocation,
  literalPath,
  request,
  projectId,
  conversationId,
  authorityRef,
  authority,
  generationRef,
  setSelectedFile,
  setSelectedFileLocation,
  setFilePreview,
  setFilePreviewError,
  setFilePreviewLoading,
  setActionError,
]: SelectWorkspaceFileOptions): Promise<void> {
  if (authorityRef.current !== authority) return;
  const generation = ++generationRef.current;
  setSelectedFile(path);
  setSelectedFileLocation(null);
  setFilePreview(null);
  setFilePreviewError(null);
  setFilePreviewLoading(true);
  try {
    const { file, location } = await readWorkspaceFileSelection({
      request,
      projectId,
      conversationId,
      path,
      requestedLocation,
      literalPath,
    });
    if (
      generationRef.current === generation
      && authorityRef.current === authority
    ) {
      setSelectedFile(file.path);
      setSelectedFileLocation(location);
      setFilePreview(file);
    }
  } catch (error) {
    if (
      generationRef.current !== generation
      || authorityRef.current !== authority
    ) return;
    const message = error instanceof Error
      ? error.message
      : "The file could not be opened.";
    setFilePreviewError(message);
    setActionError(message);
  } finally {
    if (
      generationRef.current === generation
      && authorityRef.current === authority
    ) {
      setFilePreviewLoading(false);
    }
  }
}

export async function saveWorkspaceFile(
  request: (command: CommandWithoutId) => Promise<ServerEvent>,
  identity: WorkspaceFileWriteIdentity,
  content: string,
  location: WorkspaceFileLocation | null,
): Promise<{
  file: WorkspaceFilePreview;
  location: WorkspaceFileLocation | null;
}> {
  const event = resultEvent(await request(
    workspaceFileWriteCommand(identity, content),
  ));
  if (event.result.kind !== "workspace.file") {
    throw new Error("The local service returned an unexpected file response.");
  }
  return {
    file: event.result.file,
    location: validatedWorkspaceFileLocation(
      location,
      event.result.file.content,
    ),
  };
}
