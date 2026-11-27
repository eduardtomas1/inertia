import type { Dispatch, SetStateAction } from "react";
import type {
  ServerEvent,
  WorkspaceFilePreview,
} from "@shared/contracts";
import {
  classifyWorkspaceMediaPath,
  isBinaryWorkspaceMediaPath,
} from "@shared/workspace-media-preview";
import {
  resultEvent,
  type CommandWithoutId,
} from "../../lib/runtimeCommands";
import {
  validatedWorkspaceFileLocation,
  workspaceFileReference,
  type WorkspaceFileLocation,
} from "../../utils/workspaceFileReference";
import {
  workspaceFileWriteCommand,
  type WorkspaceFileWriteIdentity,
} from "../../utils/workspaceFileWrite";
import type { MarkdownHeadingRequest } from "../../utils/markdownHeading";
import { readWorkspaceFileSelection } from "./readWorkspaceFileSelection";

type SelectWorkspaceFileOptions = readonly [
  path: string,
  requestedLocation: WorkspaceFileLocation | undefined,
  literalPath: boolean,
  headingId: string | undefined,
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
  setSelectedMarkdownHeading: Dispatch<
    SetStateAction<MarkdownHeadingRequest | null>
  >,
  setFilePreview: Dispatch<SetStateAction<WorkspaceFilePreview | null>>,
  setFilePreviewError: Dispatch<SetStateAction<string | null>>,
  setFilePreviewLoading: Dispatch<SetStateAction<boolean>>,
  setActionError: (message: string | null) => void,
  loadDualViewSource?: boolean,
];

export async function selectWorkspaceFile([
  path,
  requestedLocation,
  literalPath,
  headingId,
  request,
  projectId,
  conversationId,
  authorityRef,
  authority,
  generationRef,
  setSelectedFile,
  setSelectedFileLocation,
  setSelectedMarkdownHeading,
  setFilePreview,
  setFilePreviewError,
  setFilePreviewLoading,
  setActionError,
  loadDualViewSource = false,
]: SelectWorkspaceFileOptions): Promise<void> {
  if (authorityRef.current !== authority) return;
  const generation = ++generationRef.current;
  setSelectedFile(path);
  setSelectedFileLocation(null);
  setSelectedMarkdownHeading(headingId
    ? { path, headingId, requestId: generation }
    : null);
  setFilePreview(null);
  setFilePreviewError(null);
  const mediaDescriptor = classifyWorkspaceMediaPath(path);
  const hasExplicitLocation = requestedLocation !== undefined
    || (!literalPath && workspaceFileReference(path)?.location !== undefined);
  if (
    isBinaryWorkspaceMediaPath(path)
    || (mediaDescriptor?.isTextDualView && !hasExplicitLocation && !loadDualViewSource)
  ) {
    setFilePreviewLoading(false);
    setActionError(null);
    return;
  }
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
      if (headingId) {
        setSelectedMarkdownHeading({
          path: file.path,
          headingId,
          requestId: generation,
        });
      }
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
    if (!mediaDescriptor?.isTextDualView) {
      setActionError(message);
    }
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
