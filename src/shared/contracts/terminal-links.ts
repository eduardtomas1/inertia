/**
 * Terminal file-path links. The renderer only proposes a token it saw in
 * terminal output; the runtime parses it, enforces realpath containment in the
 * chat's workspace and answers with a project-relative file or nothing.
 */

/** Longest terminal token, including any `:line:column` suffix, sent to the runtime. */
export const MAX_TERMINAL_PATH_TEXT_LENGTH = 1_024;
/** Line and column numbers above this are treated as noise rather than locations. */
export const MAX_TERMINAL_PATH_LOCATION = 999_999_999;

export interface TerminalPathResolution {
  /** Canonical, slash-separated path relative to the workspace root. */
  projectPath: string;
  line: number | null;
  column: number | null;
}

export interface TerminalPathResolveResult {
  kind: "workspace.path";
  resolution: TerminalPathResolution | null;
}

function location(value: unknown): boolean {
  return value === null || (
    typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_TERMINAL_PATH_LOCATION
  );
}

function portableProjectPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4_096
    && !/[\0\r\n\\]/u.test(value)
    && !value.startsWith("/")
    && !/^[A-Za-z]:/u.test(value)
    && value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function isTerminalPathResolution(value: unknown): value is TerminalPathResolution {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 3
    && portableProjectPath(candidate.projectPath)
    && location(candidate.line)
    && location(candidate.column)
    && (candidate.column === null || candidate.line !== null);
}

export function isTerminalPathResolveResult(value: Record<string, unknown>): boolean {
  return value.resolution === null || isTerminalPathResolution(value.resolution);
}
