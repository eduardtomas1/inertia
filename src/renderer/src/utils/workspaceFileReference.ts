const sourceLocationSuffix = /:([1-9]\d{0,8})(?::([1-9]\d{0,8}))?(?:-([1-9]\d{0,8})(?::([1-9]\d{0,8}))?)?$/u;
const sourceLocationFragment = /^#L([1-9]\d{0,8})(?:C([1-9]\d{0,8}))?(?:-L?([1-9]\d{0,8})(?:C([1-9]\d{0,8}))?)?$/iu;

const workspaceFileSearchEdits = new Map<string, [number, string, number]>();

function workspaceFileSearchEdit(
  projectId: string,
  conversationId?: string,
): [number, string, number] {
  const key = `${projectId}\0${conversationId ?? ""}`;
  let state = workspaceFileSearchEdits.get(key);
  if (!state) {
    state = [0, "", 0];
    workspaceFileSearchEdits.set(key, state);
  }
  return state;
}

export function markWorkspaceFileSearchEdit(
  projectId: string,
  conversationId?: string,
): void {
  workspaceFileSearchEdit(projectId, conversationId)[0] += 1;
}

export function beginWorkspaceFileOpen(
  projectId: string,
  conversationId: string | undefined,
  path: string,
): void {
  const state = workspaceFileSearchEdit(projectId, conversationId);
  state[1] = path;
  state[2] = state[0];
}

export function consumeWorkspaceFileOpenEdit(
  projectId: string,
  conversationId: string | undefined,
  path: string | null,
): boolean {
  const state = workspaceFileSearchEdit(projectId, conversationId);
  if (state[1] !== path) return false;
  state[1] = "";
  return state[0] !== state[2];
}

export interface WorkspaceFileLocation {
  startLine: number;
  startColumn?: number;
  endLine: number;
  endColumn?: number;
}

export interface WorkspaceFileReference {
  path: string;
  location: WorkspaceFileLocation;
}

function locationFromMatch(
  match: RegExpExecArray,
): WorkspaceFileLocation | null {
  const startLine = Number(match[1]);
  const startColumn = match[2] ? Number(match[2]) : undefined;
  const endLine = match[3] ? Number(match[3]) : startLine;
  const endColumn = match[4] ? Number(match[4]) : undefined;
  if (
    !Number.isSafeInteger(startLine)
    || !Number.isSafeInteger(endLine)
    || endLine < startLine
  ) return null;
  if (
    endLine === startLine
    && startColumn !== undefined
    && endColumn !== undefined
    && endColumn < startColumn
  ) return null;
  return {
    startLine,
    ...(startColumn === undefined ? {} : { startColumn }),
    endLine,
    ...(endColumn === undefined ? {} : { endColumn }),
  };
}

export function workspaceFileReference(
  value: string,
): WorkspaceFileReference | null {
  const match = sourceLocationSuffix.exec(value);
  const location = match ? locationFromMatch(match) : null;
  const path = match ? value.slice(0, match.index) : "";
  return path && location ? { path, location } : null;
}

export function workspaceFileLocationFromFragment(
  fragment: string,
): WorkspaceFileLocation | null {
  const match = sourceLocationFragment.exec(fragment);
  return match ? locationFromMatch(match) : null;
}

export function validatedWorkspaceFileLocation(
  location: WorkspaceFileLocation | null | undefined,
  content: string,
): WorkspaceFileLocation | null {
  if (!location) return null;
  const lineCount = content.split("\n").length;
  if (location.startLine > lineCount || location.endLine > lineCount) {
    return null;
  }
  const lines = content.split("\n");
  const columnExists = (line: number, column: number | undefined): boolean => (
    column === undefined
    || column <= (lines[line - 1]?.replace(/\r$/u, "").length ?? 0) + 1
  );
  if (
    !columnExists(location.startLine, location.startColumn)
    || !columnExists(location.endLine, location.endColumn)
  ) return null;
  return location;
}

export function workspaceFileLocationLabel(
  location: WorkspaceFileLocation,
): string {
  const range = location.startLine === location.endLine
    ? `Line ${location.startLine}`
    : `Lines ${location.startLine}–${location.endLine}`;
  if (location.startColumn === undefined) return range;
  return location.startLine === location.endLine
    ? `${range}, column ${location.startColumn}`
    : range;
}

export function workspaceFileReferenceFallback(
  path: string,
): string | null {
  return workspaceFileReference(path)?.path ?? null;
}
