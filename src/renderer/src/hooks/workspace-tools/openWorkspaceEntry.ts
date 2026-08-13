import type { WorkspaceFileLocation } from "../../utils/workspaceFileReference";

interface WorkspaceEntryActions {
  inspectDirectory: (path: string) => Promise<unknown>;
  openDirectory: (path: string) => Promise<unknown>;
  openFile: (
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
  ) => void;
  isCurrent?: () => boolean;
}

export async function openWorkspaceEntry(
  path: string,
  actions: WorkspaceEntryActions,
  location?: WorkspaceFileLocation,
  literalPath?: boolean,
): Promise<"directory" | "file" | "stale"> {
  const isCurrent = actions.isCurrent ?? (() => true);
  if (!isCurrent()) return "stale";
  try {
    await actions.inspectDirectory(path);
  } catch {
    if (!isCurrent()) return "stale";
    actions.openFile(path, location, literalPath);
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
  authorityRef: { current: string },
  authority: string,
  inspectDirectory: (options: { directory: string }) => Promise<unknown>,
  projectId: string,
  conversationId: string | undefined,
  openFile: (
    path: string,
    location?: WorkspaceFileLocation,
    literalPath?: boolean,
  ) => void,
  setActiveTool: (tool: "files") => void,
];

export async function openWorkspaceFile([
  path,
  location,
  literalPath,
  authorityRef,
  authority,
  inspectDirectory,
  projectId,
  conversationId,
  openFile,
  setActiveTool,
]: OpenWorkspaceFileOptions): Promise<void> {
  await openWorkspaceEntry(path, {
    isCurrent: () => authorityRef.current === authority,
    inspectDirectory: async (directory) =>
      await inspectDirectory({ directory }),
    openDirectory: async (directory) =>
      await window.inertia.openProjectPath({
        projectId,
        ...(conversationId ? { conversationId } : {}),
        relativePath: directory,
        action: "reveal",
      }),
    openFile: (file, fileLocation, exactPath) => {
      openFile(file, fileLocation, exactPath);
      setActiveTool("files");
    },
  }, location, literalPath);
}
