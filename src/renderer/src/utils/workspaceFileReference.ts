const MAX_SOURCE_LOCATION_VALUE = 999_999_999;
const sourceLocationSuffix = /:([1-9]\d{0,8})(?::([1-9]\d{0,8}))?$/u;
const sourceLocationFragment = /#L([1-9]\d{0,8})(?:C([1-9]\d{0,8}))?(?:-L?([1-9]\d{0,8})(?:C([1-9]\d{0,8}))?)?$/iu;

export interface WorkspaceSourceLocation {
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
}

export interface WorkspaceFileReference {
  path: string;
  location: WorkspaceSourceLocation | null;
  suffix: string;
}

function sourceNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed)
    && parsed > 0
    && parsed <= MAX_SOURCE_LOCATION_VALUE
    ? parsed
    : undefined;
}

export function parseWorkspaceFileReference(
  reference: string,
): WorkspaceFileReference {
  const fragment = sourceLocationFragment.exec(reference);
  if (fragment) {
    const startLine = sourceNumber(fragment[1])!;
    const startColumn = sourceNumber(fragment[2]);
    const endLine = sourceNumber(fragment[3]) ?? startLine;
    const endColumn = sourceNumber(fragment[4]);
    if (
      endLine > startLine
      || (endLine === startLine && (!endColumn || !startColumn || endColumn >= startColumn))
    ) {
      return {
        path: reference.slice(0, fragment.index),
        location: {
          startLine,
          endLine,
          ...(startColumn ? { startColumn } : {}),
          ...(endColumn ? { endColumn } : {}),
        },
        suffix: fragment[0],
      };
    }
  }
  const suffix = sourceLocationSuffix.exec(reference);
  if (!suffix) return { path: reference, location: null, suffix: "" };
  const startLine = sourceNumber(suffix[1])!;
  const startColumn = sourceNumber(suffix[2]);
  return {
    path: reference.slice(0, suffix.index),
    location: {
      startLine,
      endLine: startLine,
      ...(startColumn ? { startColumn } : {}),
    },
    suffix: suffix[0],
  };
}

export function validatedWorkspaceSourceLocation(
  location: WorkspaceSourceLocation | null,
  content: string,
): WorkspaceSourceLocation | null {
  if (!location) return null;
  const lines = content.split("\n");
  const lineCount = lines.length;
  if (
    location.startLine > lineCount
    || location.endLine > lineCount
    || location.endLine < location.startLine
  ) return null;
  const startLength = lines[location.startLine - 1]?.length ?? 0;
  const endLength = lines[location.endLine - 1]?.length ?? 0;
  if (
    (location.startColumn && location.startColumn > startLength + 1)
    || (location.endColumn && location.endColumn > endLength + 1)
  ) return null;
  return location;
}

export function workspaceFileReferenceFallback(
  path: string,
): string | null {
  const reference = parseWorkspaceFileReference(path);
  return reference.path && reference.path !== path ? reference.path : null;
}
