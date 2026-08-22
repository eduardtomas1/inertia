import type { WorkspaceFileLocation } from "../../utils/workspaceFileReference";

interface WorkspaceEntryActions {
  inspectDirectory: (path: string) => Promise<unknown>;
  openDirectory: (path: string) => Promise<unknown>;
  openFile: (
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
    headingId?: string,
  ) => void;
  isCurrent?: () => boolean;
}

export async function openWorkspaceEntry(
  path: string,
  actions: WorkspaceEntryActions,
  location?: WorkspaceFileLocation,
  literalPath?: boolean,
  headingId?: string,
): Promise<"directory" | "file" | "stale"> {
  const isCurrent = actions.isCurrent ?? (() => true);
  if (!isCurrent()) return "stale";
  try {
    await actions.inspectDirectory(path);
  } catch {
    if (!isCurrent()) return "stale";
    if (headingId) actions.openFile(path, location, literalPath, headingId);
    else actions.openFile(path, location, literalPath);
    return "file";
  }
  if (!isCurrent()) return "stale";
  await actions.openDirectory(path);
  return "directory";
}

type OpenWorkspaceFileOptions = readonly [
  path: string,
  location: WorkspaceFileLocation | undefined,
  literalPath: boolean | undefined,
  headingId: string | undefined,
  authorityRef: { current: string; open?: number },
  authority: string,
  inspectDirectory: (options: { directory: string }) => Promise<unknown>,
  projectId: string,
  conversationId: string | undefined,
  openFile: (
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
    headingId?: string,
  ) => void,
  setActiveTool: (tool: "files") => void,
];

export async function openWorkspaceFile([
  path,
  location,
  literalPath,
  headingId,
  authorityRef,
  authority,
  inspectDirectory,
  projectId,
  conversationId,
  openFile,
  setActiveTool,
]: OpenWorkspaceFileOptions): Promise<void> {
  const open = (authorityRef.open ?? 0) + 1;
  authorityRef.open = open;
  await openWorkspaceEntry(path, {
    isCurrent: () => (
      authorityRef.current === authority && authorityRef.open === open
    ),
    inspectDirectory: async (directory) =>
      await inspectDirectory({ directory }),
    openDirectory: async (directory) =>
      await window.inertia.openProjectPath({
        projectId,
        ...(conversationId ? { conversationId } : {}),
        relativePath: directory,
        action: "reveal",
      }),
    openFile: (file, fileLocation, exactPath, fileHeadingId) => {
      openFile(file, fileLocation, exactPath, fileHeadingId);
      setActiveTool("files");
    },
  }, location, literalPath, headingId);
}
